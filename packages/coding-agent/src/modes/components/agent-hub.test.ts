import { beforeAll, describe, expect, it } from "bun:test";
import { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import { SessionObserverRegistry } from "../session-observer-registry";
import { initTheme } from "../theme/theme";
import { AgentHubOverlayComponent } from "./agent-hub";

describe("AgentHubOverlayComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("uses an ASCII cursor for the selected agent row", () => {
		const registry = new AgentRegistry();
		registry.register({
			id: "WorkerOne",
			displayName: "worker",
			kind: "sub",
			session: null,
			status: "running",
		});

		const hub = new AgentHubOverlayComponent({
			observers: new SessionObserverRegistry(),
			hubKeys: ["ctrl+s"],
			onDone: () => {},
			requestRender: () => {},
			registry,
			irc: new IrcBus(registry),
			sessionFile: null,
		});

		try {
			const output = hub
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(output).toContain(" > ");
			expect(output).not.toContain("❯");
			expect(output).not.toContain("");
		} finally {
			hub.dispose();
		}
	});
});
