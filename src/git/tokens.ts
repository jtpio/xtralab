/**
 * Types shared by the git plugin, mirroring the response shapes of the
 * `jupyterlab_git` server extension's REST API.
 */

/**
 * One entry of the `files` array from `POST /git/<path>/status`. `x`/`y` are
 * the porcelain index/worktree codes; `to` is the current repo-relative path
 * and `from` the rename source (equal to `to` for any other status).
 */
export interface IGitStatusFile {
  x: string;
  y: string;
  to: string;
  from: string;
  is_binary: boolean | null;
}

/**
 * Response shape of `POST /git/<path>/status`.
 */
export interface IGitStatusResult {
  code: number;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  files: IGitStatusFile[];
  state?: number;
  message?: string;
}

/**
 * Reference accepted by `POST /git/<path>/content`: `WORKING` is the on-disk
 * copy, `INDEX` the staged copy, `git` any commit-ish.
 */
export type GitReference =
  | { special: 'WORKING' | 'INDEX' | 'BASE' }
  | { git: string };

/**
 * Response shape of `POST /git/<path>/content`.
 */
export interface IGitContentResult {
  code: number;
  content: string;
  message?: string;
}

type FileChangeGroup = 'staged' | 'unstaged';

export type FileChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'unmerged'
  | 'typechange'
  | 'unknown';

/**
 * One row in the changes panel. `path` is repo-relative; `from` is set only
 * for renames and carries the original path.
 */
export interface IFileChange {
  path: string;
  from?: string;
  group: FileChangeGroup;
  status: FileChangeStatus;
  isBinary: boolean | null;
}
