import * as fs from "node:fs/promises";
import * as net from "node:net";
import { isEnoent, ptree } from "@oh-my-pi/pi-utils";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import type { DapClientState, DapResolvedAdapter } from "./types";

export interface DapSpawnOptions {
	adapter: DapResolvedAdapter;
	cwd: string;
	/**
	 * Cap on how long socket-mode helpers wait for the adapter to open its
	 * socket (unix) or dial back into our listener (TCP). Exposed for tests;
	 * production callers rely on the default.
	 *
	 * @internal
	 */
	socketReadyTimeoutMs?: number;
}

export interface DapConnectOptions extends DapSpawnOptions {
	host: string;
	port: number;
}

/** Minimal write interface shared by Bun.FileSink and Bun TCP sockets. */
export interface DapWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | undefined | Promise<number | undefined>;
}

export interface DapTransportHandle {
	proc: DapClientState["proc"];
	readable?: ReadableStream<Uint8Array>;
	writeSink?: DapWriteSink;
	socket?: { end(): void };
	port?: number;
	transportClosed?: Promise<void>;
}

const SOCKET_READY_TIMEOUT_MS = 10_000;

interface SocketTransport {
	readable: ReadableStream<Uint8Array>;
	writeSink: DapWriteSink;
	socket: { end(): void };
}

function adapterEnv(): Record<string, string | undefined> {
	return {
		...Bun.env,
		...NON_INTERACTIVE_ENV,
	};
}

export async function spawnDapTransport(options: DapSpawnOptions): Promise<DapTransportHandle> {
	const { adapter, cwd } = options;
	if (adapter.connectMode === "socket") {
		return spawnSocketTransport(options);
	}
	if (adapter.connectMode === "tcp") {
		return spawnTcpTransport(options);
	}
	// Merge non-interactive env and start in a new session (detached → setsid)
	// so the adapter process tree has no controlling terminal. Without this,
	// debuggee children can reach /dev/tty and trigger SIGTTIN, suspending
	// the parent harness under shell job control.
	const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args], {
		cwd,
		stdin: "pipe",
		env: adapterEnv(),
		detached: true,
	});
	return { proc };
}

export async function connectDapTransport(options: DapConnectOptions): Promise<DapTransportHandle> {
	const { host, port } = options;
	const exited = Promise.withResolvers<void>();
	const { readable, writeSink, socket } = await connectTcpSocket(host, port, exited);
	const proc = {
		exited: exited.promise,
		exitCode: null,
		stdin: { write: () => 0, flush: () => undefined },
		stdout: new ReadableStream<Uint8Array>(),
		stderr: new ReadableStream<Uint8Array>(),
		peekStderr: () => "",
		kill: () => {
			exited.resolve();
			return true;
		},
	} as unknown as DapClientState["proc"];
	return { proc, readable, writeSink, socket, port };
}

async function spawnTcpTransport({ adapter, cwd }: DapSpawnOptions): Promise<DapTransportHandle> {
	const host = "127.0.0.1";
	const port = await getFreePort(host);
	const resolvedArgs = adapter.args.map(arg => arg.replace(/\$\{port\}/g, String(port)));
	const proc = ptree.spawn([adapter.resolvedCommand, ...resolvedArgs], {
		cwd,
		stdin: "pipe",
		env: adapterEnv(),
		detached: true,
	});

	try {
		await waitForPortReady(host, port, 10_000, proc);
	} catch (err) {
		proc.kill();
		throw err;
	}

	const transportClosed = Promise.withResolvers<void>();
	let transport: SocketTransport;
	try {
		transport = await connectTcpSocket(host, port, transportClosed);
	} catch (err) {
		proc.kill();
		throw err;
	}
	return { proc, ...transport, port, transportClosed: transportClosed.promise };
}

/**
 * Spawn a socket-mode adapter (e.g. dlv).
 * Linux: connect to a unix domain socket via --listen=unix:<path>
 * macOS/other: the adapter dials into our TCP listener via --client-addr
 */
