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
  /**
   * The porcelain status code for the index side.
   */
  x: string;
  /**
   * The porcelain status code for the worktree side.
   */
  y: string;
  /**
   * The current repo-relative path of the file.
   */
  to: string;
  /**
   * The rename source path; equal to `to` for any other status.
   */
  from: string;
  /**
   * Whether the file content is binary; `null` when undetermined.
   */
  is_binary: boolean | null;
}

/**
 * Response shape of `POST /git/<path>/status`.
 */
export interface IGitStatusResult {
  /**
   * The return code of the git command.
   */
  code: number;
  /**
   * The current branch name; `null` when it is not available.
   */
  branch: string | null;
  /**
   * The upstream remote branch; `null` when none is set.
   */
  remote: string | null;
  /**
   * The number of commits ahead of the upstream branch.
   */
  ahead: number;
  /**
   * The number of commits behind the upstream branch.
   */
  behind: number;
  /**
   * The changed files reported by `git status`.
   */
  files: IGitStatusFile[];
  /**
   * The in-progress repository state (merge, rebase, ...), when reported.
   */
  state?: number;
  /**
   * An error message, present when the command fails.
   */
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
  /**
   * The return code of the git command.
   */
  code: number;
  /**
   * The file content at the requested reference.
   */
  content: string;
  /**
   * An error message, present when the command fails.
   */
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
  /**
   * The repo-relative path of the file.
   */
  path: string;
  /**
   * The rename source path, set only for renames.
   */
  from?: string;
  /**
   * Whether the change is staged or unstaged.
   */
  group: FileChangeGroup;
  /**
   * The change status derived from the porcelain codes.
   */
  status: FileChangeStatus;
  /**
   * Whether the file content is binary; `null` when undetermined.
   */
  isBinary: boolean | null;
}
