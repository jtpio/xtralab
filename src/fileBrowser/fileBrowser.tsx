import * as React from 'react';

import { IDocumentManager } from '@jupyterlab/docmanager';
import { Contents } from '@jupyterlab/services';
import { fileIcon } from '@jupyterlab/ui-components';
import { MimeData, PromiseDelegate } from '@lumino/coreutils';
import { Drag } from '@lumino/dragdrop';
import { Poll } from '@lumino/polling';

import { FileTree, useFileTree } from '@pierre/trees/react';
import type {
  FileTreeBatchOperation,
  FileTreeDirectoryHandle,
  GitStatusEntry
} from '@pierre/trees';

import type { Ignore } from 'ignore';

import { ROOT_LOAD_KEY, listDirectory, toServerPath } from './contents';
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
 * MIME types used by the dock panel and other JupyterLab drop targets.
 * `FACTORY_MIME` is the lumino dock-panel contract: the value must be a
 * synchronous function that returns a Widget. The contents MIME types
 * mirror what the default file browser sends so other drop targets that
 * understand them (the file browser itself, custom drop zones) keep
 * working when the user drags out of xtralab.
 */
const FACTORY_MIME = 'application/vnd.lumino.widget-factory';
const CONTENTS_MIME = 'application/x-jupyter-icontents';

/**
 * Threshold in pixels before a press-and-drag is treated as a drag rather
 * than a click. Matches the value used by the default JupyterLab listing.
 */
const DRAG_THRESHOLD = 5;

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

const FILE_TREE_UNSAFE_CSS =
  '[data-type="item"][data-item-selected="true"] ' +
  '[data-item-section="spacing-item"] {' +
  'border-left-color: transparent;' +
  '}';

