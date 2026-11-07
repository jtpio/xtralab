import { PathExt } from '@jupyterlab/coreutils';

import type { IAskAgentContext } from './tokens';

/**
 * The path a context points at, resolved against the server root. Contexts
 * from git diffs carry repository-relative paths plus the repository root in
 * `cwd`; contexts from plain editors are already server-relative.
 */
export function serverPath(context: IAskAgentContext): string {
  return context.cwd !== undefined && context.cwd.length > 0
    ? PathExt.join(context.cwd, context.path)
    : context.path;
}

/**
 * Cap on the embedded snippet; the path and line range are the
 * authoritative pointers, so a very long selection is trimmed.
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
 * Agent-facing description of where `context` points: path, notebook cell,
 * line range and any extra locator, e.g.
 * `` `src/app.ts`, lines 3-9, the old side (HEAD) of the current git diff ``.
 */
function locatorFor(context: IAskAgentContext): string {
  const where: string[] = [`\`${context.path}\``];
  if (context.cell !== undefined) {
    // Both orderings so the agent can count cells or index the nbformat
    // `cells` array.
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
  return where.join(', ');
}

function commentParts(
  context: IAskAgentContext,
  instruction: string,
  headline: string
): string[] {
  const parts: string[] = [headline];
  if (context.text.length > 0) {
    const { snippet, truncated } = clampSnippet(context.text);
    const fence = fenceFor(snippet);
    parts.push(`${fence}\n${snippet}\n${fence}`);
    if (truncated) {
      parts.push('(snippet truncated — read the file for the full range)');
    }
  }
  parts.push(instruction);
  return parts;
}

/**
 * Compose the prompt handed to the agent CLI: locator, fenced snippet,
 * instruction. The scaffold is English on purpose — consumed by the agent,
 * not shown in the UI.
 */
export function buildPrompt(
  context: IAskAgentContext,
  instruction: string
): string {
  return commentParts(context, instruction, `In ${locatorFor(context)}:`).join(
    '\n\n'
  );
}

/**
 * Compose one prompt out of every queued comment, numbered and in queue
 * order, so a whole review pass reaches the agent as a single task list. A
 * queue of one degrades to the plain {@link buildPrompt} wording.
 */
export function buildBatchPrompt(
  items: ReadonlyArray<{ context: IAskAgentContext; instruction: string }>
): string {
  if (items.length === 1) {
    return buildPrompt(items[0].context, items[0].instruction);
  }
  const parts: string[] = [
    `Please address the following ${items.length} comments.`
  ];
  items.forEach((item, index) => {
    parts.push(
      ...commentParts(
        item.context,
        item.instruction,
        `Comment ${index + 1} — in ${locatorFor(item.context)}:`
      )
    );
  });
  return parts.join('\n\n');
}
