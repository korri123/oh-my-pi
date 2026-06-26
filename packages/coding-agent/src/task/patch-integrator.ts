/**
 * Batch integration of independently-captured isolation patches.
 *
 * `agent(isolated=True, apply=False)` fan-outs each capture a `git diff`
 * against the same parent baseline, so two patches that touch overlapping
 * regions cannot be applied back-to-back with a plain `git apply`. This module
 * merges a cohort of such patches as a unit:
 *
 *  1. Materialize ONE integration worktree (copy-on-write off the parent).
 *  2. Apply each root patch in order inside that worktree — clean apply when
 *     possible, else `git apply --3way` (a real 3-way merge against the blob
 *     ancestors the patch records).
 *  3. On an unresolved 3-way conflict, hand the conflicted worktree to a
 *     resolver subagent (via the injected {@link IntegratePatchesOptions.resolveConflict}
 *     callback) and re-verify the result host-side — never trusting the agent's
 *     own claim of success.
 *  4. Only once every patch is integrated cleanly is the combined delta applied
 *     to the parent worktree, atomically. Any failure leaves the parent
 *     untouched and surfaces the combined patch artifact for manual handling.
 *
 * The integration worktree is always torn down in `finally`, so a failed run
 * never leaves the parent tree half-merged or littered with conflict markers.
 */
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import { prepareIsolationContext } from "./isolation-runner";
import {
	applyNestedPatches,
	captureDeltaPatch,
	cleanupIsolation,
	ensureIsolation,
	type NestedRepoPatch,
	parseIsolationMode,
	type TaskIsolationMode,
} from "./worktree";

/** One captured patch to integrate (root diff + any nested-repo patches). */
export interface IntegrationPatch {
	/** Stable id (the source agent's output id / label). */
	id: string;
	/** Root `git diff` text. Empty string ⇒ no root changes. */
	patchText: string;
	/** Original artifact path, surfaced in the report for manual recovery. */
	patchPath?: string;
	/** Nested-repo patches captured alongside the root diff. */
	nestedPatches?: NestedRepoPatch[];
}

/** Context handed to the conflict-resolution callback. */
export interface ConflictContext {
	patchId: string;
	/** Files left with conflict markers (3-way) or the patch's target files (hard failure). */
	conflictedFiles: string[];
	/** True when the patch did not apply at all (no markers, nothing staged). */
	hardFailure: boolean;
	patchText: string;
	patchPath?: string;
	/** The integration worktree the resolver must edit. */
	cwd: string;
	signal?: AbortSignal;
}

/** Outcome reported by the resolver callback. The host re-verifies regardless. */
export interface ConflictResolution {
	resolverId: string;
	/** Whether the resolver subprocess itself finished successfully (exit 0, not errored/aborted). */
	ok: boolean;
	summary?: string;
}

export interface IntegratePatchesOptions {
	/** Any directory inside the target repository. */
	cwd: string;
	/** Active `task.isolation.mode` — drives the integration-worktree backend. Must not be `"none"`. */
	isolationMode: TaskIsolationMode;
	patches: IntegrationPatch[];
	/** `"auto"` applies smallest patches first (fewer conflicts); `"given"` keeps input order. */
	order: "auto" | "given";
	/** `"resolve"` dispatches a resolver subagent on conflict; `"abort"` stops at the first conflict. */
	onConflict: "resolve" | "abort";
	/** Where combined-patch artifacts are written. */
	artifactsDir: string;
	signal?: AbortSignal;
	resolveConflict: (ctx: ConflictContext) => Promise<ConflictResolution>;
	log?: (message: string) => void;
}

export interface IntegrationReport {
	/** True iff every non-skipped patch integrated and the combined delta landed in the parent worktree. */
	ok: boolean;
	/** Patch ids applied without conflict (clean or clean 3-way). */
	applied: string[];
	/** Patches whose conflicts a resolver subagent fixed (host-verified). */
	resolved: Array<{ id: string; files: string[]; resolverId: string }>;
	/** Patches that could not be integrated. */
	failed: Array<{ id: string; reason: string; patchPath?: string }>;
	/** Patches with no changes (no root diff and no nested patches). */
	skipped: string[];
	/** Combined merged delta written to the artifacts dir (`.partial.patch` when the run failed). */
	combinedPatchPath?: string;
	/** True iff the combined delta was applied to the parent worktree. */
	appliedToWorktree: boolean;
	/** Non-fatal nested-repo apply warnings. */
	nestedWarnings: string[];
}

