import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Ask the xtralab server which of `commands` runs in each open terminal
 * session: a map from session name to matched command (`null` = idle). Any
 * failure resolves the whole result to `null` — "detection unavailable",
 * not "no agents"; callers must not clear badges on it.
 */
export async function fetchRunningAgents(
  commands: string[]
): Promise<Record<string, string | null> | null> {
  if (commands.length === 0) {
    return {};
  }

  const settings = ServerConnection.makeSettings();
  const url = URLExt.join(settings.baseUrl, 'xtralab', 'terminals', 'agents');

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({ commands })
      },
      settings
    );
  } catch (error) {
    console.warn('xtralab: running-agent detection failed', error);
    return null;
  }

  if (!response.ok) {
    console.warn(
      `xtralab: detection endpoint returned HTTP ${response.status}`
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn('xtralab: detection response was not JSON', error);
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const result: Record<string, string | null> = {};
  for (const [name, command] of Object.entries(
    payload as Record<string, unknown>
  )) {
    result[name] = typeof command === 'string' && command ? command : null;
  }
  return result;
}
