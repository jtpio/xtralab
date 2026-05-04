import * as React from 'react';

import { IDocumentManager } from '@jupyterlab/docmanager';
import { Contents } from '@jupyterlab/services';
import { fileIcon } from '@jupyterlab/ui-components';
import { MimeData, PromiseDelegate } from '@lumino/coreutils';
import { Drag } from '@lumino/dragdrop';

import { FileTree, useFileTree } from '@pierre/trees/react';
import type {
  FileTreeBatchOperation,
  FileTreeDirectoryHandle
} from '@pierre/trees';

import { ROOT_LOAD_KEY, listDirectory, toServerPath } from './contents';
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
 * working when the user drags out of Xtralab.
 */
const FACTORY_MIME = 'application/vnd.lumino.widget-factory';
const CONTENTS_MIME = 'application/x-jupyter-icontents';

/**
 * Threshold in pixels before a press-and-drag is treated as a drag rather
 * than a click. Matches the value used by the default JupyterLab listing.
 */
const DRAG_THRESHOLD = 5;

/**
 * The custom-element tag used by `@pierre/trees` for its shadow host. Kept
 * as a constant rather than imported so we don't pay the `@pierre/trees`
 * resolution cost just for one string.
 */
const FILE_TREE_TAG = 'file-tree-container';

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
    icons: FILE_BROWSER_ICONS
  });

  React.useEffect(() => {
    const knownDirs = new Map<string, LoadState>();
    let cancelled = false;

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
        }
        for (const subdir of subdirectories) {
          if (!knownDirs.has(subdir)) {
            knownDirs.set(subdir, 'unloaded');
          }
        }
        knownDirs.set(canonicalPath, 'loaded');
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
      knownDirs.set(ROOT_LOAD_KEY, 'loaded');
      subdirsByParent.forEach(subdirs => {
        for (const subdir of subdirs) {
          knownDirs.set(
            subdir,
            expandedPaths.has(subdir) ? 'loaded' : 'unloaded'
          );
        }
      });

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
     * Insert a newly-created path (typically from "new folder" or
     * "duplicate") into the tree without doing a full refresh. Expands
     * the parent so the user sees the newly created entry immediately.
     */
    const handlePathAdded = (canonicalPath: string): void => {
      if (model.getItem(canonicalPath) === null) {
        try {
          model.add(canonicalPath);
        } catch (err) {
          console.error(
            `xtralab: failed to add path "${canonicalPath}"`,
            err
          );
          return;
        }
      }
      if (canonicalPath.endsWith('/') && !knownDirs.has(canonicalPath)) {
        // The new directory has no children yet, so mark it as already
        // loaded — there's nothing to fetch and we don't want a stale
        // "unloaded" entry to trigger a fetch on the next expand.
        knownDirs.set(canonicalPath, 'loaded');
      }
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
    if (widget !== undefined) {
      refreshSlot = (): void => {
        void refreshAll();
      };
      pathAddedSlot = (_sender, path): void => {
        handlePathAdded(path);
      };
      widget.refreshRequested.connect(refreshSlot);
      widget.pathAdded.connect(pathAddedSlot);
    }

    return () => {
      cancelled = true;
      unsubscribe();
      if (widget !== undefined) {
        if (refreshSlot !== undefined) {
          widget.refreshRequested.disconnect(refreshSlot);
        }
        if (pathAddedSlot !== undefined) {
          widget.pathAdded.disconnect(pathAddedSlot);
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