async function spawnSocketTransport({
	adapter,
	cwd,
	socketReadyTimeoutMs,
}: DapSpawnOptions): Promise<DapTransportHandle> {
	const env = adapterEnv();
	const timeoutMs = socketReadyTimeoutMs ?? SOCKET_READY_TIMEOUT_MS;
	const isLinux = process.platform === "linux";

	if (isLinux) {
		return spawnSocketUnixTransport({ adapter, cwd, env, timeoutMs });
	}
	return spawnSocketClientAddrTransport({ adapter, cwd, env, timeoutMs });
}

/** Linux: spawn adapter with --listen=unix:<path>, then connect to the socket. */
async function spawnSocketUnixTransport({
	adapter,
	cwd,
	env,
	timeoutMs,
}: {
	adapter: DapResolvedAdapter;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs: number;
}): Promise<DapTransportHandle> {
	const socketPath = `/tmp/dap-${adapter.name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
	const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--listen=unix:${socketPath}`], {
		cwd,
		stdin: "pipe",
		env,
		detached: true,
	});

	try {
		await waitForCondition(() => isUnixSocketReady(socketPath), timeoutMs, proc);
		const transport = await connectSocket({ unix: socketPath });
		return { proc, ...transport };
	} catch (error) {
		try {
			proc.kill();
		} catch {
			/* proc may already be dead */
		}
		throw error;
	}
}

/** macOS/other: listen on a random TCP port, spawn adapter with --client-addr, accept connection. */
async function spawnSocketClientAddrTransport({
	adapter,
	cwd,
	env,
	timeoutMs,
}: {
	adapter: DapResolvedAdapter;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs: number;
}): Promise<DapTransportHandle> {
	const { promise: connPromise, resolve: resolveConn } = Promise.withResolvers<Bun.Socket<undefined>>();

	// Listen on port 0 (OS picks a free port)
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				resolveConn(socket);
			},
			data() {},
			close() {},
			error() {},
		},
	});

	const port = server.port;
	const proc = ptree.spawn([adapter.resolvedCommand, ...adapter.args, `--client-addr=127.0.0.1:${port}`], {
		cwd,
		stdin: "pipe",
		env,
		detached: true,
	});

	const { promise: timeoutPromise, reject: rejectTimeout } = Promise.withResolvers<never>();
	const connectTimeout = setTimeout(
		() => rejectTimeout(new Error(`${adapter.name} did not connect within ${timeoutMs}ms`)),
		timeoutMs,
	);
	try {
		const rawSocket = await Promise.race([connPromise, timeoutPromise]);
		const transport = wrapBunSocket(rawSocket);
		return { proc, ...transport };
	} catch (error) {
		try {
			proc.kill();
		} catch {
			/* proc may already be dead */
		}
		throw error;
	} finally {
		clearTimeout(connectTimeout);
		server.stop();
	}
}

async function isUnixSocketReady(socketPath: string): Promise<boolean> {
	try {
		return (await fs.stat(socketPath)).isSocket();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

/** Poll a condition until it returns true, or timeout/process exit. */
async function waitForCondition(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	proc: { exitCode: number | null },
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		if (proc.exitCode !== null) {
			throw new Error("Adapter process exited before socket was ready");
		}
		await Bun.sleep(50);
	}
	throw new Error(`Socket not ready after ${timeoutMs}ms`);
}

/** Adapt a Bun.Socket to DapWriteSink. */
function socketToSink(socket: Bun.Socket<undefined>): DapWriteSink {
	return {
		write(data: string | Uint8Array) {
			return socket.write(data);
		},
		flush() {
			socket.flush();
			return undefined;
		},
	};
}

/** Connect to a unix domain socket and return DAP transport streams. */
async function connectSocket(options: { unix: string }): Promise<SocketTransport> {
	const { promise, resolve } = Promise.withResolvers<SocketTransport>();
	let streamController: ReadableStreamDefaultController<Uint8Array>;

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	Bun.connect({
		unix: options.unix,
		socket: {
			open(socket) {
				resolve({
					readable,
					writeSink: socketToSink(socket),
					socket,
				});
			},
			data(_socket, data) {
				streamController.enqueue(new Uint8Array(data));
			},
			close() {
				try {
					streamController.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, err) {
				try {
					streamController.error(err);
				} catch {
					/* already closed */
				}
			},
		},
	});

	return promise;
}

/** Wrap an already-connected Bun.Socket into DAP transport streams. */
function wrapBunSocket(rawSocket: Bun.Socket<undefined>): SocketTransport {
	let streamController: ReadableStreamDefaultController<Uint8Array>;

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	// Attach data/close/error handlers to the already-open socket
	rawSocket.reload({
		socket: {
			open() {},
			data(_socket, data) {
				streamController.enqueue(new Uint8Array(data));
			},
			close() {
				try {
					streamController.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, err) {
				try {
					streamController.error(err);
				} catch {
					/* already closed */
				}
			},
		},
	});

	return {
		readable,
		writeSink: socketToSink(rawSocket),
		socket: rawSocket,
	};
}

function getFreePort(host: string): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	const cleanup = () => {
		server.removeAllListeners();
	};
	server.once("error", error => {
		cleanup();
		reject(error);
	});
	server.listen(0, host, () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close(() => {
				cleanup();
				reject(new Error(`Unable to reserve a TCP port on ${host}`));
			});
			return;
		}
		server.close(error => {
			cleanup();
			if (error) {
				reject(error);
				return;
			}
			resolve(address.port);
		});
	});
	return promise;
}

