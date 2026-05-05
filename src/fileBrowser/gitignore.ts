import ignore from 'ignore';
import type { Ignore } from 'ignore';

import { Contents } from '@jupyterlab/services';

import type { GitStatusEntry } from '@pierre/trees';

/**
 * The path of the workspace `.gitignore` file. Loaded relative to the
 * Jupyter contents root, which matches the directory the gitignore patterns
 * are evaluated against — patterns and tested paths share the same base.
 */
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
    // The most common failure here is `.gitignore` simply not existing.
    // Other transient errors (permission denied, server unreachable) are
    // also treated as "no matcher" so the file browser still works.
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
 * Build `GitStatusEntry`s for the canonical paths that match the given
 * gitignore matcher.
 *
 * `@pierre/trees` propagates the `ignored` style from a directory entry
 * down to every descendant via its internal `ignoredDirectoryPaths` set, so
 * we only emit one entry per ignored subtree root: emitting descendants
 * would also pollute the library's `directoriesWithChanges` set, causing
 * parent directories of nested ignored items to render a "contains git
 * status items" dot.
 *
 * Paths are sorted lexicographically so a directory always precedes its
 * descendants, allowing a simple ancestor-suppression check via
 * `path.startsWith(dir)`. The trailing slash on canonical directory paths
 * (required by `@pierre/trees`, also recognized by `ignore` as the
 * "directory" indicator) keeps the prefix check from accidentally matching
 * sibling paths that happen to share a name prefix (e.g. `node_modules_old`
 * vs `node_modules/`).
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
