import type { IAgent } from './agents';

/**
 * Quote a string so it can be safely passed as a single argument on a
 * bash/zsh command line that is *typed into an interactive terminal* —
 * not the usual file-parsing context.
 *
 * The distinction matters: an actual newline byte (0x0A) sent into a PTY
 * is interpreted by the line discipline as Enter regardless of whether
 * it sits inside `'...'` quotes, so the shell never sees the closing
 * quote. We therefore use ANSI-C `$'...'` quoting and emit `\n` (and
 * `\r`) as their two-character escape sequences; the shell expands them
 * to real newlines after the line is submitted, when readline is no
 * longer involved. Backslashes and single quotes are escaped first so
 * the source text round-trips unchanged.
 */
function shellQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `$'${escaped}'`;
}

/**
 * Compose the literal command line typed into a fresh terminal for `agent`.
 * When `prompt` is empty (or whitespace-only), this is just `agent.command`.
 * When non-empty, the prompt is shell-quoted and spliced in using the
 * agent's `promptArgs` recipe — see `IAgent.promptArgs` for the encoding.
 *
 * Returns `agent.command` unchanged when the agent declares no prompt
 * support (`promptArgs === undefined`), so a stray prompt typed into the
 * launcher does not silently mutate the launch line for that agent. The
 * launcher UI separately prevents the click in that case so the dropped
 * prompt is never surprising to the user.
 */
export function buildAgentInvocation(agent: IAgent, prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || agent.promptArgs === undefined) {
    return agent.command;
  }
  const tokens = [agent.command, ...agent.promptArgs, shellQuote(trimmed)];
  return tokens.filter(token => token.length > 0).join(' ');
}
