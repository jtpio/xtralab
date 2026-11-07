import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Ask the server extension's `which`-proxy endpoint which commands resolve on
 * its `$PATH`. Returns `null` on any failure — callers should treat that as
 * "availability unknown", not as "nothing available".
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
