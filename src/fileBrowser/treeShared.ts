import * as React from 'react';

import type { FileTree as FileTreeModel } from '@pierre/trees';

import type { XtralabFileBrowser } from './widget';

/**
 * Injected into the tree's shadow root, where outside CSS cannot reach.
 * The search box is hidden unless the host carries the filter-bridge marker
 * (the library always renders it), and the drag-hover row gets a quiet ring
 * — the library's selection background is illegible with xtralab's colors.
 */
export const FILE_TREE_UNSAFE_CSS =
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

/**
 * Follow the widget's filter flag: stamp the marker the unsafeCSS rule keys
 * on and sync the search session; a session the tree opens itself (typing
 * while focused) shows the box.
 */
export function useFileFilterBridge(
  model: FileTreeModel,
  widget: XtralabFileBrowser | undefined
): void {
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
}

/**
 * Every folder that holds one of the paths, as tree directory ids.
 */
export function folderPaths(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      prefix += `${parts[i]}/`;
      folders.add(prefix);
    }
  }
  return Array.from(folders);
}
