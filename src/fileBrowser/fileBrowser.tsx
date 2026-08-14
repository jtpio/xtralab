import * as React from 'react';

import { showErrorMessage } from '@jupyterlab/apputils';
import { IDocumentManager, renameFile } from '@jupyterlab/docmanager';
import { Contents } from '@jupyterlab/services';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Poll } from '@lumino/polling';

import { FileTree, useFileTree } from '@pierre/trees/react';
import type {
  FileTreeBatchOperation,
  FileTreeDirectoryHandle,
  FileTreeDropContext,
  FileTreeDropResult,
  GitStatusEntry
} from '@pierre/trees';

import type { Ignore } from 'ignore';

import {
  ROOT_LOAD_KEY,
  listDirectory,
  parentOf,
  toServerPath
} from './contents';
import {
  IDropMove,
  ITreeDropHandler,
  computeDropMoves,
  computeRootDropMoves,
  createTreeDragAndDropConfig,
  useRootDropZone
} from './dragAndDrop';
import { buildIgnoredEntries, loadGitignoreMatcher } from './gitignore';
import { loadGitStatusEntries } from './gitStatus';
import { FILE_BROWSER_ICONS } from './icons';
import type { XtralabFileBrowser } from './widget';

/**
 * Load state for a directory in the file tree. Directories are tracked from
 * the moment they are first observed (as a child of a loaded parent) so the
 * subscribe/diff loop can decide whether to fetch their contents on expand.
 */
type LoadState = 'unloaded' | 'loading' | 'loaded';

/**
 * Polling cadence for the git status decoration. Out-of-band changes (a
 * terminal `git add`, a `git pull`, a file edited outside the JupyterLab
 * editor) become visible within this interval without a manual refresh.
 * Aligned with the git panel's own polling so both views update on the
 * same rhythm.
 */
const GIT_STATUS_POLL_INTERVAL_MS = 5000;

/**
 * Upper bound on the git status poll's exponential backoff. Matches the
 * other polls in the plugin so behavior is consistent across views.
 */
const GIT_STATUS_POLL_MAX_MS = 300_000;

/**
 * Auto-refresh cadence for the file listing itself. Matches the default
 * JupyterLab file browser (`DEFAULT_REFRESH_INTERVAL` in
 * `@jupyterlab/filebrowser`) so the tree picks up files created outside
 * JupyterLab (terminal commands, external editors, `git pull`, …) within
 * the same window as the stock browser.
 */
const FILE_LISTING_REFRESH_INTERVAL_MS = 10000;

/**
 * Upper bound on the auto-refresh backoff when polls fail repeatedly.
 * Matches the default file browser's `max: 300 * 1000` — five minutes is
 * long enough that a server-side outage stops hammering the API, but
 * short enough that a transient failure heals on its own.
 */
const FILE_LISTING_REFRESH_MAX_MS = 300_000;

/**
 * Server-relative repository path used for `/git/*` calls. Empty string
 * means "use the JupyterLab server's root and let git resolve the
 * enclosing repo" — same convention as the git panel and the launcher
 * dashboard.
 */
const GIT_REPO_PATH = '';

/**
 * The custom-element tag used by `@pierre/trees` for its shadow host. Kept
 * as a constant rather than imported so we don't pay the `@pierre/trees`
 * resolution cost just for one string.
 */
const FILE_TREE_TAG = 'file-tree-container';

/**
 * Injected into the tree's shadow root. The second rule hides the search
 * box unless the host carries the visibility marker set by the filter
 * bridge effect below — `@pierre/trees` always renders the box when
 * `search` is enabled, and its stylesheet lives in the shadow root where
 * outside CSS cannot reach. The third rule restyles the drag-hover row:
 * the library paints it with the selection background, which xtralab
 * maps to a full-strength brand color that is illegible without the
 * inverted selection foreground — hence the quieter ring.
 */
const FILE_TREE_UNSAFE_CSS =
  '[data-type="item"][data-item-selected="true"] ' +
  '[data-item-section="spacing-item"] {' +
  'border-left-color: transparent;' +
  '}' +
  ':host(:not([data-xtralab-filter-visible])) ' +
  '[data-file-tree-search-container] {' +
  'display: none;' +
  '}' +
  '[data-type="item"][data-item-drag-target="true"] {' +
  'background-color: var(--trees-bg-muted);' +
  'box-shadow: inset 0 0 0 2px var(--trees-accent);' +
  '}';

interface IFileBrowserProps {
  contentsManager: Contents.IManager;
  docManager: IDocumentManager;
  onOpenFile?: (serverPath: string) => void;
  translator?: ITranslator;
  /**
   * The host widget. Selection-change events are pushed up so context-menu
   * commands can react to what the user has selected.
   */
  widget?: XtralabFileBrowser;
}

