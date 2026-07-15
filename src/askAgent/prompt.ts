import type { IAskAgentContext } from './tokens';

/**
 * Cap on the snippet embedded in the prompt, in characters. The path and
 * line range are the authoritative pointers — agents open the file
 * themselves — so a very long selection is trimmed instead of being typed
 * into the terminal wholesale.
 */
const MAX_SNIPPET_CHARS = 2000;

/**
 * A backtick fence strictly longer than any backtick run inside `text`, so
 * the embedded snippet can never terminate the fence early.
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Trim `text` to {@link MAX_SNIPPET_CHARS}, cutting at a line boundary.
 * Returns the (possibly shortened) snippet and whether anything was dropped.
 */
function clampSnippet(text: string): { snippet: string; truncated: boolean } {
  if (text.length <= MAX_SNIPPET_CHARS) {
    return { snippet: text, truncated: false };
  }
  const head = text.slice(0, MAX_SNIPPET_CHARS);
  const lastBreak = head.lastIndexOf('\n');
  return {
    snippet: lastBreak > 0 ? head.slice(0, lastBreak) : head,
    truncated: true
  };
}

/**
 * Compose the prompt handed to the agent CLI: a one-line locator, the
 * selected snippet in a code fence, then the user's instruction.
 *
 * The scaffold is written in English on purpose — it is consumed by the
 * agent, not shown in the UI, and the agent CLIs are English-first.
 */
export function buildPrompt(
  context: IAskAgentContext,
  instruction: string
): string {
  const where: string[] = [`\`${context.path}\``];
  if (context.cell !== undefined) {
    // Both orderings so the agent can count cells or index the nbformat
    // `cells` array, whichever its notebook tooling prefers.
    where.push(
      `${context.cell.type} cell ${context.cell.index + 1} ` +
        `(0-based index ${context.cell.index})`
    );
  }
  if (context.startLine !== undefined) {
    const endLine = context.endLine ?? context.startLine;
    const lines =
      endLine > context.startLine
        ? `lines ${context.startLine}-${endLine}`
        : `line ${context.startLine}`;
    where.push(context.cell !== undefined ? `${lines} of the cell` : lines);
  }
  if (context.location !== undefined && context.location.length > 0) {
    where.push(context.location);
  }

  const parts: string[] = [`In ${where.join(', ')}:`];
  if (context.text.length > 0) {
    const { snippet, truncated } = clampSnippet(context.text);
    const fence = fenceFor(snippet);
    parts.push(`${fence}\n${snippet}\n${fence}`);
    if (truncated) {
      parts.push('(snippet truncated — read the file for the full range)');
    }
  }
  parts.push(instruction);
  return parts.join('\n\n');
}
