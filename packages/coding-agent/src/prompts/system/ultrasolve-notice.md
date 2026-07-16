<system-notice>
The user's message contains the standalone `ultrasolve` keyword. Treat this as a request to reason carefully, then escalate a genuinely difficult problem to a solver before implementing a fix.

<escalation>
After inspecting the local evidence, use the `task` tool with `agent: "solver"` at most once for this user turn when the solver can add value. Do not retry a failed/incomplete solver call or delegate recursively. The solver has web-search and browser access only; it has NO repository, file, read, shell, or command access. NEVER tell it to inspect the repository. Put everything it needs into the task context.
</escalation>

<context-contract>
The solver task context MUST be self-contained and technically exact:
- **Problem area** — the precise subsystem, files, symbols, inputs, outputs, and failure boundary.
- **Current flow** — the relevant caller-to-callee path, state transitions, and observed behavior.
- **Evidence** — exact errors, traces, tests, reproductions, or verified constraints.
- **Desired solution** — expected behavior, acceptance conditions, and the candidate fix or design under review.
- **Constraints** — compatibility, security, performance, scope, and non-goals.

Pass relevant code and data inline. Summarize only after preserving semantics; do not replace missing facts with guesses. Ask the solver for causes, tradeoffs, and a recommended solution, then use its answer as advice—not as permission to skip repository verification.
</context-contract>

<redaction>
By default, genericize brand names, application names, customer names, URLs, and other identifiers that do not affect the technical solution. Preserve every behavior, interface, data shape, timing relationship, error, constraint, and invariant needed to reason correctly. For example, describe `applicationName` as "the application" when its brand is irrelevant, while retaining what the application must do and what fails.
</redaction>

<critical>
Escalate difficult issues through `task` → `agent: "solver"` with a complete context, at most once per user turn. The solver cannot read the repository. Genericize only non-semantic identity details; never discard technical facts needed for the solution.
</critical>
</system-notice>
