import ultrasolveNotice from "../prompts/system/ultrasolve-notice.md" with { type: "text" };
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { keywordInProse } from "./markdown-prose";

/**
 * "ultrasolve" keyword support.
 *
 * Ultrasolve inherits ultrathink's standalone prose matching, rainbow editor
 * highlight, hidden notice, and maximum-thinking behavior, then adds a
 * self-contained solver-escalation contract. Matching is whitespace-delimited
 * and case-sensitive (lowercase only), so longer words, paths, and code text do
 * not trigger it.
 */

// Detection: lowercase keyword flanked by whitespace or a string edge. Non-global so `.test` stays stateless.
const ULTRASOLVE_WORD = /(?<!\S)ultrasolve(?!\S)/;

/** Hidden system notice appended after a user message that mentions "ultrasolve". */
export const ULTRASOLVE_NOTICE: string = ultrasolveNotice.trim();

/**
 * Whether `text` contains the standalone keyword "ultrasolve" (lowercase,
 * whitespace-delimited) in prose — never inside a code block, inline code span,
 * or XML/HTML section.
 */
export function containsUltrasolve(text: string): boolean {
	return keywordInProse(text, ULTRASOLVE_WORD);
}

/**
 * Rainbow-highlight every standalone "ultrasolve" in `text`, inheriting
 * ultrathink's full-spectrum editor treatment.
 */
export const highlightUltrasolve: KeywordHighlighter = createGradientHighlighter({
	probe: /ultrasolve/,
	highlight: /(?<!\S)ultrasolve(?!\S)/g,
	stops: 14,
	hue: t => t * 330,
});
