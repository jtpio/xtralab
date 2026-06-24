import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import {
  GitReference,
  IFileChange,
  IGitContentResult,
  IGitStatusFile,
  IGitStatusResult
} from './tokens';

/**
 * Root URL segment used by the `jupyterlab_git` server extension. Every
 * endpoint hangs off this prefix; the `<repoPath>` between it and the
 * endpoint suffix is the JupyterLab server-relative path of the git
 * repository (URL-encoded). For an empty `repoPath` the URL collapses to
 * `/git/<endpoint>` — a shape git's URL routing also accepts.
 */
const GIT_NAMESPACE = 'git';

/**
 * Issue a `POST` against a `jupyterlab_git` endpoint that takes a `<path>`
 * prefix (e.g. `/git/<path>/status`). The response body is decoded as JSON;
 * non-2xx responses are surfaced via the JupyterLab `ServerConnection`
 * machinery so callers can show their `message` field as-is.
 */
async function postWithPath<T>(
  endpoint: string,
  repoPath: string,
  body: unknown
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  // `URLExt.encodeParts` encodes each path segment but preserves slashes
  // between them — the server expects the path to look like a posix path.
  const encodedPath = repoPath.length > 0 ? URLExt.encodeParts(repoPath) : '';
  const url = URLExt.join(
    settings.baseUrl,
    GIT_NAMESPACE,
    encodedPath,
    endpoint
  );
  const init: RequestInit = {
    method: 'POST',
    body: JSON.stringify(body ?? {})
  };
  const response = await ServerConnection.makeRequest(url, init, settings);
  const text = await response.text();
  let data: T | undefined;
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      // Fall through into the error handling below.
    }
  }
  if (!response.ok) {
    const message =
      (data as { message?: string } | undefined)?.message ?? text ?? '';
    throw new ServerConnection.ResponseError(response, message);
  }
  return (data ?? ({} as T)) as T;
}

/**
 * Fetch `git status --porcelain` for the repository the server resolves at
 * `repoPath`. When `repoPath` is the empty string, git resolves the repo
 * from the JupyterLab server's root directory.
 */
export async function status(repoPath: string): Promise<IGitStatusResult> {
  return postWithPath<IGitStatusResult>('status', repoPath, {});
}

/**
 * Fetch a file's contents at a particular git reference. `filename` is the
 * file's path relative to the git repository root (matching the `to` field
 * of {@link status}'s response).
 */
export async function content(
  repoPath: string,
  filename: string,
  reference: GitReference
): Promise<IGitContentResult> {
  return postWithPath<IGitContentResult>('content', repoPath, {
    filename,
    reference
  });
}

/**
 * Expand the porcelain `files` array into one entry per logical change.
 * A single porcelain row may map to two `IFileChange` rows (a file that's
 * both staged and modified again in the worktree); callers that just want
 * a flat list of all changes — without any staged-vs-unstaged grouping —
 * can use this helper.
 *
 * Provided as a manual concat rather than `Array.prototype.flatMap` so we
 * don't pin our `tsconfig.lib` to ES2019.
 */
export function expandStatusFiles(files: IGitStatusFile[]): IFileChange[] {
  const result: IFileChange[] = [];
  for (const file of files) {
    for (const change of porcelainToFileChanges(file)) {
      result.push(change);
    }
  }
  return result;
}

/**
 * Translate one entry in the porcelain `files` array into the panel's
 * preferred shape. A single porcelain entry may represent up to two changes
 * (one in the index, one in the worktree); we emit one {@link IFileChange}
 * per non-empty side, so a "modified-staged-and-then-modified-again" file
 * shows up twice in the panel — once under "Staged Changes" and once under
 * "Changes" — matching the layout the user sees in VS Code.
 */
export function porcelainToFileChanges(file: IGitStatusFile): IFileChange[] {
  const result: IFileChange[] = [];
  // Untracked files are reported with `??` and only appear under "Changes".
  if (file.x === '?' && file.y === '?') {
    return [
      {
        path: file.to,
        group: 'unstaged',
        status: 'untracked',
        isBinary: file.is_binary
      }
    ];
  }
  if (file.x !== ' ' && file.x !== '?') {
    result.push({
      path: file.to,
      from: file.from === file.to ? undefined : file.from,
      group: 'staged',
      status: porcelainCodeToStatus(file.x),
      isBinary: file.is_binary
    });
  }
  if (file.y !== ' ' && file.y !== '?') {
    result.push({
      path: file.to,
      from: file.from === file.to ? undefined : file.from,
      group: 'unstaged',
      status: porcelainCodeToStatus(file.y),
      isBinary: file.is_binary
    });
  }
  return result;
}

function porcelainCodeToStatus(code: string): IFileChange['status'] {
  switch (code) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'U':
      return 'unmerged';
    case 'T':
      return 'typechange';
    default:
      return 'unknown';
  }
}
