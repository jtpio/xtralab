import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/**
 * Shape of the `jupyterlab-quickopen` `api/files` response: a map from each
 * directory (relative to the server root, `""` for the root itself) to the
 * bare filenames it contains.
 */
interface IQuickOpenContents {
  contents: { [dir: string]: string[] };
}

/**
 * Fetch and flatten the workspace file list from `jupyterlab-quickopen`'s
 * server endpoint (`GET {base}/jupyterlab-quickopen/api/files`).
 *
 * We reuse quickopen's endpoint rather than walking the contents API so the
 * listing honors the same server-side `.gitignore` filtering quickopen does
 * (xtralab ships `respectGitignore: true`) in a single request. The endpoint
 * only exists when quickopen's server extension is installed and the server
 * reads a local filesystem; callers treat a rejection as "no file results".
 */
async function fetchWorkspaceFiles(respectGitignore = true): Promise<string[]> {
  const settings = ServerConnection.makeSettings();
  const params = new URLSearchParams();
  if (respectGitignore) {
    params.append('respect_gitignore', '1');
  }
  // The handler requires a `path` argument; `""` scans from the root.
  params.append('path', '');
  const url =
    URLExt.join(settings.baseUrl, 'jupyterlab-quickopen', 'api', 'files') +
    `?${params.toString()}`;

  const response = await ServerConnection.makeRequest(
    url,
    { method: 'GET' },
    settings
  );
  if (response.status !== 200) {
    throw new ServerConnection.ResponseError(response);
  }
  const data = (await response.json()) as IQuickOpenContents;
  const paths: string[] = [];
  for (const dir in data.contents) {
    for (const name of data.contents[dir]) {
      paths.push(dir ? `${dir}/${name}` : name);
    }
  }
  return paths;
}

const CACHE_TTL_MS = 15_000;
let cache: { at: number; files: Promise<string[]> } | null = null;

/**
 * The workspace file list, cached briefly so reopening the omnibox in quick
 * succession reuses one scan. A failed fetch (e.g. quickopen's server
 * extension is absent) resolves to an empty list so file search degrades to
 * "no results" instead of surfacing an error.
 */
export function loadWorkspaceFiles(): Promise<string[]> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_TTL_MS) {
    cache = { at: now, files: fetchWorkspaceFiles().catch(() => []) };
  }
  return cache.files;
}