const CONFLICT_OPEN = /^<{7}/m;
const CONFLICT_CLOSE = /^>{7}/m;

function ensureTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

/** Files named in a patch's `diff --git a/… b/<file>` headers. */
function patchTargetFiles(patchText: string): string[] {
	const files = new Set<string>();
	for (const match of patchText.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) {
		const file = match[1]?.trim();
		if (file) files.add(file);
	}
	return [...files];
}

/** Read a worktree file as text, or `null` when it does not exist. */
async function readFileOrNull(dir: string, file: string): Promise<string | null> {
	try {
		return await Bun.file(path.join(dir, file)).text();
	} catch {
		return null;
	}
}

/** Return the subset of `files` that still hold git conflict markers. */
async function scanConflictMarkers(dir: string, files: string[]): Promise<string[]> {
	const remaining: string[] = [];
	for (const file of files) {
		const text = await readFileOrNull(dir, file);
		if (text === null) continue; // deleted by the resolver — no markers to leave behind
		if (CONFLICT_OPEN.test(text) && CONFLICT_CLOSE.test(text)) remaining.push(file);
	}
	return remaining;
}

/**
 * Apply one patch into the integration worktree. Returns the per-patch outcome;
 * the caller records it and decides whether to halt. Staging after every
 * successful apply keeps the index aligned with the working tree so each
 * subsequent `--3way` merges against a coherent base.
 */
async function integrateOne(
	dir: string,
	patch: IntegrationPatch,
	opts: IntegratePatchesOptions,
): Promise<{
	status: "applied" | "skipped" | "resolved" | "failed";
	files?: string[];
	resolverId?: string;
	reason?: string;
}> {
	const text = patch.patchText.trim() ? ensureTrailingNewline(patch.patchText) : "";
	if (!text) {
		return { status: patch.nestedPatches?.length ? "applied" : "skipped" };
	}

	if (await git.patch.canApplyText(dir, text, { signal: opts.signal })) {
		await git.patch.applyText(dir, text, { signal: opts.signal });
		await git.stage.files(dir, [], opts.signal);
		opts.log?.(`${patch.id}: applied cleanly`);
		return { status: "applied" };
	}

	let threeWayOk = true;
	try {
		await git.patch.applyText(dir, text, { threeWay: true, signal: opts.signal });
	} catch {
		threeWayOk = false;
	}
	const unmerged = await git.ls.unmerged(dir, opts.signal);
	if (threeWayOk && unmerged.length === 0) {
		await git.stage.files(dir, [], opts.signal);
		opts.log?.(`${patch.id}: applied via 3-way merge`);
		return { status: "applied" };
	}

	const hardFailure = unmerged.length === 0;
	const conflictedFiles = unmerged.length > 0 ? unmerged : patchTargetFiles(text);
	if (opts.onConflict === "abort") {
		return {
			status: "failed",
			reason: hardFailure ? "patch did not apply" : "merge conflict",
		};
	}

	// Hard failure: the patch never applied, so the "no markers" check below
	// proves nothing — snapshot the target files so we can require the resolver
	// to have actually changed at least one of them.
	const before = hardFailure
		? new Map(await Promise.all(conflictedFiles.map(async file => [file, await readFileOrNull(dir, file)] as const)))
		: null;

	const resolution = await opts.resolveConflict({
		patchId: patch.id,
		conflictedFiles,
		hardFailure,
		patchText: text,
		patchPath: patch.patchPath,
		cwd: dir,
		signal: opts.signal,
	});
	if (!resolution.ok) {
		return { status: "failed", reason: "resolver subprocess failed" };
	}
	// Stage the resolver's edits so resolved files drop out of the unmerged set,
	// then re-verify host-side: no unmerged entries AND no leftover markers.
	await git.stage.files(dir, [], opts.signal);
	const stillUnmerged = await git.ls.unmerged(dir, opts.signal);
	const markers = await scanConflictMarkers(dir, conflictedFiles);
	if (stillUnmerged.length > 0 || markers.length > 0) {
		return { status: "failed", reason: "resolver left unresolved conflicts" };
	}
	if (before) {
		let changed = false;
		for (const file of conflictedFiles) {
			if ((await readFileOrNull(dir, file)) !== before.get(file)) {
				changed = true;
				break;
			}
		}
		if (!changed) {
			return { status: "failed", reason: "resolver did not apply the patch" };
		}
	}
	opts.log?.(`${patch.id}: resolved by ${resolution.resolverId}`);
	return { status: "resolved", files: conflictedFiles, resolverId: resolution.resolverId };
}

