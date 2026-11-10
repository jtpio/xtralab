import { URLExt } from '@jupyterlab/coreutils';
import { type Contents, ServerConnection } from '@jupyterlab/services';

import { loadGitignoreMatcher } from '../fileBrowser/gitignore';
import { hasServerExtension } from '../server';

/**
 * Shape of the `jupyterlab-quickopen` `api/files` response: directory
 * (relative to the server root, `""` for the root) to bare filenames.
 */
interface IQuickOpenContents {
  /**
   * Filenames grouped by their containing directory.
   */
  contents: { [dir: string]: string[] };
}

/**
 * Fetch and flatten the workspace file list from `jupyterlab-quickopen`'s
 * server endpoint, which applies server-side `.gitignore` filtering in one
 * request. Rejects when the server extension is absent; callers treat that as
 * "no file results".
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

/**
 * Folders that the contents walk never enters, as in `jupyterlab-quickopen`.
 */
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'venv']);

const MAX_WALKED_FILES = 5000;

/**
 * List the workspace files with the contents API, for JupyterLite where the
 * `jupyterlab-quickopen` server does not run. Hidden and `.gitignore`d paths
 * are skipped, and the walk stops after {@link MAX_WALKED_FILES} files.
 */
async function walkWorkspaceFiles(
  contents: Contents.IManager
): Promise<string[]> {
  const matcher = await loadGitignoreMatcher(contents);
  const files: string[] = [];
  const pending = [''];
  while (pending.length > 0 && files.length < MAX_WALKED_FILES) {
    const dir = pending.shift()!;
    let model: Contents.IModel;
    try {
      model = await contents.get(dir, { content: true });
    } catch {
      continue;
    }
    for (const item of (model.content ?? []) as Contents.IModel[]) {
      const isDir = item.type === 'directory';
      if (
        item.name.startsWith('.') ||
        (isDir && SKIPPED_FOLDERS.has(item.name)) ||
        matcher?.ignores(isDir ? `${item.path}/` : item.path)
      ) {
        continue;
      }
      if (isDir) {
        pending.push(item.path);
      } else {
        files.push(item.path);
      }
    }
  }
  return files;
}

const CACHE_TTL_MS = 15_000;
let cache: { at: number; files: Promise<string[]> } | null = null;

/**
 * The workspace file list, cached briefly so reopening the omnibox reuses one
 * scan. A failed fetch resolves to an empty list.
 */
export function loadWorkspaceFiles(
  contents: Contents.IManager
): Promise<string[]> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_TTL_MS) {
    const files = hasServerExtension()
      ? fetchWorkspaceFiles()
      : walkWorkspaceFiles(contents);
    cache = { at: now, files: files.catch(() => []) };
  }
  return cache.files;
}