function tryConnectTcp(host: string, port: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const socket = net.createConnection({ host, port });
	let connected = false;
	let settled = false;
	let acceptTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	const settle = (callback: () => void) => {
		if (settled) return;
		settled = true;
		if (acceptTimer) clearTimeout(acceptTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		callback();
	};
	const resolveProbe = () => settle(resolve);
	timeoutTimer = setTimeout(() => {
		socket.destroy();
		settle(() => reject(new Error(`TCP probe to ${host}:${port} timed out`)));
	}, 1_000);
	socket.once("connect", () => {
		connected = true;
		acceptTimer = setTimeout(() => {
			socket.destroy();
			resolveProbe();
		}, 50);
		socket.end();
	});
	socket.once("close", () => {
		if (!connected) {
			settle(() => reject(new Error(`TCP probe to ${host}:${port} closed before connecting`)));
		}
	});
	socket.once("error", error => {
		if (connected) {
			return;
		}
		socket.destroy();
		settle(() => reject(error));
	});
	return promise;
}

async function waitForPortReady(
	host: string,
	port: number,
	timeoutMs: number,
	proc: DapClientState["proc"],
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (proc.exitCode !== null) {
			throw new Error(`Adapter process exited before TCP port ${host}:${port} was ready`);
		}
		try {
			await tryConnectTcp(host, port);
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error(`Timeout waiting for TCP port ${host}:${port} to be ready`);
}

async function connectTcpSocket(host: string, port: number, exited?: { resolve(): void }): Promise<SocketTransport> {
	const { promise, resolve, reject } = Promise.withResolvers<SocketTransport>();
	let streamController: ReadableStreamDefaultController<Uint8Array>;
	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
		},
	});

	let opened = false;
	let rawSocket: Promise<Bun.Socket<undefined>> | undefined;
	const timeout = setTimeout(() => {
		if (!opened) {
			rawSocket?.then(socket => socket.end()).catch(() => {});
			reject(new Error(`Connection to TCP port ${host}:${port} timed out`));
		}
	}, 5000);

	rawSocket = Bun.connect({
		hostname: host,
		port,
		socket: {
			open(socket) {
				opened = true;
				clearTimeout(timeout);
				resolve({
					readable,
					writeSink: socketToSink(socket),
					socket,
				});
			},
			data(_socket, data) {
				streamController.enqueue(new Uint8Array(data));
			},
			close() {
				exited?.resolve();
				clearTimeout(timeout);
				if (!opened) {
					reject(new Error(`Connection to TCP port ${host}:${port} closed before opening`));
				}
				try {
					streamController.close();
				} catch {
					/* already closed */
				}
			},
			error(_socket, err) {
				exited?.resolve();
				clearTimeout(timeout);
				if (!opened) {
					reject(err);
				}
				try {
					streamController.error(err);
				} catch {
					/* already closed */
				}
			},
		},
	});
	rawSocket.catch(error => {
		exited?.resolve();
		clearTimeout(timeout);
		if (!opened) {
			reject(error);
			return;
		}
		try {
			streamController.error(error);
		} catch {
			/* already closed */
		}
	});

	return promise;
}
