Run one step of code in a persistent kernel. State persists across calls and subagents.

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step.

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, kwargs.{{/if}}{{#if jl}} Julia: sync, kwargs.{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → structured output, parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False, advisor?=None) → str | dict
    Run a subagent → final output. `agent` picks another discovered agent; omit it to use `{{spawnDefaultAgent}}`.{{#if spawnAllowedAgentsText}} Allowed agents: {{spawnAllowedAgentsText}}.{{/if}} `schema` as in completion(). Background via `local://` files named in the prompt. `handle` → DAG node dict { text, output, handle: "agent://<id>", id, agent } (parsed under `data` when `schema` set). `advisor=True` force-attaches an advisor to the spawn (overrides advisor.enabled/subagents settings; no-op without an advisor-role model; doubles per-turn model spend — costly across wide fan-outs).
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agent, schema, handle, advisor }).
{{/if}}
integrate(nodes, order?="auto", on_conflict?="resolve", resolver?="task") → dict
    Merge a fan-out of isolated agent() patches into the working tree as ONE unit. Pass the handle nodes from agent(isolated=True, apply=False, handle=True). Applies in order ("auto" smallest-first | "given"); a 3-way conflict dispatches a resolver subagent ("resolve") or stops ("abort"). Atomic — the real tree changes only if every patch integrates cleanly, else it's left untouched. Returns { ok, applied, resolved, failed, skipped, combined_patch_path, applied_to_worktree }.
{{/if}}
parallel(thunks) → list
    Thunks through a bounded pool (wide as a `task` batch — don't pre-shrink), input order kept; returns when all finish, a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard`.{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}}{{#if rb}} Ruby: `budget.total` (ceiling or nil), `budget.spent`, `budget.remaining` (Float::INFINITY when no ceiling), `budget.hard`.{{/if}}{{#if jl}} Julia: `budget.total` (ceiling or nothing), `budget.spent()`, `budget.remaining()` (Inf when no ceiling), `budget.hard`.{{/if}} Ceiling: `+Nk` (advisory) or `+Nk!`/Goal Mode (hard — `agent()` won't spawn past it); spend still tracked.
```
</prelude>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>