/**
 * Merge a cohort of isolation patches into the parent worktree. See the module
 * docstring for the staged, atomic flow.
 */
export async function integratePatches(opts: IntegratePatchesOptions): Promise<IntegrationReport> {
	const report: IntegrationReport = {
		ok: false,
		applied: [],
		resolved: [],
		failed: [],
		skipped: [],
		appliedToWorktree: false,
		nestedWarnings: [],
	};

	const context = await prepareIsolationContext(opts.cwd);
	const backend = parseIsolationMode(opts.isolationMode);
	const integrationId = `integrate-${Snowflake.next()}`;
	const handle = await ensureIsolation(context.repoRoot, integrationId, backend);
	const dir = handle.mergedDir;

	try {
		const ordered =
			opts.order === "auto"
				? [...opts.patches].sort((a, b) => a.patchText.length - b.patchText.length)
				: opts.patches;

		for (const patch of ordered) {
			const outcome = await integrateOne(dir, patch, opts);
			switch (outcome.status) {
				case "applied":
					report.applied.push(patch.id);
					break;
				case "skipped":
					report.skipped.push(patch.id);
					break;
				case "resolved":
					report.resolved.push({
						id: patch.id,
						files: outcome.files ?? [],
						resolverId: outcome.resolverId ?? "unknown",
					});
					break;
				case "failed":
					report.failed.push({
						id: patch.id,
						reason: outcome.reason ?? "integration failed",
						patchPath: patch.patchPath,
					});
					break;
			}
			if (outcome.status === "failed") break; // never stack onto a broken tree
		}

		// A failed patch leaves an unmerged index / conflict markers in the
		// worktree; capturing a delta off that is unreliable. Bail out with the
		// parent untouched — the report's applied/resolved ids and
		// `failed[].patchPath` carry everything needed for manual recovery.
		if (report.failed.length > 0) {
			report.ok = false;
			return report;
		}

		// Success path: every patch integrated cleanly and was staged, so the
		// index has no unmerged entries and the combined delta is well-formed.
		await git.stage.files(dir, [], opts.signal);
		const delta = await captureDeltaPatch(dir, context.baseline);
		const combined = delta.rootPatch.trim() ? ensureTrailingNewline(delta.rootPatch) : "";

		const integratedIds = new Set<string>([...report.applied, ...report.resolved.map(entry => entry.id)]);
		const nested = opts.patches
			.filter(patch => integratedIds.has(patch.id))
			.flatMap(patch => patch.nestedPatches ?? []);

		if (!combined && nested.length === 0) {
			// Everything was a no-op / skipped — nothing to apply, trivially clean.
			report.ok = true;
			report.appliedToWorktree = true;
			return report;
		}

		if (combined) {
			const combinedPath = path.join(opts.artifactsDir, `${integrationId}.patch`);
			await Bun.write(combinedPath, combined);
			report.combinedPatchPath = combinedPath;
		}

		await git.withRepoLock(
			context.repoRoot,
			async () => {
				if (combined) {
					if (await git.patch.canApplyText(context.repoRoot, combined, { signal: opts.signal })) {
						await git.patch.applyText(context.repoRoot, combined, { signal: opts.signal });
						report.appliedToWorktree = true;
					} else {
						report.appliedToWorktree = false;
					}
				} else {
					report.appliedToWorktree = true;
				}
				if (report.appliedToWorktree && nested.length > 0) {
					try {
						report.nestedWarnings = await applyNestedPatches(context.repoRoot, nested);
					} catch {
						report.nestedWarnings.push("Some nested repository patches failed to apply.");
					}
				}
			},
			opts.signal,
		);

		report.ok = report.appliedToWorktree;
		return report;
	} finally {
		await cleanupIsolation(handle);
	}
}
