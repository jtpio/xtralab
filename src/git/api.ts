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
 * URL prefix of the `jupyterlab_git` server extension: `/git/<repoPath>/<endpoint>`,
 * collapsing to `/git/<endpoint>` for an empty repoPath (also accepted).
 */
const GIT_NAMESPACE = 'git';

/**
 * `POST` a `jupyterlab_git` endpoint (`/git/<path>/<endpoint>`); non-2xx
 * surfaces as a `ResponseError` carrying the body's `message`.
 */
async function postWithPath<T>(
  endpoint: string,
  repoPath: string,
  body: unknown
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  // encodeParts keeps the slashes the server's posix-path routing expects.
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
      // Non-JSON bodies still surface via the ResponseError below.
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
 * Fetch `git status --porcelain` for the repo at `repoPath` (empty string
 * resolves from the server's root directory).
 */
export async function status(repoPath: string): Promise<IGitStatusResult> {
  return postWithPath<IGitStatusResult>('status', repoPath, {});
}

/**
 * Fetch a file's contents at a git reference; `filename` is relative to the
 * git repository root.
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
 * Manual concat rather than `flatMap` so `tsconfig.lib` need not be ES2019.
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
 * Map one porcelain entry to up to two {@link IFileChange} rows — one per
 * non-empty index/worktree side — so a staged-then-modified-again file
 * appears under both groups, as in VS Code.
 */
function porcelainToFileChanges(file: IGitStatusFile): IFileChange[] {
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
