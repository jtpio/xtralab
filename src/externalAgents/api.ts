import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import type { IExternalAgentSession, ITranscriptEntry } from './tokens';

function endpoint(...parts: string[]): {
  url: string;
  settings: ServerConnection.ISettings;
} {
  const settings = ServerConnection.makeSettings();
  return {
    url: URLExt.join(settings.baseUrl, 'xtralab', 'external-agents', ...parts),
    settings
  };
}

/**
 * The server's message for a failed request, falling back to the status.
 */
async function errorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === 'string' && payload.error) {
      return payload.error;
    }
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}`;
}

/**
 * List the external sessions for the server root. Resolves to `null` when
 * the request fails: "unavailable", not "none running".
 */
export async function fetchExternalSessions(): Promise<
  IExternalAgentSession[] | null
> {
  const { url, settings } = endpoint();
  let response: Response;
  try {
    response = await ServerConnection.makeRequest(url, {}, settings);
  } catch (error) {
    console.warn('xtralab: external agent listing failed', error);
    return null;
  }
  if (!response.ok) {
    console.warn(`xtralab: external agent listing returned ${response.status}`);
    return null;
  }
  try {
    const payload = (await response.json()) as { sessions?: unknown };
    return Array.isArray(payload.sessions)
      ? (payload.sessions as IExternalAgentSession[])
      : [];
  } catch (error) {
    console.warn('xtralab: external agent listing was not JSON', error);
    return null;
  }
}

/**
 * A page of transcript entries from `offset` (bytes); omit `offset` for the
 * initial load, which returns the most recent entries only.
 */
export async function fetchTranscript(
  id: string,
  offset?: number
): Promise<{
  entries: ITranscriptEntry[];
  offset: number;
  truncated: boolean;
}> {
  const { url, settings } = endpoint('transcript');
  const query = URLExt.objectToQueryString({
    id,
    ...(offset === undefined ? {} : { offset: String(offset) })
  });
  const response = await ServerConnection.makeRequest(
    url + query,
    {},
    settings
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  const payload = (await response.json()) as {
    entries?: ITranscriptEntry[];
    offset?: number;
    truncated?: boolean;
  };
  return {
    entries: payload.entries ?? [],
    offset: payload.offset ?? 0,
    truncated: payload.truncated === true
  };
}

/**
 * Deliver `text` to the running session; rejects with the server's reason.
 */
export async function postPrompt(id: string, text: string): Promise<void> {
  const { url, settings } = endpoint('prompt');
  const response = await ServerConnection.makeRequest(
    url,
    { method: 'POST', body: JSON.stringify({ id, text }) },
    settings
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
}