export interface IFileBrowserProps {
  contentsManager: Contents.IManager;
  docManager: IDocumentManager;
  onOpenFile?: (serverPath: string) => void;
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
  const { contentsManager, docManager, onOpenFile, widget } = props;

  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'closed',
    search: true,
    icons: FILE_BROWSER_ICONS,
    itemHeight: 24,
    unsafeCSS: FILE_TREE_UNSAFE_CSS
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
     * Compute the canonical parent path for a given canonical path.
     * Returns {@link ROOT_LOAD_KEY} for top-level entries.
     */
    const parentOf = (canonicalPath: string): string => {
      const trimmed = canonicalPath.endsWith('/')
        ? canonicalPath.slice(0, -1)
        : canonicalPath;
      const idx = trimmed.lastIndexOf('/');
      if (idx < 0) {
        return ROOT_LOAD_KEY;
      }
      return `${trimmed.slice(0, idx)}/`;
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
  }, [model, contentsManager, widget]);

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

  // Drag a file row out of the tree onto the JupyterLab main area. The row
  // lives in the `@pierre/trees` shadow DOM, so we listen to mousedown on
  // the wrapper and walk `composedPath()` to recover the row. The drag
  // payload uses Lumino's `FACTORY_MIME` contract: the dock panel calls the
  // factory function on drop and adds the returned widget to its layout.
  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) {
      return;
    }

    let press: { x: number; y: number; path: string } | null = null;
    let activeDrag: Drag | null = null;

    const findRow = (event: MouseEvent): HTMLElement | null => {
      for (const target of event.composedPath()) {
        if (!(target instanceof HTMLElement)) {
          continue;
        }
        if (target.dataset.type === 'item') {
          return target;
        }
      }
      return null;
    };

    const cleanup = (): void => {
      press = null;
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
    };

    const handleMouseDown = (event: MouseEvent): void => {
      // Only react to the primary button. Do not interfere with right-click
      // (handled by the contextmenu bridge) or middle-click (browser default).
      if (event.button !== 0) {
        return;
      }
      if (activeDrag !== null) {
        return;
      }
      const row = findRow(event);
      if (row === null || row.dataset.itemType !== 'file') {
        return;
      }
      const itemPath = row.dataset.itemPath;
      if (itemPath === undefined || itemPath.length === 0) {
        return;
      }
      press = { x: event.clientX, y: event.clientY, path: itemPath };
      document.addEventListener('mousemove', handleMouseMove, true);
      document.addEventListener('mouseup', handleMouseUp, true);
    };

    const handleMouseMove = (event: MouseEvent): void => {
      if (press === null) {
        return;
      }
      const dx = Math.abs(event.clientX - press.x);
      const dy = Math.abs(event.clientY - press.y);
      if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) {
        return;
      }
      const startedFrom = press;
      cleanup();
      startDrag(startedFrom.path, event.clientX, event.clientY);
    };

    const handleMouseUp = (): void => {
      cleanup();
    };

    /**
     * Build the list of file paths to drag. If the user pressed on a row
     * that is part of the current selection, drag every selected file.
     * Otherwise, drag just the row that was pressed. Folders never join a
     * drag-out — they have no docmanager widget to open.
     */
    const collectDragPaths = (sourcePath: string): string[] => {
      const selection = model.getSelectedPaths();
      const sourceInSelection = selection.includes(sourcePath);
      const candidates = sourceInSelection ? selection : [sourcePath];
      const fileServerPaths: string[] = [];
      for (const candidate of candidates) {
        if (candidate.endsWith('/')) {
          continue;
        }
        fileServerPaths.push(toServerPath(candidate));
      }
      // The source row is always a file, so the list cannot be empty.
      if (fileServerPaths.length === 0) {
        fileServerPaths.push(toServerPath(sourcePath));
      }
      return fileServerPaths;
    };

    const startDrag = (
      sourcePath: string,
      clientX: number,
      clientY: number
    ): void => {
      const paths = collectDragPaths(sourcePath);
      const sourceServerPath = toServerPath(sourcePath);

      const dragImage = createDragImage(paths.length);

      const drag = new Drag({
        dragImage,
        mimeData: new MimeData(),
        supportedActions: 'copy-move',
        proposedAction: 'move'
      });

      drag.mimeData.setData(CONTENTS_MIME, paths);

      // The factory is called by the lumino dock panel on drop. It must
      // return a Widget synchronously. For multi-file drags we open the
      // remaining files asynchronously after the first one is placed,
      // mirroring the default file browser's behavior.
      const otherPaths = paths.filter(p => p !== sourceServerPath);
      drag.mimeData.setData(FACTORY_MIME, () => {
        let widget = docManager.findWidget(sourceServerPath);
        if (widget === undefined) {
          widget = docManager.open(sourceServerPath);
        }
        if (otherPaths.length > 0) {
          const firstPlaced = new PromiseDelegate<void>();
          void firstPlaced.promise.then(() => {
            let prev = widget;
            for (const otherPath of otherPaths) {
              const opened = docManager.openOrReveal(
                otherPath,
                undefined,
                undefined,
                prev !== undefined
                  ? { ref: prev.id, mode: 'tab-after' }
                  : undefined
              );
              if (opened !== undefined) {
                prev = opened;
              }
            }
          });
          firstPlaced.resolve();
        }
        return widget;
      });

      activeDrag = drag;
      void drag.start(clientX, clientY).then(() => {
        activeDrag = null;
      });
    };

    wrapper.addEventListener('mousedown', handleMouseDown);
    return () => {
      wrapper.removeEventListener('mousedown', handleMouseDown);
      cleanup();
      activeDrag?.dispose();
      activeDrag = null;
    };
  }, [model, docManager]);

  return (
    <div
      ref={wrapperRef}
      style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}
    >
      <FileTree model={model} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}

/**
 * Build the small badge shown next to the cursor while dragging. The
 * default file browser renders a richer image with the file's icon, but
 * we don't have a per-file icon at this layer — just the count of files
 * being dragged is enough to give the user feedback.
 */
function createDragImage(count: number): HTMLElement {
  const node = document.createElement('div');
  node.className = 'jp-xtralab-DragImage';
  const iconWrapper = document.createElement('span');
  iconWrapper.className = 'jp-xtralab-DragImage-icon';
  fileIcon.element({ container: iconWrapper, stylesheet: 'menuItem' });
  node.appendChild(iconWrapper);
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'jp-xtralab-DragImage-count';
    badge.textContent = String(count);
    node.appendChild(badge);
  }
  return node;
}
