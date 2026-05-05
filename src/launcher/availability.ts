import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Hit the xtralab server extension's `which`-proxy endpoint and turn the
 * response into a Set of commands that resolved to a real binary on the
 * server's `$PATH`. The frontend uses this set to filter the launcher's
 * agent cards.
 *
 * On any failure (server extension not loaded, network error, malformed
 * response) the returned Set is `null` — callers should treat that as
 * "availability unknown" and either fall back to showing all agents or
 * surface the error, depending on context.
 */
export async function fetchAvailableCommands(
  commands: string[]
): Promise<Set<string> | null> {
  if (commands.length === 0) {
    return new Set();
  }

  const settings = ServerConnection.makeSettings();
  const url = URLExt.join(
    settings.baseUrl,
    'xtralab',
    'agents',
    'availability'
  );

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
    console.warn('xtralab: availability check failed', error);
    return null;
  }

  if (!response.ok) {
    console.warn(
      `xtralab: availability endpoint returned HTTP ${response.status}`
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn('xtralab: availability response was not JSON', error);
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const available = new Set<string>();
  for (const [command, path] of Object.entries(
    payload as Record<string, unknown>
  )) {
    if (typeof path === 'string' && path.length > 0) {
      available.add(command);
    }
  }
  return available;
}
