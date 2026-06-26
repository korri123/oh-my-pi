import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { type ConflictContext, type ConflictResolution, integratePatches } from "../patch-integrator";
import * as worktree from "../worktree";

/**
 * The integrator's value is the real `git apply` ladder (clean → 3-way →
 * resolver) and the host-side conflict verification. We exercise all of it
 * against real git repos and mock ONLY the native worktree materialization
 * ({@link worktree.ensureIsolation}) — replaced with a plain recursive copy —
 * so the tests don't depend on a native isolation backend being present.
 */
const BASE = "one\ntwo\nthree\n";

async function git(dir: string, ...args: string[]): Promise<string> {
	return (await $`git ${args}`.cwd(dir).quiet()).text();
}

async function initRepo(dir: string): Promise<void> {
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "t@t.co");
	await git(dir, "config", "user.name", "test");
	await git(dir, "config", "commit.gpgsign", "false");
	await Bun.write(path.join(dir, "a.txt"), BASE);
	await git(dir, "add", "-A");
	await git(dir, "commit", "-q", "-m", "init");
}

/** Produce a `git diff` patch (relative to HEAD) for the given new file contents, then revert. */
async function capturePatch(dir: string, newContents: string): Promise<string> {
	await Bun.write(path.join(dir, "a.txt"), newContents);
	const text = (await $`git diff --binary`.cwd(dir).quiet()).text();
	await git(dir, "checkout", "--", ".");
	return text;
}

describe("integratePatches", () => {
	let tmp: TempDir;
	let repo: string;
	let copyIndex = 0;

	beforeEach(async () => {
		tmp = await TempDir.create("@omp-integrate-test-");
		repo = tmp.join("repo");
		await fs.mkdir(repo, { recursive: true });
		await initRepo(repo);
		copyIndex = 0;

		// Materialize the "integration worktree" as a recursive copy of the repo.
		vi.spyOn(worktree, "ensureIsolation").mockImplementation(async (repoRoot: string) => {
			const dir = tmp.join(`wt-${copyIndex++}`);
			await fs.cp(repoRoot, dir, { recursive: true });
			return { mergedDir: dir, backend: natives.IsoBackendKind.Rcopy, fellBack: false, fallbackReason: null };
		});
		vi.spyOn(worktree, "cleanupIsolation").mockResolvedValue(undefined);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await tmp.remove();
	});
	const neverResolve = async (): Promise<ConflictResolution> => {
		throw new Error("resolveConflict should not be called");
	};

	function baseOptions(patches: { id: string; patchText: string }[]) {
		return {
			cwd: repo,
			isolationMode: "auto" as const,
			patches,
			order: "given" as const,
			onConflict: "resolve" as const,
			artifactsDir: tmp.join("artifacts"),
		};
	}

	it("applies non-overlapping patches (clean + 3-way) and writes the combined result to the parent", async () => {
		const patchA = await capturePatch(repo, "A\ntwo\nthree\n"); // line 1
		const patchB = await capturePatch(repo, "one\ntwo\nB\n"); // line 3

		const report = await integratePatches({
			...baseOptions([
				{ id: "a", patchText: patchA },
				{ id: "b", patchText: patchB },
			]),
			resolveConflict: neverResolve,
		});

		expect(report.ok).toBe(true);
		expect(report.appliedToWorktree).toBe(true);
		expect(report.applied).toEqual(["a", "b"]);
		expect(report.resolved).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("A\ntwo\nB\n");
		expect(report.combinedPatchPath).toBeDefined();
		expect(await Bun.file(report.combinedPatchPath as string).exists()).toBe(true);
	});

	it("dispatches a resolver on a real conflict and applies the host-verified resolution", async () => {
		const patchA = await capturePatch(repo, "A\ntwo\nthree\n"); // line 1
		const patchC = await capturePatch(repo, "C\ntwo\nthree\n"); // line 1 — conflicts with A

		const conflicts: ConflictContext[] = [];
		const report = await integratePatches({
			...baseOptions([
				{ id: "a", patchText: patchA },
				{ id: "c", patchText: patchC },
			]),
			resolveConflict: async (ctx: ConflictContext) => {
				conflicts.push(ctx);
				// Resolve by hand-writing the merged result (markers removed).
				await Bun.write(path.join(ctx.cwd, "a.txt"), "RESOLVED\ntwo\nthree\n");
				return { resolverId: "resolver-1", ok: true };
			},
		});

		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]?.conflictedFiles).toContain("a.txt");
		expect(conflicts[0]?.hardFailure).toBe(false);
		expect(report.ok).toBe(true);
		expect(report.applied).toEqual(["a"]);
		expect(report.resolved).toEqual([{ id: "c", files: ["a.txt"], resolverId: "resolver-1" }]);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("RESOLVED\ntwo\nthree\n");
	});

	it("aborts at the first conflict without touching the parent worktree", async () => {
		const patchA = await capturePatch(repo, "A\ntwo\nthree\n");
		const patchC = await capturePatch(repo, "C\ntwo\nthree\n");

		const report = await integratePatches({
			...baseOptions([
				{ id: "a", patchText: patchA },
				{ id: "c", patchText: patchC },
			]),
			onConflict: "abort",
			resolveConflict: neverResolve,
		});

		expect(report.ok).toBe(false);
		expect(report.appliedToWorktree).toBe(false);
		expect(report.applied).toEqual(["a"]);
		expect(report.failed).toEqual([{ id: "c", reason: "merge conflict", patchPath: undefined }]);
		// Parent is left exactly as it was — no half-applied "a".
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe(BASE);
	});

	it("fails the patch (parent untouched) when the resolver leaves conflict markers", async () => {
		const patchA = await capturePatch(repo, "A\ntwo\nthree\n");
		const patchC = await capturePatch(repo, "C\ntwo\nthree\n");

		const report = await integratePatches({
			...baseOptions([
				{ id: "a", patchText: patchA },
				{ id: "c", patchText: patchC },
			]),
			// Resolver claims success but does nothing — markers remain.
			resolveConflict: async () => ({ resolverId: "lazy", ok: true }),
		});

		expect(report.ok).toBe(false);
		expect(report.appliedToWorktree).toBe(false);
		expect(report.resolved).toEqual([]);
		expect(report.failed[0]?.id).toBe("c");
		expect(report.failed[0]?.reason).toBe("resolver left unresolved conflicts");
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe(BASE);
	});

	it("fails the patch when the resolver subprocess reports failure", async () => {
		const patchA = await capturePatch(repo, "A\ntwo\nthree\n");
		const patchC = await capturePatch(repo, "C\ntwo\nthree\n");

		const report = await integratePatches({
			...baseOptions([
				{ id: "a", patchText: patchA },
				{ id: "c", patchText: patchC },
			]),
			resolveConflict: async () => ({ resolverId: "broken", ok: false }),
		});

		expect(report.failed[0]?.reason).toBe("resolver subprocess failed");
		expect(report.ok).toBe(false);
	});

	it("treats a no-change node as skipped", async () => {
		const report = await integratePatches({
			...baseOptions([{ id: "empty", patchText: "" }]),
			resolveConflict: neverResolve,
		});

		expect(report.skipped).toEqual(["empty"]);
		expect(report.applied).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.appliedToWorktree).toBe(true);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe(BASE);
	});
});
