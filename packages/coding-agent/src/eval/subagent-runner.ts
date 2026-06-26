/**
 * Shared subagent context resolution + executor-option construction for the
 * eval bridges. Both the `agent()` bridge and the `integrate()` bridge (whose
 * conflict resolver is itself a subagent) build identical `ExecutorOptions`
 * from the parent {@link ToolSession}; centralizing it keeps the two callers
 * from drifting and lets `integrate()` reuse the full agent context (model
 * resolution, skills, MCP, local:// protocol) without depending on the
 * user-facing `agent()` semantics (handle/schema/apply/isolation gating).
 */
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import { resolveAgentModelPatterns } from "../config/model-resolver";
import type { LocalProtocolOptions } from "../internal-urls";
import { MCPManager } from "../mcp/manager";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import * as taskDiscovery from "../task/discovery";
import type { ExecutorOptions } from "../task/executor";
import type { AgentDefinition, AgentProgress } from "../task/types";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";

/** Wrap a raw assignment in the shared subagent user-prompt template. */
export function renderSubagentPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, { assignment: assignment.trim() });
}

/** Session-derived context shared by every eval-spawned subagent. */
export type ResolvedSubagentContext = Pick<
	ExecutorOptions,
	| "agent"
	| "modelOverride"
	| "parentActiveModelPattern"
	| "contextFiles"
	| "skills"
	| "autoloadSkills"
	| "mcpManager"
	| "localProtocolOptions"
	| "parentArtifactManager"
> & {
	/** Full discovered agent roster — callers use it for enablement gating + error listings. */
	agents: AgentDefinition[];
};

/**
 * Discover the agent roster, resolve `agentName` to a definition, and compute
 * the model/skills/context/MCP bundle every eval subagent shares. Throws a
 * {@link ToolError} when the agent name is unknown (with the available list).
 * Does NOT perform enablement / spawn-allow / depth gating — those are
 * user-facing policy the caller applies.
 */
export async function resolveEvalSubagentContext(
	session: ToolSession,
	agentName: string,
	modelPattern: string | string[] | undefined,
): Promise<ResolvedSubagentContext> {
	const { agents } = await taskDiscovery.discoverAgents(session.cwd);
	const agent = taskDiscovery.getAgent(agents, agentName);
	if (!agent) {
		const available = agents.map(candidate => candidate.name).join(", ") || "none";
		throw new ToolError(`Unknown agent "${agentName}". Available: ${available}`);
	}

	const parentActiveModelPattern = session.getActiveModelString?.();
	const agentModelOverrides = session.settings.get("task.agentModelOverrides");
	const modelOverride = resolveAgentModelPatterns({
		settingsOverride: modelPattern ?? agentModelOverrides[agentName],
		agentModel: agent.model,
		settings: session.settings,
		activeModelPattern: parentActiveModelPattern,
		fallbackModelPattern: session.getModelString?.(),
	});

	const availableSkills = [...(session.skills ?? [])];
	const resolvedAutoloadSkills =
		agent.autoloadSkills?.length && availableSkills.length > 0
			? agent.autoloadSkills
					.map(name => availableSkills.find(skill => skill.name === name))
					.filter((skill): skill is NonNullable<typeof skill> => skill !== undefined)
			: [];
	const contextFiles = session.contextFiles?.filter(file => path.basename(file.path).toLowerCase() !== "agents.md");
	const localProtocolOptions: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: session.getArtifactsDir ?? (() => null),
		getSessionId: session.getSessionId ?? (() => null),
	};
	const parentArtifactManager = session.getArtifactManager?.() ?? undefined;
	const mcpManager = session.mcpManager ?? MCPManager.instance();

	return {
		agent,
		agents,
		modelOverride,
		parentActiveModelPattern,
		contextFiles,
		skills: availableSkills,
		autoloadSkills: resolvedAutoloadSkills,
		mcpManager,
		localProtocolOptions,
		parentArtifactManager,
	};
}

/** Per-spawn knobs layered on top of {@link ResolvedSubagentContext}. */
export interface SubagentRunSpec {
	/** Stable subagent id (also the output-artifact id). */
	id: string;
	/** Raw assignment (wrapped via {@link renderSubagentPrompt}). */
	assignment: string;
	/** Display description / label. */
	description?: string;
	/** Structured-output schema (omit for plain text). */
	outputSchema?: unknown;
	/** Session JSONL path, or null for an ephemeral (non-persisted) run. */
	sessionFile: string | null;
	/** Output artifacts dir. */
	artifactsDir: string;
	/** Persist the session transcript; defaults to `Boolean(sessionFile)`. */
	persistArtifacts?: boolean;
	/** Execution cwd override (e.g. an integration worktree). Defaults to `session.cwd`. */
	cwd?: string;
	/** Force-attach an advisor for this spawn. */
	forceAdvisor?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
}

/**
 * Build the {@link ExecutorOptions} for an eval-spawned subagent. Mirrors the
 * settings the `agent()` bridge has always used: LSP off (cold-start is pure
 * overhead for programmatic helpers), no wall-clock cap (the parent cell
 * watchdog is suspended for the bridge call), and `keepAlive: false` (one-shot
 * helper, unregistered on disposal).
 */
export function buildEvalSubagentRunOptions(
	session: ToolSession,
	ctx: ResolvedSubagentContext,
	spec: SubagentRunSpec,
): ExecutorOptions {
	return {
		cwd: spec.cwd ?? session.cwd,
		agent: ctx.agent,
		task: renderSubagentPrompt(spec.assignment),
		assignment: spec.assignment,
		description: spec.description,
		index: 0,
		id: spec.id,
		taskDepth: session.taskDepth ?? 0,
		modelOverride: ctx.modelOverride,
		parentActiveModelPattern: ctx.parentActiveModelPattern,
		thinkingLevel: ctx.agent.thinkingLevel,
		outputSchema: spec.outputSchema,
		sessionFile: spec.sessionFile,
		persistArtifacts: spec.persistArtifacts ?? Boolean(spec.sessionFile),
		artifactsDir: spec.artifactsDir,
		// LSP cold-start is tens of seconds of pure overhead for programmatic
		// helpers; the `task.enableLsp` knob only governs the `task` tool.
		enableLsp: false,
		signal: spec.signal,
		eventBus: session.eventBus,
		onProgress: spec.onProgress,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		// Parent cell watchdog is suspended for the whole bridge call, so the
		// per-subagent wall-clock cap must be disabled regardless of settings.
		maxRuntimeMs: 0,
		keepAlive: false,
		forceAdvisor: spec.forceAdvisor === true,
		mcpManager: ctx.mcpManager,
		contextFiles: ctx.contextFiles,
		skills: ctx.skills,
		autoloadSkills: ctx.autoloadSkills,
		workspaceTree: session.workspaceTree,
		promptTemplates: session.promptTemplates,
		localProtocolOptions: ctx.localProtocolOptions,
		parentArtifactManager: ctx.parentArtifactManager,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentTelemetry: session.getTelemetry?.(),
		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		// Live source of truth for `serviceTierSubagent: inherit` (null = explicit none).
		parentServiceTier: session.getServiceTier ? (session.getServiceTier() ?? null) : undefined,
		// Deliberately omit parentEvalSessionId: the parent's kernel is blocked
		// on this bridge call, so sharing the eval session would deadlock.
	};
}
