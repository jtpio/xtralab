/**
 * Types shared by the git plugin. Mirror the response shapes returned by the
 * `jupyterlab_git` server extension's REST API so the frontend can stay
 * tightly coupled to a single version of those endpoints.
 */

/**
 * A single entry in the `files` array returned by `POST /git/<path>/status`.
 * `x` and `y` are the porcelain-format index/worktree status codes (see
 * `git status --porcelain`); `to` is the file's current path relative to the
 * git repository root, `from` is the source path for renames (and equal to
 * `to` for any other status).
 */
export interface IGitStatusFile {
  x: string;
  y: string;
  to: string;
  from: string;
  is_binary: boolean | null;
}

/** Response shape of `POST /git/<path>/status`. */
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
 * Reference accepted by `POST /git/<path>/content` to identify which version
 * of a file to fetch. `WORKING` is the on-disk copy, `INDEX` is the staged
 * copy, and a `git` value is any commit-ish (`HEAD`, a SHA, …).
 */
export type GitReference =
  | { special: 'WORKING' | 'INDEX' | 'BASE' }
  | { git: string };

/**
 * Response shape of `POST /git/<path>/content`. The server only returns text
 * content here; binary files are reported as binary in the status response,
 * and we surface them in the UI without attempting to render their diff.
 */
export interface IGitContentResult {
  code: number;
  content: string;
  message?: string;
}

/**
 * Where a file's change lives relative to the index.
 *
 *   - `staged`   → present in the index, may differ from HEAD
 *   - `unstaged` → present in the worktree, differs from the index
 *
 * A single file can appear in both groups when the worktree has further
 * changes on top of an already-staged version. The panel models that as two
 * separate entries, one per group.
 */
export type FileChangeGroup = 'staged' | 'unstaged';

/**
 * The user-facing status of a file change. Drives the single-letter badge
 * (M/A/D/R/U/?) shown next to each entry in the panel.
 */
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
 * One row in the changes panel. `path` is the file's path relative to the
 * git repository root. `from` is non-`undefined` only for renames, in which
 * case it carries the original path.
 */
export interface IFileChange {
  path: string;
  from?: string;
  group: FileChangeGroup;
  status: FileChangeStatus;
  isBinary: boolean | null;
}
