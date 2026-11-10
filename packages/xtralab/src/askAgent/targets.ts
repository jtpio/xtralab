import type { AskAgentTarget } from './tokens';

/**
 * A string that identifies a target, for React keys, `<select>` values and
 * the remembered last pick. Parts are URI-encoded so ids may contain `:`.
 */
export function targetKey(target: AskAgentTarget): string {
  switch (target.kind) {
    case 'new':
      return `new:${encodeURIComponent(target.agentId)}`;
    case 'session':
      return `session:${encodeURIComponent(target.name)}`;
    case 'agent-session':
      return `agent-session:${encodeURIComponent(target.agentId)}:${encodeURIComponent(target.sessionId)}`;
  }
}

/**
 * The target of a {@link targetKey} string, or `null` when it does not parse.
 */
export function parseTargetKey(key: string): AskAgentTarget | null {
  const [kind, ...parts] = key.split(':');
  try {
    if (kind === 'new' && parts.length === 1) {
      return { kind: 'new', agentId: decodeURIComponent(parts[0]) };
    }
    if (kind === 'session' && parts.length === 1) {
      return { kind: 'session', name: decodeURIComponent(parts[0]) };
    }
    if (kind === 'agent-session' && parts.length === 2) {
      return {
        kind: 'agent-session',
        agentId: decodeURIComponent(parts[0]),
        sessionId: decodeURIComponent(parts[1])
      };
    }
  } catch {
    // A malformed escape sequence: not a key this module wrote.
  }
  return null;
}
