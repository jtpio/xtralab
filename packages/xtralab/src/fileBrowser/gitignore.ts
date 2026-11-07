import ignore from 'ignore';
import type { Ignore } from 'ignore';

import { Contents } from '@jupyterlab/services';

import type { GitStatusEntry } from '@pierre/trees';

const GITIGNORE_PATH = '.gitignore';

/**
 * Load the workspace `.gitignore` and return an `ignore` matcher built from
 * its contents. Returns `null` when the file is missing, empty, or fails to
 * load — callers should treat any of those as "no ignored entries".
 */
export async function loadGitignoreMatcher(
  contentsManager: Contents.IManager
): Promise<Ignore | null> {
  let model: Contents.IModel;
  try {
    model = await contentsManager.get(GITIGNORE_PATH, {
      content: true,
      format: 'text',
      type: 'file'
    });
  } catch {
    return null;
  }
  if (model.type !== 'file' || typeof model.content !== 'string') {
    return null;
  }
  if (model.content.length === 0) {
    return null;
  }
  return ignore().add(model.content);
}

/**
 * One `GitStatusEntry` per ignored subtree root: descendant entries would
 * pollute the tree's `directoriesWithChanges` set (bogus dots on parents),
 * and `ignored` already propagates downward. The trailing slash on directory
 * paths keeps the sorted `startsWith` ancestor check off name-prefix siblings.
 */
export function buildIgnoredEntries(
  matcher: Ignore,
  canonicalPaths: Iterable<string>
): GitStatusEntry[] {
  const sorted = Array.from(canonicalPaths).sort();
  const emittedIgnoredDirs: string[] = [];
  const entries: GitStatusEntry[] = [];
  for (const path of sorted) {
    if (path.length === 0) {
      continue;
    }
    if (emittedIgnoredDirs.some(dir => path.startsWith(dir))) {
      continue;
    }
    if (matcher.ignores(path)) {
      entries.push({ path, status: 'ignored' });
      if (path.endsWith('/')) {
        emittedIgnoredDirs.push(path);
      }
    }
  }
  return entries;
}
