import { describe, expect, it } from "bun:test";
import { applyAgentBodyOmitRegions } from "@oh-my-pi/pi-coding-agent/task/executor";

const OPEN = "<!--omit-when-schema-override-->";
const CLOSE = "<!--/omit-when-schema-override-->";

describe("applyAgentBodyOmitRegions", () => {
	it("strips fenced content and markers when omit is true", () => {
		const body = `keep-before
${OPEN}
drop-me
drop-me-2
${CLOSE}
keep-after`;

		const result = applyAgentBodyOmitRegions(body, true);

		expect(result).toBe(`keep-before
keep-after`);
		expect(result).not.toContain("drop-me");
		expect(result).not.toContain(OPEN);
		expect(result).not.toContain(CLOSE);
	});

	it("keeps fenced content but drops markers when omit is false", () => {
		const body = `keep-before
${OPEN}
drop-me
drop-me-2
${CLOSE}
keep-after`;

		const result = applyAgentBodyOmitRegions(body, false);

		expect(result).toBe(`keep-before
drop-me
drop-me-2
keep-after`);
		expect(result).not.toContain(OPEN);
		expect(result).not.toContain(CLOSE);
		// Vacuity guard: this same input must diverge from the omit=true path,
		// proving the flag gates stripping instead of always removing markers/content.
		expect(result).not.toBe(applyAgentBodyOmitRegions(body, true));
	});

	it("returns no-marker bodies unchanged for both omit modes", () => {
		const body = `line1
line2`;

		expect(applyAgentBodyOmitRegions(body, true)).toBe(body);
		expect(applyAgentBodyOmitRegions(body, false)).toBe(body);
	});

	it("applies the selected omit mode to multiple independent regions", () => {
		const body = `start
${OPEN}
drop-one
${CLOSE}
middle
${OPEN}
drop-two
${CLOSE}
end`;

		const omitted = applyAgentBodyOmitRegions(body, true);
		const retained = applyAgentBodyOmitRegions(body, false);

		expect(omitted).toBe(`start
middle
end`);
		expect(omitted).not.toContain("drop-one");
		expect(omitted).not.toContain("drop-two");
		expect(omitted).not.toContain(OPEN);
		expect(omitted).not.toContain(CLOSE);

		expect(retained).toBe(`start
drop-one
middle
drop-two
end`);
		expect(retained).toContain("drop-one");
		expect(retained).toContain("drop-two");
		expect(retained).not.toContain(OPEN);
		expect(retained).not.toContain(CLOSE);
	});

	it("recognizes marker lines with leading and trailing whitespace", () => {
		const body = `before
  ${OPEN}  
drop-indented-region
\t${CLOSE}\t
after`;

		const result = applyAgentBodyOmitRegions(body, true);

		expect(result).toBe(`before
after`);
		expect(result).not.toContain("drop-indented-region");
		expect(result).not.toContain(OPEN);
		expect(result).not.toContain(CLOSE);
	});
});
