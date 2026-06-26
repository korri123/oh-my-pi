/**
 * Host-side handler for the eval `integrate()` helper.
 *
 * Takes the handle nodes from a fan-out of `agent(isolated=True, apply=False)`
 * runs and merges their captured patches into the parent worktree as a unit,
 * dispatching a resolver subagent on any 3-way conflict. See
 * {@link integratePatches} for the merge mechanics.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import integrateResolverTemplate from "../prompts/system/integrate-resolver.md" with { type: "text" };
import * as taskExecutor from "../task/executor";
import {
	type ConflictContext,
	type IntegrationPatch,
	type IntegrationReport,
	integratePatches,
} from "../task/patch-integrator";
import type { NestedRepoPatch } from "../task/worktree";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";
import { buildEvalSubagentRunOptions, resolveEvalSubagentContext } from "./subagent-runner";

/** Synthetic bridge name reserved for the `integrate()` helper across all runtimes. */
export const EVAL_INTEGRATE_BRIDGE_NAME = "__integrate__";

const DEFAULT_RESOLVER_AGENT = "task";

const integrateArgsSchema = type({
	nodes: "unknown[]",
	"order?": "'auto'|'given'",
	"onConflict?": "'resolve'|'abort'",
	"resolver?": "string>0",
});

export interface EvalIntegrateBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalIntegrateResult {
	text: string;
	details: IntegrationReport;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Read the first defined value among `keys` (camelCase or snake_case variants). */
function field(node: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		if (node[key] !== undefined) return node[key];
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Accept both prelude conventions for nested patches (`relativePath` / `relative_path`). */
function normalizeNestedPatches(value: unknown): NestedRepoPatch[] {
	if (!Array.isArray(value)) return [];
	const out: NestedRepoPatch[] = [];
	for (const entry of value) {
		const record = asRecord(entry);
		if (!record) continue;
		const relativePath = asString(field(record, "relativePath", "relative_path"));
		const patch = field(record, "patch");
		if (relativePath && typeof patch === "string") out.push({ relativePath, patch });
	}
	return out;
}

/**
 * Turn an `agent()` handle node into an {@link IntegrationPatch}, reading its
 * captured patch artifact. Branch-mode nodes (a `branchName` but no
 * `patchPath`) carry real edits this integrator cannot apply, so they error
 * loudly rather than being silently dropped.
 */
async function normalizeNode(node: unknown, index: number): Promise<IntegrationPatch> {
	const record = asRecord(node);
	if (!record) {
		throw new ToolError(
			`integrate(): nodes[${index}] is not an object. Pass the handle nodes returned by agent(...).`,
		);
	}
	const id = asString(field(record, "id", "label")) ?? `node-${index}`;
	const patchPath = asString(field(record, "patchPath", "patch_path"));
	const branchName = asString(field(record, "branchName", "branch_name"));
	const nestedPatches = normalizeNestedPatches(field(record, "nestedPatches", "nested_patches"));

	if (!patchPath && branchName) {
		throw new ToolError(
			`integrate(): node ${id} captured a branch (${branchName}) instead of a patch. ` +
				`integrate() requires patch-mode capture — fan out with agent(..., isolated=True, apply=False, merge=False) ` +
				`or set task.isolation.merge to "patch".`,
		);
	}

	if (!patchPath) {
		// No root patch — nested-only, or a genuinely empty node (no changes).
		return { id, patchText: "", nestedPatches };
	}

	let patchText: string;
	try {
		patchText = await Bun.file(patchPath).text();
	} catch {
		if (nestedPatches.length > 0) return { id, patchText: "", patchPath, nestedPatches };
		throw new ToolError(`integrate(): node ${id} references a patch artifact that no longer exists: ${patchPath}`);
	}
	return { id, patchText, patchPath, nestedPatches };
}

function parseArgs(args: unknown): {
	nodes: unknown[];
	order: "auto" | "given";
	onConflict: "resolve" | "abort";
	resolver: string;
} {
	const result = integrateArgsSchema(args);
	if (result instanceof type.errors) {
		throw new ToolError(`integrate() received invalid arguments: ${result.summary}`);
	}
	return {
		nodes: result.nodes,
		order: result.order ?? "auto",
		onConflict: result.onConflict ?? "resolve",
		resolver: result.resolver ?? DEFAULT_RESOLVER_AGENT,
	};
}

/** Resolve the per-call artifacts dir (next to the session file, or a temp dir). */
async function resolveArtifactsDir(session: ToolSession): Promise<string> {
	const sessionFile = session.getSessionFile();
	const dir = sessionFile
		? sessionFile.slice(0, -6)
		: path.join(os.tmpdir(), `omp-eval-integrate-${Snowflake.next()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

function summarize(report: IntegrationReport): string {
	const parts: string[] = [];
	if (report.applied.length) parts.push(`applied ${report.applied.length}`);
	if (report.resolved.length) parts.push(`resolved ${report.resolved.length}`);
	if (report.failed.length) parts.push(`failed ${report.failed.length}`);
	if (report.skipped.length) parts.push(`skipped ${report.skipped.length}`);
	const counts = parts.length ? parts.join(", ") : "no patches";
	const head = report.ok
		? `integrate() applied ${report.applied.length + report.resolved.length} patch(es) to the worktree (${counts}).`
		: `integrate() did not complete (${counts}).`;
	const tail: string[] = [];
	if (report.failed.length) {
		tail.push(`Failed: ${report.failed.map(entry => `${entry.id} (${entry.reason})`).join("; ")}.`);
	}
	if (report.combinedPatchPath && !report.appliedToWorktree) {
		tail.push(`Combined patch preserved at ${report.combinedPatchPath}.`);
	}
	if (report.nestedWarnings.length) tail.push(report.nestedWarnings.join(" "));
	return [head, ...tail].join(" ");
}

/**
 * Run a batch patch-integration on behalf of an eval cell's `integrate()` call.
 */
export async function runEvalIntegrate(
	args: unknown,
	options: EvalIntegrateBridgeOptions,
): Promise<EvalIntegrateResult> {
	const parsed = parseArgs(args);

	const isolationMode = options.session.settings.get("task.isolation.mode");
	if (isolationMode === "none") {
		throw new ToolError(
			`integrate() requires task.isolation.mode to be set; current mode is "none". ` +
				`The patches it merges come from isolated agent() runs, which also require an isolation mode.`,
		);
	}

	const patches = await Promise.all(parsed.nodes.map((node, index) => normalizeNode(node, index)));
	const artifactsDir = await resolveArtifactsDir(options.session);

	// Resolve the resolver agent's context once and reuse it for every conflict.
	const resolverCtx =
		parsed.onConflict === "resolve"
			? await resolveEvalSubagentContext(options.session, parsed.resolver, undefined)
			: null;

	const report = await withBridgeTimeoutPause(options.emitStatus, async () =>
		integratePatches({
			cwd: options.session.cwd,
			isolationMode,
			patches,
			order: parsed.order,
			onConflict: parsed.onConflict,
			artifactsDir,
			signal: options.signal,
			resolveConflict: async (conflict: ConflictContext) => {
				if (!resolverCtx) throw new ToolError("integrate(): conflict reached with onConflict='abort'.");
				const assignment = prompt.render(integrateResolverTemplate, {
					patchId: conflict.patchId,
					patchPath: conflict.patchPath,
					conflictedFiles: conflict.conflictedFiles,
					hardFailure: conflict.hardFailure,
				});
				const resolverId = `integrate-resolve-${Snowflake.next()}`;
				const runOptions = buildEvalSubagentRunOptions(options.session, resolverCtx, {
					id: resolverId,
					assignment,
					description: `resolve ${conflict.patchId}`,
					sessionFile: null,
					artifactsDir,
					persistArtifacts: false,
					cwd: conflict.cwd,
					signal: conflict.signal,
				});
				const result = await taskExecutor.runSubprocess(runOptions);
				const ok = result.exitCode === 0 && !result.error && !result.aborted;
				return { resolverId, ok, summary: result.error ?? undefined };
			},
		}),
	);

	return { text: summarize(report), details: report };
}
