import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAdapter } from "@oh-my-pi/pi-coding-agent/dap/config";
import { DapSessionManager } from "@oh-my-pi/pi-coding-agent/dap/session";
import type { DapResolvedAdapter } from "@oh-my-pi/pi-coding-agent/dap/types";

const externalBunDapCommand = process.env.OMP_TEST_BUN_DAP_COMMAND ?? process.env.OMP_BUN_DAP_COMMAND;
const describeExternalBunDap = externalBunDapCommand ? describe : describe.skip;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function requireExternalBunAdapter(cwd: string): DapResolvedAdapter {
	const previous = process.env.OMP_BUN_DAP_COMMAND;
	try {
		if (externalBunDapCommand) process.env.OMP_BUN_DAP_COMMAND = externalBunDapCommand;
		const adapter = resolveAdapter("bun", cwd);
		if (!adapter) throw new Error("external Bun adapter did not resolve");
		return {
			...adapter,
			launchDefaults: {
				...adapter.launchDefaults,
				runtime: process.execPath,
			},
		};
	} finally {
		restoreEnv("OMP_BUN_DAP_COMMAND", previous);
	}
}

describeExternalBunDap("external Bun DAP adapter", () => {
	it("launches through bun-dap-x and stops on a source breakpoint", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-dap-external-"));
		const manager = new DapSessionManager();
		try {
			const program = path.join(cwd, "app.ts");
			await Bun.write(
				program,
				[
					"const value = 41;",
					"const result = value + 1;",
					"console.log('result', result);",
					"await new Promise(() => {});",
					"",
				].join("\n"),
			);
			const realProgram = await fs.realpath(program);
			await manager.setBreakpoint(program, 3, undefined, undefined, 10_000);

			const snapshot = await manager.launch(
				{ adapter: requireExternalBunAdapter(cwd), program, cwd },
				undefined,
				30_000,
			);

			expect(snapshot.adapter).toBe("bun");
			expect(snapshot.status).toBe("stopped");
			expect(snapshot.source?.path).toBe(realProgram);
			expect(snapshot.line).toBe(3);
			expect((await manager.evaluate("value", "repl", undefined, undefined, 10_000)).evaluation?.result).toBe("41");
		} finally {
			await manager.terminate(undefined, 10_000).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);
});
