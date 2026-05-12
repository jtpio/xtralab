import type { GitStatus, GitStatusEntry } from '@pierre/trees';

import { expandStatusFiles, status } from '../git/api';
import type { FileChangeStatus } from '../git/tokens';

/**
 * Translate a `jupyterlab_git` porcelain status into the closest
 * `@pierre/trees` `GitStatus` enum value. The tree library only supports the
 * six common statuses (added, deleted, ignored, modified, renamed, untracked)
 * so the rare ones (unmerged, typechange, unknown) collapse onto `modified`
 * — they all denote a pending change the user should see decorated.
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
 * Fetch the porcelain status for `repoPath` and convert it into a flat list
 * of `GitStatusEntry` values consumable by `FileTree.setGitStatus`. Returns
 * an empty array when the path is not in a git repo, the request fails, or
 * the server reports a non-zero exit — the file browser must still work
 * without git, so any error here is a no-op rather than a thrown exception.
 *
 * Files that have both a staged and an unstaged change are collapsed into a
 * single entry: the unstaged status wins because that mirrors what is
 * actually different on disk and matches VS Code's tree decoration behavior.
 */
export async function loadGitStatusEntries(
  repoPath: string
): Promise<GitStatusEntry[]> {
  try {
    const result = await status(repoPath);
    if (result.code !== 0) {
      return [];
    }
    const changes = expandStatusFiles(result.files);
    // Collapse staged + unstaged into one decoration per file. Prefer the
    // unstaged group when both exist; otherwise keep whichever group is
    // present.
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
  } catch {
    return [];
  }
}
