import { describe, expect, it } from "bun:test";
import { PYTHON_PRELUDE } from "../prelude";

describe("python prelude", () => {
	it("exposes read(path, offset?, limit?) with positional optional args", () => {
		// The eval docs advertise `read(path, offset?=1, limit?=None)`. A
		// keyword-only signature (`def read(path, *, offset=1, limit=None)`)
		// makes `read("file", 10)` raise `TypeError: read() takes 1 positional
		// argument but 2 were given`, which agents in the wild repeatedly hit.
		// Lock the contract so the helper accepts both positional and keyword
		// forms.
		const match = PYTHON_PRELUDE.match(/def\s+read\(([^)]+)\)/);
		expect(match).not.toBeNull();
		const signature = match?.[1] ?? "";
		expect(signature).not.toContain("*,");
		expect(signature).toContain("offset");
		expect(signature).toContain("limit");
	});

	it("exposes isolation artifacts on the agent() handle node", () => {
		// agent(..., handle=True) is the only escape hatch for
		// recovering apply=False patch/branch/nested artifacts (the bare
		// schema return is just the parsed object), so the helper MUST
		// translate the bridge's camelCase details onto the node — otherwise
		// an isolated apply=False workflow loses captured nested patches.
		expect(PYTHON_PRELUDE).toContain('("patchPath", "patch_path")');
		expect(PYTHON_PRELUDE).toContain('("branchName", "branch_name")');
		expect(PYTHON_PRELUDE).toContain('("nestedPatches", "nested_patches")');
		expect(PYTHON_PRELUDE).toContain('("changesApplied", "changes_applied")');
		expect(PYTHON_PRELUDE).toContain('("isolationSummary", "isolation_summary")');
	});

	it("forwards integrate() options under the camelCase keys the bridge parses", () => {
		// The __integrate__ bridge validates `onConflict` (camelCase). A
		// snake_case key would be silently dropped, so the helper must translate
		// the Python `on_conflict` kwarg to `onConflict`.
		expect(PYTHON_PRELUDE).toContain('args["onConflict"] = on_conflict');
	});

	it("wraps a single node dict instead of corrupting it via list()", () => {
		// `list(a_dict)` yields the dict's keys — silently dropping the node's
		// data. integrate(single_node) must wrap, mirroring the JS helper.
		expect(PYTHON_PRELUDE).toContain("[nodes] if isinstance(nodes, dict) else list(nodes)");
	});

	it("snake_cases the integrate() report (including nested resolver_id/patch_path keys)", () => {
		// The report's nested resolved/failed items carry camelCase keys
		// (resolverId, patchPath); a top-level-only rename would leave them
		// camelCase, so the helper must convert recursively.
		expect(PYTHON_PRELUDE).toContain("def _snakeify(value)");
		expect(PYTHON_PRELUDE).toContain("def _camel_to_snake(name)");
	});
});
