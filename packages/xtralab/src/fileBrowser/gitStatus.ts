import type { GitStatus, GitStatusEntry } from '@pierre/trees';

import { expandStatusFiles, status } from '../git/api';
import type { FileChangeStatus, IFileChange } from '../git/tokens';

/**
 * Repo path for `/git/*` calls; empty means the server root, letting git
 * resolve the enclosing repo (same convention as the git panel).
 */
export const GIT_REPO_PATH = '';

/**
 * Translate a `jupyterlab_git` porcelain status into a `@pierre/trees`
 * `GitStatus`. The tree only supports the six common statuses, so the rare
 * ones (unmerged, typechange, unknown) collapse onto `modified`.
 */
function toTreeStatus(value: FileChangeStatus): GitStatus {
  switch (value) {
    case 'added':
    case 'deleted':
    case 'modified':
    case 'renamed':
    case 'untracked':
      return value;
    case 'unmerged':
    case 'typechange':
    case 'unknown':
    default:
      return 'modified';
  }
}

/**
 * Fetch the porcelain status for `repoPath`, one entry per staged or
 * unstaged change. Any failure yields an empty array — the file browser
 * must work without git.
 */
export async function loadGitChanges(repoPath: string): Promise<IFileChange[]> {
  try {
    const result = await status(repoPath);
    if (result.code !== 0) {
      return [];
    }
    return expandStatusFiles(result.files);
  } catch {
    return [];
  }
}

/**
 * Collapse changes into the tree's `GitStatusEntry` values. A file both
 * staged and unstaged gets one entry, the unstaged status winning (mirrors
 * what is on disk, matching VS Code).
 */
export function toGitStatusEntries(
  changes: readonly IFileChange[]
): GitStatusEntry[] {
  const byPath = new Map<string, FileChangeStatus>();
  for (const change of changes) {
    if (change.group === 'unstaged' || !byPath.has(change.path)) {
      byPath.set(change.path, change.status);
    }
  }
  const entries: GitStatusEntry[] = [];
  byPath.forEach((value, path) => {
    entries.push({ path, status: toTreeStatus(value) });
  });
  return entries;
}
