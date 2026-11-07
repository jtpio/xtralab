import { hasServerExtension } from '../server';
import type { IAgent } from './agents';

/**
 * Quote a string for a command line typed into an interactive terminal. A raw
 * newline sent to a PTY acts as Enter even inside '…' quotes, so ANSI-C
 * `$'…'` quoting emits `\n`/`\r` as escapes the shell expands after submit.
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
 * Quote a string for the JupyterLite shell (cockle): it has no `$'…'`
 * quoting, but a single-quoted string continues over several lines.
 */
function liteShellQuote(value: string): string {
  const escaped = value.replace(/'/g, "'\"'\"'").replace(/\r?\n/g, '\r');
  return `'${escaped}'`;
}

/**
 * Compose the literal command line typed into a fresh terminal for `agent`:
 * the shell-quoted prompt is spliced in per the `promptArgs` recipe. Returns
 * bare `agent.command` when the prompt is empty or the agent has no prompt
 * support.
 */
export function buildAgentInvocation(agent: IAgent, prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || agent.promptArgs === undefined) {
    return agent.command;
  }
  const quote = hasServerExtension() ? shellQuote : liteShellQuote;
  const tokens = [agent.command, ...agent.promptArgs, quote(trimmed)];
  return tokens.filter(token => token.length > 0).join(' ');
}
