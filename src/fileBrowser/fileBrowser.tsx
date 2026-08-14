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

type LoadState = 'unloaded' | 'loading' | 'loaded';

/**
 * Git status poll cadence, aligned with the git panel's polling so both
 * views update on the same rhythm.
 */
const GIT_STATUS_POLL_INTERVAL_MS = 5000;

const GIT_STATUS_POLL_MAX_MS = 300_000;

/**
 * Listing auto-refresh cadence; matches the default file browser's
 * `DEFAULT_REFRESH_INTERVAL` for picking up out-of-band file changes.
 */
const FILE_LISTING_REFRESH_INTERVAL_MS = 10000;

const FILE_LISTING_REFRESH_MAX_MS = 300_000;

/**
 * Repo path for `/git/*` calls; empty means the server root, letting git
 * resolve the enclosing repo (same convention as the git panel).
 */
const GIT_REPO_PATH = '';

const FILE_TREE_TAG = 'file-tree-container';

/**
 * Injected into the tree's shadow root, where outside CSS cannot reach.
 * The search box is hidden unless the host carries the filter-bridge marker
 * (the library always renders it), and the drag-hover row gets a quiet ring
 * — the library's selection background is illegible with xtralab's colors.
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
  widget?: XtralabFileBrowser;
}

/**
 * A `@pierre/trees` file tree backed by the Jupyter contents API. The API
 * returns one directory level per request, so directories load lazily on
 * first expand, detected by diffing the model against a load-state map.
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
    // Mirror of the loaded canonical paths — the model has no path-iteration
    // API, and the gitignore matcher must re-test every loaded path.
    const loadedPaths = new Set<string>();
    let gitignoreMatcher: Ignore | null = null;
    let gitStatusEntries: readonly GitStatusEntry[] = [];
    let cancelled = false;

    /**
     * Push the combined gitignore + porcelain entries into the tree.
     * Ignored entries go first so porcelain entries win on overlap —
     * `@pierre/trees` lets later entries overwrite earlier ones.
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
          // The path-store throws when a path is added twice, and entries
          // can arrive out-of-band (e.g. `notifyPathAdded`), so skip those.
          const operations: FileTreeBatchOperation[] = paths
            .filter(path => model.getItem(path) === null)
            .map(path => ({ type: 'add', path }));
          if (operations.length > 0) {
            model.batch(operations);
          }
          // Paths skipped above are already in the model from a prior add,
          // so they belong in the mirror too.
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
     * Re-fetch the root and every previously-expanded directory so the tree
     * mirrors the disk while preserving the user's expansion state.
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

      // Fetch only the previously-expanded subtree so the refresh doesn't
      // walk the entire workspace.
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

      // Each re-applies the statuses itself when it completes.
      void refreshGitignoreMatcher();
      void refreshGitStatus();

      // `resetPaths` starts every directory collapsed, so re-expand after it.
      for (const path of expandedPaths) {
        const item = model.getItem(path);
        if (item !== null && item.isDirectory()) {
          (item as FileTreeDirectoryHandle).expand();
        }
      }
    };

    /**
     * Auto-refresh tick: diff every loaded directory and apply batched
     * mutations without `resetPaths`, so expansion, selection, and scroll
     * state survive. A failed fetch is skipped as transient; a deleted
     * directory surfaces through its parent's diff and is removed recursively.
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
        // The cascade cleanup below can prune subtrees mid-tick, so a dir
        // captured at the start may already be gone.
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
            // Leave the mirrors untouched so the next tick retries.
            continue;
          }
          mutated = true;

          // Mirror updates only after the batch lands; the cascade below
          // mirrors the `recursive: true` removal semantics.
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

        // Untracked subdirectories would ignore their first expand.
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
     * Clear the selection and scroll to the top; gives the home-crumb
     * gesture visible feedback even when the sidebar is already focused.
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

    /**
     * Reveal `canonicalPath`: fetch and expand ancestors, then select and
     * scroll to the target. Each ancestor is fetched *before* expanding —
     * expansion starts the subscribe callback's own fetch, and awaiting that
     * in-flight fetch resolves with the children still unloaded.
     */
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

      // "foo/bar/baz.txt" → ["foo/", "foo/bar/"].
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
      // `scrollToPath` focuses and scrolls even when the row is virtualized
      // out of the rendered window.
      model.scrollToPath(canonicalPath, { focus: true, offset: 'center' });
    };

    /**
     * Insert a newly-created path without a full refresh and expand its
     * parent so the entry is visible immediately.
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
        // A new directory has no children; mark it loaded so a stale
        // "unloaded" entry doesn't trigger a fetch on the next expand.
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

    // `auto: false` keeps the first tick from racing the initial root
    // fetch above; the poll is started explicitly below.
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

    // In-app contents changes (save, rename, delete) nudge the poll; the
    // signal doesn't say whether a shown path is affected, the diff does.
    const onContentsFileChanged = (): void => {
      void listingPoll.refresh();
    };
    contentsManager.fileChanged.connect(onContentsFileChanged);

    const unsubscribe = model.subscribe(() => {
      // Search auto-expands every matching directory — fetching those would
      // walk whole subtrees (node_modules included); real expansions still
      // fetch once the search session closes.
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

  // Bridge the tree selection up to the widget. `subscribe` fires on every
  // mutation, so diff against a snapshot before notifying.
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

  // Applying the widget's filter flag stamps the marker the unsafeCSS rule
  // keys on and syncs the search session; the subscription surfaces the box
  // when the tree opens a session itself (typing while focused).
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

  // Lumino never enters the tree's shadow DOM, so the `[data-type="item"]`
  // selectors can't match rows; mirror the right-clicked row's data
  // attributes onto the host (capture phase, cleared on a miss).
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
