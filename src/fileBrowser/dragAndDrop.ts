import * as React from 'react';

import type {
  FileTree,
  FileTreeDragAndDropConfig,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeDropTarget
} from '@pierre/trees';

import { ROOT_LOAD_KEY, canonicalBasename, parentOf } from './contents';

/**
 * One tree-model move a drop performs, as canonical paths.
 */
export interface IDropMove {
  from: string;
  to: string;
}

/**
 * Receives drop outcomes from the `@pierre/trees` drag-and-drop
 * machinery. Implemented inside the file browser's contents-sync
 * effect, which owns the load-state and contents-API bookkeeping.
 */
export interface ITreeDropHandler {
  /**
   * The tree applied the drop to its model: persist the move and
   * re-key the load-state mirrors.
   */
  completeDrop(result: FileTreeDropResult): void;

  /**
   * The tree refused the drop (typically a name collision) and left
   * its model untouched.
   */
  failedDrop(error: string, context: FileTreeDropContext): void;

  /**
   * A drop on the empty space below the last row: move the dragged
   * paths to the workspace root.
   */
  dropOnRoot(draggedPaths: readonly string[]): void;
}

/**
 * The from→to moves a drop performs: each dragged path keeps its
 * basename under the target directory. Paths already directly inside
 * the target are skipped.
 */
export function computeDropMoves(context: FileTreeDropContext): IDropMove[] {
  const dir = context.target.directoryPath ?? ROOT_LOAD_KEY;
  return context.draggedPaths
    .filter(path => parentOf(path) !== dir)
    .map(path => ({ from: path, to: `${dir}${canonicalBasename(path)}` }));
}

/**
 * The drop target the tree reports for a move to the workspace root.
 */
const ROOT_DROP_TARGET: FileTreeDropTarget = {
  directoryPath: null,
  flattenedSegmentPath: null,
  hoveredPath: null,
  kind: 'root'
};

/**
 * The moves for a drop of `paths` onto the workspace root.
 */
export function computeRootDropMoves(paths: readonly string[]): IDropMove[] {
  return computeDropMoves({ draggedPaths: paths, target: ROOT_DROP_TARGET });
}

/**
 * Build the `dragAndDrop` option for `useFileTree`. The tree captures
 * its options once, so the callbacks delegate through `handlerRef`,
 * filled by the contents-sync effect. `canDrop` hides the drop
 * highlight for all-no-op drops, which the library would accept.
 */
export function createTreeDragAndDropConfig(
  handlerRef: React.RefObject<ITreeDropHandler | null>
): FileTreeDragAndDropConfig {
  return {
    canDrop: context => computeDropMoves(context).length > 0,
    onDropComplete: result => {
      handlerRef.current?.completeDrop(result);
    },
    onDropError: (error, context) => {
      handlerRef.current?.failedDrop(error, context);
    }
  };
}

interface IRootDropZoneOptions {
  model: FileTree;
  handlerRef: React.RefObject<ITreeDropHandler | null>;
  /**
   * The light-DOM wrapper around the tree host; composed drag events
   * bubble out of the shadow root to it.
   */
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Accept drops on the empty space below the last row as moves to the
 * workspace root — the tree resolves a drop target only while the cursor
 * is over a row and silently discards such drops.
 */
export function useRootDropZone(options: IRootDropZoneOptions): void {
  const { model, handlerRef, wrapperRef } = options;

  React.useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null) {
      return;
    }

    let draggedPaths: readonly string[] | null = null;

    const findRow = (event: DragEvent): HTMLElement | null => {
      for (const target of event.composedPath()) {
        if (target instanceof HTMLElement && target.dataset.type === 'item') {
          return target;
        }
      }
      return null;
    };

    const handleDragStart = (event: DragEvent): void => {
      draggedPaths = null;
      // The tree cancels dragstart when it refuses a session, e.g.
      // while the filter is open.
      if (event.defaultPrevented) {
        return;
      }
      const path = findRow(event)?.dataset.itemPath;
      if (path === undefined || path.length === 0) {
        return;
      }
      // The selection is the dragged set (the tree selects the pressed
      // row); entries nested under a dragged folder travel with it.
      const selection = model.getSelectedPaths();
      const candidates = selection.includes(path) ? selection : [path];
      const folders = candidates.filter(c => c.endsWith('/'));
      draggedPaths = candidates.filter(
        c => !folders.some(folder => folder !== c && c.startsWith(folder))
      );
    };

    const handleDrop = (event: DragEvent): void => {
      const paths = draggedPaths;
      draggedPaths = null;
      // Drops on a row were already resolved by the tree itself.
      if (paths === null || findRow(event) !== null) {
        return;
      }
      event.preventDefault();
      handlerRef.current?.dropOnRoot(paths);
    };

    const handleDragEnd = (): void => {
      draggedPaths = null;
    };

    wrapper.addEventListener('dragstart', handleDragStart);
    wrapper.addEventListener('drop', handleDrop);
    window.addEventListener('dragend', handleDragEnd);
    return () => {
      wrapper.removeEventListener('dragstart', handleDragStart);
      wrapper.removeEventListener('drop', handleDrop);
      window.removeEventListener('dragend', handleDragEnd);
      draggedPaths = null;
    };
  }, [model, handlerRef, wrapperRef]);
}
