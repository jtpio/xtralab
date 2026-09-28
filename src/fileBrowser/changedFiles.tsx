import * as React from 'react';

import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ToolbarButtonComponent } from '@jupyterlab/ui-components';
import type { FileTreeDirectoryHandle, GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';

import {
  fetchReviewBases,
  reviewStatusMessage,
  type IReviewBases,
  type ReviewModel,
  type ReviewScope
} from '../git/reviewModel';
import { ReviewScopeSelect } from '../git/reviewScope';
import type { ReviewMainAreaWidget } from '../git/reviewWidget';
import type { IReviewTracker } from '../git/tokens';
import { toServerPath } from './contents';
import { GIT_REPO_PATH, toGitStatusEntries, toTreeStatus } from './gitStatus';
import { FILE_BROWSER_ICONS } from './icons';
import {
  FILE_TREE_UNSAFE_CSS,
  folderPaths,
  useFileFilterBridge
} from './treeShared';
import type { XtralabFileBrowser } from './widget';

/**
 * Open a review tab, or change the scope of the open one.
 */
export type OpenReview = (args: {
  scope: ReviewScope;
  base: string | null;
}) => void;

/**
 * The props of {@link ChangedFilesTree}.
 */
interface IChangedFilesTreeProps {
  /**
   * The file browser that hosts the list.
   */
  widget: XtralabFileBrowser;
  /**
   * The open review tabs; the list shows the files of the current one.
   */
  reviewTracker: IReviewTracker | null;
  /**
   * Activate a main-area widget by id.
   */
  activateWidget?: (id: string) => void;
  /**
   * Open a review tab, or change the scope of the open one.
   */
  openReview?: OpenReview;
  /**
   * Called with the server path of a double-clicked file.
   */
  onOpenFile?: (serverPath: string) => void;
  /**
   * The application translation bundle.
   */
  trans: TranslationBundle;
}

/**
 * The review tab the list follows: the current one of the tracker.
 */
function useCurrentReview(
  tracker: IReviewTracker | null
): ReviewMainAreaWidget | null {
  const [review, setReview] = React.useState<ReviewMainAreaWidget | null>(
    () => tracker?.currentWidget ?? null
  );
  React.useEffect(() => {
    if (tracker === null) {
      return;
    }
    const sync = (): void => {
      const current = tracker.currentWidget;
      setReview(current !== null && !current.isDisposed ? current : null);
    };
    sync();
    tracker.currentChanged.connect(sync);
    return () => {
      tracker.currentChanged.disconnect(sync);
    };
  }, [tracker]);
  return review;
}

/**
 * Re-render when the listed files may change.
 */
function useSourceRevision(
  widget: XtralabFileBrowser,
  model: ReviewModel | null
): number {
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    const bump = (): void => setRevision(value => value + 1);
    if (model !== null) {
      model.changed.connect(bump);
      return () => {
        model.changed.disconnect(bump);
      };
    }
    widget.gitChangesChanged.connect(bump);
    return () => {
      widget.gitChangesChanged.disconnect(bump);
    };
  }, [widget, model]);
  return revision;
}

/**
 * The repo-relative path of a canonical tree path.
 */
