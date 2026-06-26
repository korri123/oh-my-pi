import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import * as taskExecutor from "../../task/executor";
import * as patchIntegrator from "../../task/patch-integrator";
import type { AgentDefinition, SingleResult } from "../../task/types";
import type { ToolSession } from "../../tools";
import { runEvalIntegrate } from "../integrate-bridge";
import * as subagentRunner from "../subagent-runner";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
	spawns: "*",
	model: ["pi/task"],
};

function makeSession(mode = "auto"): ToolSession {
	// Minimal stub: runEvalIntegrate reads settings/getSessionFile/cwd; the
	// resolver path's deep session accessors are reached only through
	// resolveEvalSubagentContext/buildEvalSubagentRunOptions, which the resolver
	// test spies out.
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "task.isolation.mode": mode }),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function cannedReport(overrides: Partial<patchIntegrator.IntegrationReport> = {}): patchIntegrator.IntegrationReport {
	return {
		ok: true,
		applied: [],
		resolved: [],
		failed: [],
		skipped: [],
		appliedToWorktree: true,
		nestedWarnings: [],
		...overrides,
	};
}

function fakeRunResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "resolver",
		agent: "task",
		agentSource: "bundled",
		task: "t",
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

describe("runEvalIntegrate", () => {
	let tmp: TempDir;

	beforeEach(async () => {
		tmp = await TempDir.create("@omp-integrate-bridge-");
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await tmp.remove();
	});

	it("normalizes camelCase and snake_case nodes, reading patch artifacts", async () => {
		const spy = vi
			.spyOn(patchIntegrator, "integratePatches")
			.mockResolvedValue(cannedReport({ applied: ["a", "b"] }));
		const pA = tmp.join("a.patch");
		const pB = tmp.join("b.patch");
		await Bun.write(pA, "diff A");
		await Bun.write(pB, "diff B");

		await runEvalIntegrate(
			{
				nodes: [
					{ id: "a", patchPath: pA },
					{ id: "b", patch_path: pB, nested_patches: [{ relative_path: "sub", patch: "np" }] },
				],
				onConflict: "abort",
			},
			{ session: makeSession() },
		);

		const opts = spy.mock.calls[0]?.[0];
		expect(opts?.patches).toEqual([
			{ id: "a", patchText: "diff A", patchPath: pA, nestedPatches: [] },
			{ id: "b", patchText: "diff B", patchPath: pB, nestedPatches: [{ relativePath: "sub", patch: "np" }] },
		]);
		expect(opts?.order).toBe("auto");
		expect(opts?.onConflict).toBe("abort");
	});

	it("rejects a branch-mode node instead of silently dropping its edits", async () => {
		const spy = vi.spyOn(patchIntegrator, "integratePatches").mockResolvedValue(cannedReport());
		await expect(
			runEvalIntegrate({ nodes: [{ id: "x", branchName: "omp/task/x" }] }, { session: makeSession() }),
		).rejects.toThrow(/branch/i);
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects a node whose patch artifact is gone", async () => {
		vi.spyOn(patchIntegrator, "integratePatches").mockResolvedValue(cannedReport());
		await expect(
			runEvalIntegrate(
				{ nodes: [{ id: "y", patchPath: tmp.join("missing.patch") }], onConflict: "abort" },
				{ session: makeSession() },
			),
		).rejects.toThrow(/no longer exists/);
	});

	it("requires an isolation mode", async () => {
		const spy = vi.spyOn(patchIntegrator, "integratePatches").mockResolvedValue(cannedReport());
		await expect(runEvalIntegrate({ nodes: [] }, { session: makeSession("none") })).rejects.toThrow(
			/task\.isolation\.mode/,
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("treats a node with no patch/branch/nested as an empty (skippable) patch", async () => {
		const spy = vi.spyOn(patchIntegrator, "integratePatches").mockResolvedValue(cannedReport({ skipped: ["e"] }));
		await runEvalIntegrate({ nodes: [{ id: "e" }], onConflict: "abort" }, { session: makeSession() });
		const opts = spy.mock.calls[0]?.[0];
		expect(opts?.patches).toEqual([{ id: "e", patchText: "", nestedPatches: [] }]);
	});

	it("maps the resolver subprocess outcome to the conflict-resolution ok flag", async () => {
		vi.spyOn(subagentRunner, "resolveEvalSubagentContext").mockResolvedValue({
			agent: taskAgent,
			agents: [taskAgent],
		});
		vi.spyOn(subagentRunner, "buildEvalSubagentRunOptions").mockReturnValue({
			cwd: ".",
			agent: taskAgent,
			task: "t",
			index: 0,
			id: "resolver",
		});
		const runSpy = vi.spyOn(taskExecutor, "runSubprocess");

		let capturedResolve: patchIntegrator.IntegratePatchesOptions["resolveConflict"] | undefined;
		vi.spyOn(patchIntegrator, "integratePatches").mockImplementation(async opts => {
			capturedResolve = opts.resolveConflict;
			return cannedReport();
		});

		await runEvalIntegrate({ nodes: [], resolver: "task" }, { session: makeSession() });
		expect(capturedResolve).toBeDefined();

		const conflict = {
			patchId: "c",
			conflictedFiles: ["a.txt"],
			hardFailure: false,
			patchText: "diff",
			patchPath: undefined,
			cwd: tmp.join("wt"),
		};

		runSpy.mockResolvedValueOnce(fakeRunResult({ exitCode: 0 }));
		expect(await capturedResolve?.(conflict)).toMatchObject({ ok: true });

		runSpy.mockResolvedValueOnce(fakeRunResult({ exitCode: 1, error: "boom" }));
		expect(await capturedResolve?.(conflict)).toMatchObject({ ok: false });

		runSpy.mockResolvedValueOnce(fakeRunResult({ exitCode: 0, aborted: true }));
		expect(await capturedResolve?.(conflict)).toMatchObject({ ok: false });
	});

	it("returns the report as details with a human summary", async () => {
		vi.spyOn(patchIntegrator, "integratePatches").mockResolvedValue(
			cannedReport({
				ok: false,
				applied: ["a"],
				failed: [{ id: "b", reason: "merge conflict" }],
				appliedToWorktree: false,
			}),
		);
		const result = await runEvalIntegrate({ nodes: [], onConflict: "abort" }, { session: makeSession() });
		expect(result.details.failed).toEqual([{ id: "b", reason: "merge conflict" }]);
		expect(result.text).toContain("did not complete");
		expect(result.text).toContain("b (merge conflict)");
	});
});