/**
 * Renders a `@pierre/trees` file tree backed by the Jupyter contents API.
 *
 * The Jupyter contents API only returns one directory level per request, so
 * the tree is populated lazily: the root is fetched on mount, and each
 * directory is fetched the first time the user expands it. Expansion is
 * detected by subscribing to the model and diffing against an in-memory load
 * state map.
 */
export function FileBrowserComponent(
  props: IFileBrowserProps
): React.ReactElement {
  const { contentsManager, docManager, onOpenFile, translator, widget } = props;

  const trans = React.useMemo(
    () => (translator ?? nullTranslator).load('jupyterlab'),
    [translator]
  );

  const dropHandlerRef = React.useRef<ITreeDropHandler | null>(null);

  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'closed',
    search: true,
    icons: FILE_BROWSER_ICONS,
    itemHeight: 24,
    unsafeCSS: FILE_TREE_UNSAFE_CSS,
    dragAndDrop: createTreeDragAndDropConfig(dropHandlerRef)
  });

  React.useEffect(() => {
    const knownDirs = new Map<string, LoadState>();
    // Mirror of the canonical paths currently loaded into the tree. Kept in
    // sync with `model.resetPaths`/`model.batch`/`model.add` so we can
    // re-test every loaded path against the gitignore matcher whenever
    // either side changes — the model itself does not expose a
    // path-iteration API.
    const loadedPaths = new Set<string>();
    let gitignoreMatcher: Ignore | null = null;
    let gitStatusEntries: readonly GitStatusEntry[] = [];
    let cancelled = false;

    /**
     * Recompute the combined `GitStatusEntry` list from the current
     * gitignore matcher and the latest porcelain status, then push it into
     * the tree. Safe to call at any time: empty inputs result in an empty
     * payload, which clears any statuses applied previously.
     *
     * Ignored entries go first so the porcelain entries win in the
     * unlikely event of overlap (a tracked path that also matches a
     * `.gitignore` rule). `@pierre/trees` lets later entries overwrite
     * earlier ones in its internal `statusByPath` map.
     */
    const syncGitStatus = (): void => {
      const entries: GitStatusEntry[] = [];
      if (gitignoreMatcher !== null) {
        for (const entry of buildIgnoredEntries(
          gitignoreMatcher,
          loadedPaths
        )) {
          entries.push(entry);
        }
      }
      for (const entry of gitStatusEntries) {
        entries.push(entry);
      }
      model.setGitStatus(entries);
    };

    /**
     * Reload the workspace `.gitignore`, then re-apply the resulting
     * ignored statuses. Called on initial mount and whenever the user
     * triggers a refresh — the file may have been edited or created in
     * between.
     */
    const refreshGitignoreMatcher = async (): Promise<void> => {
      let next: Ignore | null = null;
      try {
        next = await loadGitignoreMatcher(contentsManager);
      } catch (err) {
        console.error('xtralab: failed to load .gitignore', err);
      }
      if (cancelled) {
        return;
      }
      gitignoreMatcher = next;
      syncGitStatus();
    };

    /**
     * Refresh the porcelain-derived git status entries and re-apply them
     * to the tree. Runs on mount, on every refresh, and on a periodic
     * poll so out-of-band changes (terminal `git add`, file edits saved
     * outside the editor, …) become visible without explicit user action.
     */
    const refreshGitStatus = async (): Promise<void> => {
      const next = await loadGitStatusEntries(GIT_REPO_PATH);
      if (cancelled) {
        return;
      }
      gitStatusEntries = next;
      syncGitStatus();
    };

    const fetchDirectory = async (canonicalPath: string): Promise<void> => {
      const current = knownDirs.get(canonicalPath);
      if (current === 'loading' || current === 'loaded') {
        return;
      }
      knownDirs.set(canonicalPath, 'loading');
      try {
        const serverPath = toServerPath(canonicalPath);
        const { paths, subdirectories } = await listDirectory(
          contentsManager,
          serverPath
        );
        if (cancelled) {
          return;
        }
        if (canonicalPath === ROOT_LOAD_KEY) {
          model.resetPaths(paths);
          loadedPaths.clear();
          for (const path of paths) {
            loadedPaths.add(path);
          }
        } else {
          // Filter out paths already in the model. The path-store throws
          // when an explicit directory is added a second time, so any
          // entry created out-of-band (e.g. by the "new folder" command's
          // `notifyPathAdded` callback) must be skipped here.
          const operations: FileTreeBatchOperation[] = paths
            .filter(path => model.getItem(path) === null)
            .map(path => ({ type: 'add', path }));
          if (operations.length > 0) {
            model.batch(operations);
          }
          // Mirror every directory child into `loadedPaths` regardless of
          // whether it was just added or skipped above — paths skipped by
          // the filter are already in the model from a prior add and so
          // belong in the mirror too. `Set.add` is idempotent, so the
          // duplicate adds are a no-op.
          for (const path of paths) {
            loadedPaths.add(path);
          }
        }
        for (const subdir of subdirectories) {
          if (!knownDirs.has(subdir)) {
            knownDirs.set(subdir, 'unloaded');
          }
        }
        knownDirs.set(canonicalPath, 'loaded');
        syncGitStatus();
      } catch (err) {
        console.error(
          `xtralab: failed to load directory "${canonicalPath}"`,
          err
        );
        knownDirs.set(canonicalPath, 'unloaded');
      }
    };

    /**
     * Refresh every directory currently loaded into the tree. Walks down
     * from the root through the previously-expanded subdirectories so the
     * tree state mirrors what's on disk while preserving the user's
     * expansion state.
     */
    const refreshAll = async (): Promise<void> => {
      const expandedPaths = new Set<string>();
      knownDirs.forEach((state, path) => {
        if (path === ROOT_LOAD_KEY || state !== 'loaded') {
          return;
        }
        const item = model.getItem(path);
        if (
          item !== null &&
          item.isDirectory() &&
          (item as FileTreeDirectoryHandle).isExpanded()
        ) {
          expandedPaths.add(path);
        }
      });

      knownDirs.clear();
      knownDirs.set(ROOT_LOAD_KEY, 'loading');

      let rootPaths: string[];
      let rootSubdirs: string[];
      try {
        const result = await listDirectory(contentsManager, '');
        rootPaths = result.paths;
        rootSubdirs = result.subdirectories;
      } catch (err) {
        console.error('xtralab: refresh failed at the root', err);
        knownDirs.set(ROOT_LOAD_KEY, 'unloaded');
        return;
      }
      if (cancelled) {
        return;
      }

      const allPaths: string[] = [...rootPaths];

      // BFS through the previously-expanded subtree, fetching only the
      // directories the user had opened so the refresh doesn't walk the
      // entire workspace.
      const subdirsByParent = new Map<string, string[]>();
      subdirsByParent.set(ROOT_LOAD_KEY, rootSubdirs);
      const queue = rootSubdirs.filter(s => expandedPaths.has(s));
      while (queue.length > 0) {
        const dir = queue.shift()!;
        try {
          const serverPath = toServerPath(dir);
          const { paths, subdirectories } = await listDirectory(
            contentsManager,
            serverPath
          );
          if (cancelled) {
            return;
          }
          allPaths.push(...paths);
          subdirsByParent.set(dir, subdirectories);
          for (const subdir of subdirectories) {
            if (expandedPaths.has(subdir)) {
              queue.push(subdir);
            }
          }
        } catch (err) {
          console.error(`xtralab: refresh failed for "${dir}"`, err);
        }
      }

      // Reset the tree contents and restore the load-state map so future
      // expansions know which directories still need fetching.
      model.resetPaths(allPaths);
      loadedPaths.clear();
      for (const path of allPaths) {
        loadedPaths.add(path);
      }
      knownDirs.set(ROOT_LOAD_KEY, 'loaded');
      subdirsByParent.forEach(subdirs => {
        for (const subdir of subdirs) {
          knownDirs.set(
            subdir,
            expandedPaths.has(subdir) ? 'loaded' : 'unloaded'
          );
        }
      });

      // Refresh the `.gitignore` matcher in case the file was edited
      // since the last load, then re-apply the resulting statuses to the
      // newly-loaded paths. The reload runs in parallel with the rest of
      // the refresh — `refreshGitignoreMatcher` calls `syncGitStatus`
      // itself when it completes. The porcelain status is also re-fetched
      // here so a user-triggered refresh picks up out-of-band git changes
      // immediately instead of waiting for the next poll tick.
      void refreshGitignoreMatcher();
      void refreshGitStatus();

      // Re-expand the directories that were expanded before the refresh.
      // We have to do this after `resetPaths` because the reset starts
      // every directory in its initial collapsed state.
      for (const path of expandedPaths) {
        const item = model.getItem(path);
        if (item !== null && item.isDirectory()) {
          (item as FileTreeDirectoryHandle).expand();
        }
      }
    };

    /**
     * Auto-refresh tick: walk every directory currently loaded into the
     * tree, fetch its children, and apply the per-directory diff as a
     * single batched mutation. Unlike {@link refreshAll} this never calls
     * `model.resetPaths`, so the user's expansion, selection, and scroll
     * state survive every poll. Mirrors what the default JupyterLab file
     * browser does for its single-directory view.
     *
     * A failed fetch for a single directory is treated as transient and
     * is skipped without touching that directory's children — they may
     * still be valid even if this one fetch lost the race with a server
     * restart. A deleted directory eventually surfaces through its
     * parent's diff: when the parent is re-fetched and no longer lists
     * the missing child, the child is removed recursively from the tree
     * and from the load-state tracking maps.
     */
    const quietRefresh = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      const dirsToRefresh: string[] = [];
      knownDirs.forEach((state, path) => {
        if (state === 'loaded') {
          dirsToRefresh.push(path);
        }
      });
      if (dirsToRefresh.length === 0) {
        return;
      }

      let mutated = false;

      for (const dir of dirsToRefresh) {
        if (cancelled) {
          return;
        }
        // Skip directories that were removed from `knownDirs` while we
        // were processing an earlier sibling — the cascade cleanup below
        // can prune deep subtrees, so a path captured at the start of
        // the tick may already be gone.
        if (knownDirs.get(dir) !== 'loaded') {
          continue;
        }
        let fetched: { paths: string[]; subdirectories: string[] };
        try {
          fetched = await listDirectory(contentsManager, toServerPath(dir));
        } catch (err) {
          console.warn(`xtralab: auto-refresh skipped "${dir}"`, err);
          continue;
        }
        if (cancelled) {
          return;
        }

        const newChildren = new Set(fetched.paths);
        const ops: FileTreeBatchOperation[] = [];
        const additions: string[] = [];
        const removals: string[] = [];
        const directoryRemovals: string[] = [];

        for (const lp of loadedPaths) {
          if (parentOf(lp) !== dir) {
            continue;
          }
          if (newChildren.has(lp)) {
            continue;
          }
          // Disappeared since the last tick. Remove recursively so any
          // descendants that were also being tracked go with it.
          ops.push({ type: 'remove', path: lp, recursive: true });
          removals.push(lp);
          if (lp.endsWith('/')) {
            directoryRemovals.push(lp);
          }
        }
        for (const newChild of fetched.paths) {
          if (loadedPaths.has(newChild)) {
            continue;
          }
          ops.push({ type: 'add', path: newChild });
          additions.push(newChild);
        }

        if (ops.length > 0) {
          try {
            model.batch(ops);
          } catch (err) {
            console.error(
              `xtralab: auto-refresh batch failed for "${dir}"`,
              err
            );
            // Leave the bookkeeping mirrors untouched so the next tick
            // sees the same starting state and tries again.
            continue;
          }
          mutated = true;

          // Apply the matching mirror updates only after the batch lands
          // in the model. The cascade cleanup below mirrors the
          // `recursive: true` removal semantics so descendants we were
          // tracking don't linger in `loadedPaths` or `knownDirs`.
          for (const r of removals) {
            loadedPaths.delete(r);
          }
          for (const removedDir of directoryRemovals) {
            knownDirs.delete(removedDir);
            const descendantPaths: string[] = [];
            for (const lp of loadedPaths) {
              if (lp.startsWith(removedDir)) {
                descendantPaths.push(lp);
              }
            }
            for (const lp of descendantPaths) {
              loadedPaths.delete(lp);
            }
            const descendantDirs: string[] = [];
            knownDirs.forEach((_, kd) => {
              if (kd !== ROOT_LOAD_KEY && kd.startsWith(removedDir)) {
                descendantDirs.push(kd);
              }
            });
            for (const kd of descendantDirs) {
              knownDirs.delete(kd);
            }
          }
          for (const a of additions) {
            loadedPaths.add(a);
          }
        }

        // Register newly-observed subdirectories so the next user expand
        // triggers a fetch instead of being ignored.
        for (const subdir of fetched.subdirectories) {
          if (!knownDirs.has(subdir)) {
            knownDirs.set(subdir, 'unloaded');
          }
        }
      }

      if (mutated) {
        syncGitStatus();
      }
    };

    /**
     * Reveal {@link canonicalPath} in the tree: load any unloaded
     * ancestor directories, expand them, and select the target so it is
     * scrolled into view. Tolerant of partially-loaded state so the
     * editor breadcrumbs can call it on any path at any time without
     * caring about what the tree has already fetched.
     *
     * Each ancestor is awaited *before* it is expanded — expanding a
     * directory triggers the model's subscribe callback, which
     * synchronously sets the directory's load state to `loading` and
     * kicks off its own fetch in parallel. Awaiting that in-flight
     * fetch would return immediately on the second await, leaving the
     * children unloaded when we move to the next iteration.
     */
    /**
     * Clear the tree selection and scroll back to the top. Invoked by
     * the file browser widget's `scrollToRoot` method when the home
     * crumb is clicked; gives that gesture visible feedback even when
     * the sidebar is already focused on the file browser.
     */
    const goToRoot = (): void => {
      if (cancelled) {
        return;
      }
      for (const selected of model.getSelectedPaths()) {
        model.getItem(selected)?.deselect();
      }
      const container = model.getFileTreeContainer();
      if (container !== undefined) {
        container.scrollTop = 0;
      }
    };

    /**
     * Collapse every currently expanded directory in the tree. Walks the
     * `knownDirs` map (the canonical record of which directories have been
     * observed in the tree) and calls `.collapse()` on each loaded
     * directory whose handle reports `isExpanded()`. Unloaded directories
     * are not expanded by definition, so they're skipped.
     */
    const collapseAll = (): void => {
      if (cancelled) {
        return;
      }
      knownDirs.forEach((state, path) => {
        if (path === ROOT_LOAD_KEY || state !== 'loaded') {
          return;
        }
        const item = model.getItem(path);
        if (item === null || !item.isDirectory()) {
          return;
        }
        const handle = item as FileTreeDirectoryHandle;
        if (handle.isExpanded()) {
          handle.collapse();
        }
      });
    };

    const revealPath = async (canonicalPath: string): Promise<void> => {
      if (cancelled || canonicalPath.length === 0) {
        return;
      }

      const isDir = canonicalPath.endsWith('/');
      const trimmed = isDir ? canonicalPath.slice(0, -1) : canonicalPath;
      const segments = trimmed.split('/').filter(s => s.length > 0);
      if (segments.length === 0) {
        return;
      }

      // Build the ordered list of ancestor directory canonical paths.
      // For "foo/bar/baz.txt" → ["foo/", "foo/bar/"].
      // For "foo/bar/"       → ["foo/"].
      const ancestors: string[] = [];
      let cumulative = '';
      for (let i = 0; i < segments.length - 1; i++) {
        cumulative += `${segments[i]}/`;
        ancestors.push(cumulative);
      }

      await fetchDirectory(ROOT_LOAD_KEY);
      if (cancelled) {
        return;
      }

      for (const ancestor of ancestors) {
        await fetchDirectory(ancestor);
        if (cancelled) {
          return;
        }
        const item = model.getItem(ancestor);
        if (item === null || !item.isDirectory()) {
          return;
        }
        const handle = item as FileTreeDirectoryHandle;
        if (!handle.isExpanded()) {
          handle.expand();
        }
      }

      if (isDir) {
        await fetchDirectory(canonicalPath);
        if (cancelled) {
          return;
        }
      }

      const target = model.getItem(canonicalPath);
      if (target === null) {
        return;
      }
      if (
        target.isDirectory() &&
        !(target as FileTreeDirectoryHandle).isExpanded()
      ) {
        (target as FileTreeDirectoryHandle).expand();
      }

      for (const selected of model.getSelectedPaths()) {
        if (selected === canonicalPath) {
          continue;
        }
        const previous = model.getItem(selected);
        previous?.deselect();
      }
      target.select();
      // `select` highlights the row; `scrollToPath` focuses it and scrolls it
      // to the middle of the viewport, even when the row is virtualized out of
      // the rendered window.
      model.scrollToPath(canonicalPath, { focus: true, offset: 'center' });
    };

    /**
     * Insert a newly-created path (typically from "new folder" or
     * "duplicate") into the tree without doing a full refresh. Expands
     * the parent so the user sees the newly created entry immediately.
     */
    const handlePathAdded = (canonicalPath: string): void => {
      if (model.getItem(canonicalPath) === null) {
        try {
          model.add(canonicalPath);
        } catch (err) {
          console.error(`xtralab: failed to add path "${canonicalPath}"`, err);
          return;
        }
      }
      loadedPaths.add(canonicalPath);
      if (canonicalPath.endsWith('/') && !knownDirs.has(canonicalPath)) {
        // The new directory has no children yet, so mark it as already
        // loaded — there's nothing to fetch and we don't want a stale
        // "unloaded" entry to trigger a fetch on the next expand.
        knownDirs.set(canonicalPath, 'loaded');
      }
      syncGitStatus();
      const parent = parentOf(canonicalPath);
      if (parent === ROOT_LOAD_KEY) {
        return;
      }
      const parentItem = model.getItem(parent);
      if (parentItem === null || !parentItem.isDirectory()) {
        return;
      }
      const parentDir = parentItem as FileTreeDirectoryHandle;
      if (!parentDir.isExpanded()) {
        parentDir.expand();
      }
    };

    /**
     * Re-key the load-state mirrors after the tree model moved
     * `fromPath` to `toPath`; a moved directory rewrites every entry
     * under its old prefix.
     */
    const rekeyMirrors = (fromPath: string, toPath: string): void => {
      if (fromPath.endsWith('/')) {
        for (const path of [...loadedPaths]) {
          if (path.startsWith(fromPath)) {
            loadedPaths.delete(path);
            loadedPaths.add(`${toPath}${path.slice(fromPath.length)}`);
          }
        }
        for (const [dir, state] of [...knownDirs.entries()]) {
          if (dir !== ROOT_LOAD_KEY && dir.startsWith(fromPath)) {
            knownDirs.delete(dir);
            knownDirs.set(`${toPath}${dir.slice(fromPath.length)}`, state);
          }
        }
      } else if (loadedPaths.delete(fromPath)) {
        loadedPaths.add(toPath);
      }
    };

    /**
     * Rename through the document manager, so collisions surface the
     * standard overwrite dialog and open widgets follow their file.
     * Resolves false when the move did not happen — a declined
     * overwrite (upstream's 'File not renamed' sentinel) or a failure.
     */
    const renameOnServer = async (
      fromPath: string,
      toPath: string
    ): Promise<boolean> => {
      try {
        await renameFile(
          docManager,
          toServerPath(fromPath),
          toServerPath(toPath)
        );
        return true;
      } catch (err) {
        if (err !== 'File not renamed') {
          await showErrorMessage(trans.__('Move failed'), err as Error);
        }
        return false;
      }
    };

    /**
     * Persist moves the tree model already applied. A move that did
     * not reach the disk leaves the tree out of step, so a full
     * refresh then restores server truth.
     */
    const persistDropMoves = async (moves: IDropMove[]): Promise<void> => {
      let failed = false;
      for (const move of moves) {
        if (!(await renameOnServer(move.from, move.to))) {
          failed = true;
        }
        if (cancelled) {
          return;
        }
      }
      if (failed) {
        void refreshAll();
      }
    };

    const completeDrop = (result: FileTreeDropResult): void => {
      if (cancelled) {
        return;
      }
      const moves = computeDropMoves(result);
      for (const move of moves) {
        rekeyMirrors(move.from, move.to);
      }
      syncGitStatus();
      void persistDropMoves(moves);
    };

    /**
     * Server-side renames for moves the tree model did not apply; the
     * `fileChanged` signals nudge the listing poll to reconcile.
     */
    const persistFallbackMoves = async (moves: IDropMove[]): Promise<void> => {
      for (const move of moves) {
        await renameOnServer(move.from, move.to);
        if (cancelled) {
          return;
        }
      }
    };

    /**
     * The tree refused the drop and left its model untouched — almost
     * always a name collision at the destination.
     */
    const failedDrop = (error: string, context: FileTreeDropContext): void => {
      if (cancelled) {
        return;
      }
      const moves = computeDropMoves(context);
      if (moves.length === 0) {
        console.error('xtralab: drop failed', error);
        return;
      }
      void persistFallbackMoves(moves);
    };

    /**
     * Move the dragged paths to the workspace root: apply to the model
     * first so the rows relocate instantly, then persist. A path the
     * model cannot move (name collision) falls back to the server-side
     * rename and its dialog.
     */
    const dropOnRoot = (draggedPaths: readonly string[]): void => {
      if (cancelled) {
        return;
      }
      const applied: IDropMove[] = [];
      const fallback: IDropMove[] = [];
      for (const move of computeRootDropMoves(draggedPaths)) {
        try {
          model.move(move.from, move.to);
          rekeyMirrors(move.from, move.to);
          applied.push(move);
        } catch {
          fallback.push(move);
        }
      }
      if (applied.length > 0) {
        syncGitStatus();
        void persistDropMoves(applied);
      }
      if (fallback.length > 0) {
        void persistFallbackMoves(fallback);
      }
    };

    dropHandlerRef.current = { completeDrop, failedDrop, dropOnRoot };

    knownDirs.set(ROOT_LOAD_KEY, 'unloaded');
    void fetchDirectory(ROOT_LOAD_KEY);
    void refreshGitignoreMatcher();
    const gitStatusPoll = new Poll({
      name: '@xtralab/fileBrowser:gitStatus',
      factory: () => refreshGitStatus(),
      frequency: {
        interval: GIT_STATUS_POLL_INTERVAL_MS,
        backoff: true,
        max: GIT_STATUS_POLL_MAX_MS
      },
      standby: 'when-hidden'
    });

    // Auto-refresh the file listing on the same cadence as the default
    // JupyterLab file browser. Backoff on failures so a server-side
    // outage doesn't hammer the API, and stand by when the tab is
    // hidden so we don't run the polling loop while the user is in
    // another tab. `auto: false` keeps the first tick from racing the
    // initial `fetchDirectory(ROOT_LOAD_KEY)` above — the poll is
    // started explicitly once the initial load is in flight.
    const listingPoll = new Poll({
      auto: false,
      name: '@xtralab/fileBrowser:listing',
      factory: () => quietRefresh(),
      frequency: {
        interval: FILE_LISTING_REFRESH_INTERVAL_MS,
        backoff: true,
        max: FILE_LISTING_REFRESH_MAX_MS
      },
      standby: 'when-hidden'
    });
    void listingPoll.start();

    // Surface contents changes that happen inside JupyterLab (file save,
    // rename, delete) without waiting for the next poll tick. The
    // default file browser uses the same `fileChanged` signal for the
    // same reason. We can't tell from the signal alone whether the
    // change affects a path we're showing, so we just nudge the poll —
    // it diffs the loaded directories and emits no batch ops when
    // nothing relevant changed.
    const onContentsFileChanged = (): void => {
      void listingPoll.refresh();
    };
    contentsManager.fileChanged.connect(onContentsFileChanged);

    const unsubscribe = model.subscribe(() => {
      // Search-driven expansion must not trigger fetches: the tree
      // auto-expands every directory whose path matches the query, and
      // treating those as user expansions would recursively fetch every
      // matching subtree — a single common letter can walk the whole
      // workspace, node_modules included. Closing the search restores
      // the pre-search expansion state, and a directory clicked in the
      // results is toggled after the session closes, so real expansions
      // are still fetched the moment the session ends.
      if (model.isSearchOpen()) {
        return;
      }
      knownDirs.forEach((state, canonicalPath) => {
        if (state !== 'unloaded') {
          return;
        }
        if (canonicalPath === ROOT_LOAD_KEY) {
          return;
        }
        const item = model.getItem(canonicalPath);
        if (
          item !== null &&
          item.isDirectory() &&
          (item as FileTreeDirectoryHandle).isExpanded()
        ) {
          void fetchDirectory(canonicalPath);
        }
      });
    });

    let refreshSlot: (() => void) | undefined;
    let pathAddedSlot: ((sender: unknown, path: string) => void) | undefined;
    let revealSlot: ((sender: unknown, path: string) => void) | undefined;
    let rootSlot: (() => void) | undefined;
    let collapseAllSlot: (() => void) | undefined;
    if (widget !== undefined) {
      refreshSlot = (): void => {
        void refreshAll();
      };
      pathAddedSlot = (_sender, path): void => {
        handlePathAdded(path);
      };
      revealSlot = (_sender, path): void => {
        void revealPath(path);
      };
      rootSlot = (): void => {
        goToRoot();
      };
      collapseAllSlot = (): void => {
        collapseAll();
      };
      widget.refreshRequested.connect(refreshSlot);
      widget.pathAdded.connect(pathAddedSlot);
      widget.revealRequested.connect(revealSlot);
      widget.rootRequested.connect(rootSlot);
      widget.collapseAllRequested.connect(collapseAllSlot);
    }

    return () => {
      cancelled = true;
      dropHandlerRef.current = null;
      gitStatusPoll.dispose();
      contentsManager.fileChanged.disconnect(onContentsFileChanged);
      listingPoll.dispose();
      unsubscribe();
      if (widget !== undefined) {
        if (refreshSlot !== undefined) {
          widget.refreshRequested.disconnect(refreshSlot);
        }
        if (pathAddedSlot !== undefined) {
          widget.pathAdded.disconnect(pathAddedSlot);
        }
        if (revealSlot !== undefined) {
          widget.revealRequested.disconnect(revealSlot);
        }
        if (rootSlot !== undefined) {
          widget.rootRequested.disconnect(rootSlot);
        }
        if (collapseAllSlot !== undefined) {
          widget.collapseAllRequested.disconnect(collapseAllSlot);
        }
      }
    };
  }, [model, contentsManager, widget, docManager, trans]);

  // Bridge the tree's selection state up to the widget so command handlers
  // can read it without depending on React internals. The tree exposes its
  // selection through `getSelectedPaths()` and emits a generic notification
  // through `subscribe`, so we diff against a snapshot to avoid spamming the
  // widget on every unrelated mutation.
  React.useEffect(() => {
    if (widget === undefined) {
      return;
    }
    let lastSnapshot: readonly string[] = [];
    const sync = (): void => {
      const next = model.getSelectedPaths();
      if (
        next.length === lastSnapshot.length &&
        next.every((path, index) => path === lastSnapshot[index])
      ) {
        return;
      }
      lastSnapshot = next;
      widget.updateSelection(next);
    };
    sync();
    const unsubscribe = model.subscribe(sync);
    return () => {
      unsubscribe();
    };
  }, [model, widget]);

  // Bridge the filter-box visibility between the widget and the tree. The
  // widget owns the flag; applying it stamps the marker attribute the
  // unsafeCSS rule keys on and opens or closes the model's search session
  // (opening focuses the input, closing clears any active filter). The
  // model subscription covers the reverse direction: typing a printable
  // character while the tree has focus opens a session on the tree's own
  // initiative, and the box must surface for that session to be usable.
  React.useEffect(() => {
    if (widget === undefined) {
      return;
    }
    const apply = (visible: boolean): void => {
      const host = model.getFileTreeContainer();
      if (host !== undefined) {
        if (visible) {
          host.dataset.xtralabFilterVisible = 'true';
        } else {
          delete host.dataset.xtralabFilterVisible;
        }
      }
      if (visible && !model.isSearchOpen()) {
        model.openSearch();
      } else if (!visible && model.isSearchOpen()) {
        model.closeSearch();
      }
    };
    apply(widget.fileFilterVisible);
    const visibleSlot = (sender: unknown, visible: boolean): void => {
      apply(visible);
    };
    widget.fileFilterVisibleChanged.connect(visibleSlot);
    const unsubscribe = model.subscribe(() => {
      if (model.isSearchOpen() && !widget.fileFilterVisible) {
        widget.setFileFilterVisible(true);
      }
    });
    return () => {
      widget.fileFilterVisibleChanged.disconnect(visibleSlot);
      unsubscribe();
    };
  }, [model, widget]);

  const wrapperRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null || onOpenFile === undefined) {
      return;
    }
    const handleDoubleClick = (event: MouseEvent): void => {
      for (const target of event.composedPath()) {
        if (!(target instanceof HTMLElement)) {
          continue;
        }
        if (target.dataset.type !== 'item') {
          continue;
        }
        if (target.dataset.itemType !== 'file') {
          return;
        }
        const itemPath = target.dataset.itemPath;
        if (itemPath !== undefined && itemPath.length > 0) {
          event.preventDefault();
          onOpenFile(toServerPath(itemPath));
        }
        return;
      }
    };
    wrapper.addEventListener('dblclick', handleDoubleClick);
    return () => {
      wrapper.removeEventListener('dblclick', handleDoubleClick);
    };
  }, [onOpenFile]);

  // Bridge contextmenu events out of the `<file-tree-container>` shadow DOM.
  //
  // `@pierre/trees` mounts the tree under an open shadow root attached to the
  // `<file-tree-container>` custom element. When the user right-clicks a row
  // inside the shadow tree, the event is retargeted to the host element when
  // observed from the light DOM, and `app.contextMenu` walks via
  // `parentElement` — it never enters the shadow tree, so the `[data-type=
  // "item"]` selectors registered in `schema/plugin.json` never match.
  //
  // We listen in the capture phase (so we run before the application's
  // document-level handler) and copy the right-clicked row's data attributes
  // onto the host. Lumino then matches the host as if it were the row, and
  // `app.contextMenuHitTest` from command handlers reads the same attributes
  // back to recover the path. When the right-click misses any row we clear
  // the attributes so empty-area clicks don't show stale per-item entries.
  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) {
      return;
    }
    const handleContextMenu = (event: MouseEvent): void => {
      let host: HTMLElement | null = null;
      let rowItem: HTMLElement | null = null;
      for (const target of event.composedPath()) {
        if (!(target instanceof HTMLElement)) {
          continue;
        }
        if (host === null && target.tagName.toLowerCase() === FILE_TREE_TAG) {
          host = target;
        }
        if (rowItem === null && target.dataset.type === 'item') {
          rowItem = target;
        }
        if (host !== null && rowItem !== null) {
          break;
        }
      }
      if (host === null) {
        return;
      }
      if (rowItem !== null) {
        host.dataset.type = 'item';
        host.dataset.itemType = rowItem.dataset.itemType ?? '';
        host.dataset.itemPath = rowItem.dataset.itemPath ?? '';
      } else {
        delete host.dataset.type;
        delete host.dataset.itemType;
        delete host.dataset.itemPath;
      }
    };
    wrapper.addEventListener('contextmenu', handleContextMenu, true);
    return () => {
      wrapper.removeEventListener('contextmenu', handleContextMenu, true);
    };
  }, []);

  useRootDropZone({ model, handlerRef: dropHandlerRef, wrapperRef });

  return (
    <div
      ref={wrapperRef}
      style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}
    >
      <FileTree model={model} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