function repoRelative(model: ReviewModel, path: string): string {
  const prefix = model.repoPath === '' ? '' : `${model.repoPath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * The changed files as tree paths: the files of the review tab when one is
 * open, else the uncommitted changes of the status poll.
 */
function listFiles(
  widget: XtralabFileBrowser,
  model: ReviewModel | null
): GitStatusEntry[] {
  if (model === null) {
    return toGitStatusEntries(widget.gitChanges);
  }
  return model.entries.map(entry => ({
    path: PathExt.join(model.repoPath, entry.file.path),
    status: toTreeStatus(entry.file.status)
  }));
}

/**
 * The file browser's "changed files" mode: a tree of the changed files only.
 * With a review tab open, it lists the files of that review, shows their
 * viewed marks and follows its scroll; a click scrolls the review.
 */
export function ChangedFilesTree(
  props: IChangedFilesTreeProps
): React.ReactElement {
  const {
    widget,
    reviewTracker,
    activateWidget,
    openReview,
    onOpenFile,
    trans
  } = props;
  const review = useCurrentReview(reviewTracker);
  const model = review?.content.model ?? null;
  const revision = useSourceRevision(widget, model);
  const files = React.useMemo(
    () => listFiles(widget, model),
    // `revision` stands for the file list of the source.
    [widget, model, revision]
  );

  // Tree callbacks are set once, so they read the latest values here.
  const latest = React.useRef({ review, model, files });
  latest.current = { review, model, files };
  // The row the list selected itself, so its selection event is not a click.
  const selfSelected = React.useRef<string | null>(null);

  const { model: tree } = useFileTree({
    paths: [],
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    search: true,
    icons: FILE_BROWSER_ICONS,
    itemHeight: 24,
    unsafeCSS: FILE_TREE_UNSAFE_CSS,
    onSelectionChange: paths => {
      widget.updateSelection(paths);
      const current = latest.current.review;
      const path = paths.length === 1 ? paths[0] : null;
      if (
        current === null ||
        path === null ||
        path.endsWith('/') ||
        path === selfSelected.current
      ) {
        return;
      }
      selfSelected.current = path;
      const panel = current.content;
      const target = repoRelative(panel.model, path);
      if (current.isVisible) {
        panel.scrollToFile(target);
        return;
      }
      activateWidget?.(current.id);
      // The list measures its items only once the tab is shown.
      requestAnimationFrame(() => panel.scrollToFile(target));
    },
    renderRowDecoration: ({ row }) => {
      const current = latest.current.model;
      if (current === null || row.kind !== 'file') {
        return null;
      }
      const path = repoRelative(current, row.path);
      if (current.isUpdated(path)) {
        return { text: '●', title: trans.__('Changed since you looked') };
      }
      if (current.isViewed(path)) {
        return { text: '✓', title: trans.__('Viewed') };
      }
      return null;
    }
  });

  useFileFilterBridge(tree, widget);

  // Without a review tab, the branches come from their own request.
  const [bases, setBases] = React.useState<IReviewBases | null>(null);
  const loadBases = React.useCallback(() => {
    fetchReviewBases(GIT_REPO_PATH)
      .then(setBases)
      .catch(reason => {
        console.error('xtralab: failed to list the branches', reason);
      });
  }, []);
  React.useEffect(() => {
    if (model === null) {
      loadBases();
    }
  }, [model, loadBases]);

  const pathsKey = files.map(file => file.path).join('\0');
  React.useEffect(() => {
    const paths = pathsKey === '' ? [] : pathsKey.split('\0');
    tree.resetPaths(paths, { initialExpandedPaths: folderPaths(paths) });
    selfSelected.current = null;
  }, [tree, pathsKey]);

  // Also redraws the rows, so the viewed marks follow the review.
  React.useEffect(() => {
    tree.setGitStatus(files);
  }, [tree, files]);

  // Select the file at the top of the review without scrolling it.
  React.useEffect(() => {
    if (review === null) {
      return;
    }
    const panel = review.content;
    const select = (sender: unknown, file: string | null): void => {
      if (file === null) {
        return;
      }
      const path = PathExt.join(panel.model.repoPath, file);
      const item = tree.getItem(path);
      if (item === null) {
        return;
      }
      selfSelected.current = path;
      for (const selected of tree.getSelectedPaths()) {
        if (selected !== path) {
          tree.getItem(selected)?.deselect();
        }
      }
      item.select();
      tree.scrollToPath(path, { focus: false, offset: 'nearest' });
    };
    select(panel, panel.currentFile);
    panel.currentFileChanged.connect(select);
    return () => {
      panel.currentFileChanged.disconnect(select);
    };
  }, [review, tree, pathsKey]);

  // The toolbar's collapse and refresh buttons act on the list shown.
  React.useEffect(() => {
    const collapseAll = (): void => {
      for (const folder of folderPaths(latest.current.files.map(f => f.path))) {
        const item = tree.getItem(folder);
        if (item !== null && item.isDirectory()) {
          (item as FileTreeDirectoryHandle).collapse();
        }
      }
    };
    const refresh = (): void => {
      void latest.current.model?.refresh();
    };
    widget.collapseAllRequested.connect(collapseAll);
    widget.refreshRequested.connect(refresh);
    return () => {
      widget.collapseAllRequested.disconnect(collapseAll);
      widget.refreshRequested.disconnect(refresh);
    };
  }, [widget, tree]);

  // Runs before the full tree's handler on the wrapper, which it replaces:
  // a deleted file has no document, so it opens its diff instead.
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const node = containerRef.current;
    if (node === null) {
      return;
    }
    const onDoubleClick = (event: MouseEvent): void => {
      const row = event
        .composedPath()
        .find(
          (target): target is HTMLElement =>
            target instanceof HTMLElement && target.dataset.type === 'item'
        );
      if (row === undefined) {
        return;
      }
      event.stopPropagation();
      const path = row.dataset.itemPath;
      if (row.dataset.itemType !== 'file' || path === undefined) {
        return;
      }
      event.preventDefault();
      const { files: current, review: currentReview } = latest.current;
      const deleted =
        current.find(file => file.path === path)?.status === 'deleted';
      if (!deleted) {
        onOpenFile?.(toServerPath(path));
        return;
      }
      const panel = currentReview?.content;
      const entry = panel?.model.entry(repoRelative(panel.model, path));
      if (panel !== undefined && entry !== undefined) {
        panel.openDiff(entry);
      }
    };
    node.addEventListener('dblclick', onDoubleClick);
    return () => {
      node.removeEventListener('dblclick', onDoubleClick);
    };
  }, [onOpenFile]);

  const message =
    files.length > 0
      ? null
      : model !== null
        ? reviewStatusMessage(model, trans)
        : trans.__('No uncommitted changes.');

  // Without a review tab, the list is the uncommitted changes and a choice
  // opens a review tab; with one, a choice changes that review.
  const choose = (scope: ReviewScope, base: string | null): void => {
    if (review === null) {
      openReview?.({ scope, base });
      return;
    }
    review.content.model.setScope(scope, scope === 'branch' ? base : undefined);
    activateWidget?.(review.id);
  };
  const showReview = (): void => {
    if (review === null) {
      openReview?.({ scope: 'uncommitted', base: null });
    } else {
      activateWidget?.(review.id);
    }
  };

  return (
    <div ref={containerRef} className="jp-xtralab-ChangedFiles">
      {bases !== null || model !== null ? (
        <div className="jp-xtralab-ChangedFiles-header">
          <ReviewScopeSelect
            scope={model?.scope ?? 'uncommitted'}
            base={
              model !== null && model.scope === 'branch'
                ? (model.base?.ref ?? model.requestedBase ?? model.defaultBase)
                : null
            }
            defaultBase={model?.defaultBase ?? bases?.defaultBase ?? null}
            candidates={model?.baseCandidates ?? bases?.baseCandidates ?? []}
            onChange={choose}
            onFocus={model === null ? loadBases : undefined}
            trans={trans}
          />
          <ToolbarButtonComponent
            label={trans.__('Review')}
            tooltip={trans.__('Show the diffs of these files in one tab')}
            onClick={showReview}
          />
        </div>
      ) : null}
      {message !== null ? (
        <div className="jp-xtralab-ChangedFiles-message">{message}</div>
      ) : null}
      <FileTree
        model={tree}
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          width: '100%',
          display: files.length === 0 ? 'none' : undefined
        }}
      />
    </div>
  );
}
