import * as React from 'react';

import { IThemeManager, MainAreaWidget } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import {
  LabIcon,
  ReactWidget,
  Toolbar,
  ToolbarButton,
  ToolbarButtonComponent,
  UseSignal,
  caretDownIcon,
  caretRightIcon,
  collapseAllIcon,
  expandAllIcon,
  fileIcon,
  launchIcon,
  refreshIcon,
  undoIcon
} from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import type { Message } from '@lumino/messaging';
import { ISignal, Signal } from '@lumino/signaling';
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions
} from '@pierre/diffs/react';
import type {
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  LineAnnotation,
  SelectedLineRange
} from '@pierre/diffs';

import type { IAskAgent } from '../askAgent/tokens';
import { changedFilesIcon } from '../fileBrowser/icons';

import { buildDiffAskRequest } from './askRequest';
import { CommandIDs } from './commands';
import { useDiffPreferences, type IDiffPreferences } from './diffPreferences';
import {
  DIFF_SURFACE_CSS,
  DiffStyleControl,
  LineWrapControl,
  useDiffThemeFlags
} from './diffSurface';
import { resolveDiffTheme } from './diffTheme';
import {
  ReviewModel,
  reviewStatusMessage,
  type IReviewEntry,
  type IReviewHunkAnnotation
} from './reviewModel';
import { ReviewScopeSelect } from './reviewScope';

export const REVIEW_WIDGET_CSS_CLASS = 'jp-xtralab-Review';

const SHOW_CHANGED_FILES_COMMAND = 'xtralab:show-changed-files';

/**
 * The file counts of the header come from the review payload, so the
 * library's own counts are hidden.
 */
const REVIEW_DIFF_CSS = `${DIFF_SURFACE_CSS}
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none;
}`;

type ReviewCodeViewHandle = CodeViewHandle<IReviewHunkAnnotation, undefined>;

const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

/**
 * Application services the review tab uses.
 */
export interface IReviewContext {
  /**
   * Runs the open-diff and open-file commands.
   */
  commands: CommandRegistry;
  /**
   * The theme manager the diffs follow, or `null`.
   */
  themeManager: IThemeManager | null;
  /**
   * The ask-agent popup for selected lines, or `null`.
   */
  askAgent: IAskAgent | null;
  /**
   * The display choices shared by all diff views.
   */
  preferences: IDiffPreferences;
  /**
   * The application translation bundle.
   */
  trans: TranslationBundle;
}

/**
 * Re-render on each model change and return its revision.
 */
function useModelRevision(model: ReviewModel): number {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const slot = (): void => onChange();
      model.changed.connect(slot);
      return () => {
        model.changed.disconnect(slot);
      };
    },
    [model]
  );
  return React.useSyncExternalStore(subscribe, () => model.revision);
}

/**
 * The body of the review tab: the diffs of every changed file. The file
 * browser lists the files in its "changed files" mode.
 */
export class ReviewPanel extends ReactWidget {
  constructor(model: ReviewModel, context: IReviewContext) {
    super();
    this.model = model;
    this.context = context;
    this.addClass('jp-xtralab-Review-diffs');
  }

  /**
   * The changes the panel shows.
   */
  readonly model: ReviewModel;

  /**
   * The application services the panel uses.
   */
  readonly context: IReviewContext;

  /**
   * The repo-relative path of the file at the top of the list.
   */
  get currentFile(): string | null {
    return this._currentFile;
  }

  /**
   * A signal emitted when {@link currentFile} changes.
   */
  get currentFileChanged(): ISignal<this, string | null> {
    return this._currentFileChanged;
  }

  /**
   * Scroll the diff list to a file.
   */
  scrollToFile(path: string): void {
    if (this.model.entry(path) === undefined) {
      return;
    }
    this.model.acknowledge(path);
    // The last file may not reach the top; keep the clicked file current.
    this._followScroll = false;
    this._setCurrentFile(path);
    this._codeView?.scrollTo({ type: 'item', id: path, align: 'start' });
  }

  /**
   * Let the current file follow the scroll again, after the user scrolls.
   */
  readonly followScroll = (): void => {
    this._followScroll = true;
  };

  /**
   * Report the file at the top of the list after a scroll.
   */
  setScrolledFile(path: string | null): void {
    if (this._followScroll) {
      this._setCurrentFile(path);
    }
  }

  /**
   * Register the diff list, or `null` when it unmounts.
   */
  setCodeView(handle: ReviewCodeViewHandle | null): void {
    this._codeView = handle;
  }

  /**
   * Open the single-file diff of an entry in its own tab.
   */
  openDiff(entry: IReviewEntry): void {
    const change = this.model.fileChange(entry);
    if (change === null) {
      return;
    }
    void this.context.commands.execute(CommandIDs.openDiff, {
      repoPath: this.model.repoPath,
      change
    } as unknown as ReadonlyPartialJSONObject);
  }

  /**
   * Open the working-tree file of an entry.
   */
  openFile(entry: IReviewEntry): void {
    void this.context.commands.execute('docmanager:open', {
      path: PathExt.join(this.model.repoPath, entry.file.path)
    });
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.model.dispose();
    super.dispose();
  }

  protected render(): React.ReactElement {
    return <ReviewDiffList panel={this} />;
  }

  private _setCurrentFile(path: string | null): void {
    if (path === this._currentFile) {
      return;
    }
    this._currentFile = path;
    this._currentFileChanged.emit(path);
  }

  private _codeView: ReviewCodeViewHandle | null = null;
  private _currentFile: string | null = null;
  private _currentFileChanged = new Signal<this, string | null>(this);
  private _followScroll = true;
}

function kindLabel(
  entry: IReviewEntry,
  trans: TranslationBundle
): string | null {
  switch (entry.kind) {
    case 'notebook':
      return trans.__('Notebook');
    case 'image':
      return trans.__('Image');
    case 'binary':
      return trans.__('Binary file');
    case 'large':
      return trans.__('Large diff');
    default:
      return null;
  }
}

/**
 * Why a collapsed file is collapsed, when the Viewed box does not say it.
 */
function collapsedReason(
  model: ReviewModel,
  entry: IReviewEntry,
  trans: TranslationBundle
): string | null {
  if (!entry.item.collapsed) {
    return null;
  }
  switch (model.collapseReason(entry)) {
    case 'renamed':
      return trans.__('Renamed without changes');
    case 'no-changes':
      return trans.__('No text changes');
    case 'deleted':
      return trans.__('Deleted');
    case 'lock-file':
      return trans.__('Lock file');
    case 'large':
      return trans.__('Large diff');
    default:
      return null;
  }
}

function ReviewDiffList(props: { panel: ReviewPanel }): React.ReactElement {
  const { panel } = props;
  const { model, context } = panel;
  const { askAgent, preferences, themeManager, trans } = context;
  const revision = useModelRevision(model);
  const { diffStyle, lineWrap, splitRatio } = useDiffPreferences(preferences);
  const { dark, pierre } = useDiffThemeFlags(themeManager);
  const handleRef = React.useRef<ReviewCodeViewHandle | null>(null);
  const scrollFrame = React.useRef<number | null>(null);

  const setHandle = React.useCallback(
    (handle: ReviewCodeViewHandle | null) => {
      handleRef.current = handle;
      panel.setCodeView(handle);
    },
    [panel]
  );

  const loadDiffFiles = React.useCallback(
    async (fileDiff: FileDiffMetadata) => {
      const entry = model.entry(fileDiff.name);
      if (entry === undefined) {
        throw new Error(`No review entry for ${fileDiff.name}`);
      }
      const { oldText, newText } = await model.loadFiles(entry);
      return {
        oldFile: {
          name: fileDiff.prevName ?? fileDiff.name,
          contents: oldText
        },
        newFile: { name: fileDiff.name, contents: newText }
      };
    },
    [model]
  );

  const onGutterUtilityClick = React.useCallback(
    (
      range: SelectedLineRange,
      itemContext: { item: { id: string }; element: HTMLElement | undefined }
    ): void => {
      const entry = model.entry(itemContext.item.id);
      if (askAgent === null || entry === undefined) {
        return;
      }
      const slot = itemContext.element?.shadowRoot?.querySelector(
        '[data-gutter-utility-slot]'
      );
      const anchor =
        slot instanceof Element ? slot.getBoundingClientRect() : null;
      void model
        .loadFiles(entry)
        .then(({ oldText, newText }) => {
          askAgent.open(
            buildDiffAskRequest({
              model: model.askSource(entry),
              oldText,
              newText,
              range,
              anchor,
              trans
            })
          );
        })
        .catch(reason => {
          console.error(
            'xtralab: failed to load the file to ask about',
            reason
          );
        });
    },
    [askAgent, model, trans]
  );

  const options = React.useMemo<
    CodeViewReactOptions<IReviewHunkAnnotation, undefined>
  >(
    () => ({
      theme: resolveDiffTheme(dark, pierre),
      themeType: dark ? 'dark' : 'light',
      diffStyle,
      overflow: lineWrap ? 'wrap' : 'scroll',
      // Constant string lets the library skip its unsafeCSS re-render path.
      unsafeCSS: REVIEW_DIFF_CSS,
      stickyHeaders: true,
      loadDiffFiles,
      ...(askAgent !== null
        ? {
            enableLineSelection: true,
            enableGutterUtility: true,
            onGutterUtilityClick
          }
        : {})
    }),
    [
      askAgent,
      dark,
      diffStyle,
      lineWrap,
      loadDiffFiles,
      onGutterUtilityClick,
      pierre
    ]
  );

  const onScroll = React.useCallback(
    (
      scrollTop: number,
      viewer: { getTopForItem(id: string): number | undefined }
    ) => {
      if (scrollFrame.current !== null) {
        return;
      }
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null;
        let current: string | null = null;
        for (const entry of model.entries) {
          const top = viewer.getTopForItem(entry.file.path);
          if (top === undefined || top > scrollTop + 1) {
            break;
          }
          current = entry.file.path;
        }
        panel.setScrolledFile(current ?? model.entries[0]?.file.path ?? null);
      });
    },
    [model, panel]
  );

  React.useEffect(
    () => () => {
      if (scrollFrame.current !== null) {
        cancelAnimationFrame(scrollFrame.current);
      }
    },
    []
  );

  // A user scroll lets the tree follow the list again.
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const setContainer = React.useCallback(
    (node: HTMLDivElement | null) => {
      for (const type of USER_SCROLL_EVENTS) {
        containerRef.current?.removeEventListener(type, panel.followScroll);
        node?.addEventListener(type, panel.followScroll, { passive: true });
      }
      containerRef.current = node;
    },
    [panel]
  );

  const renderHeaderPrefix = React.useCallback(
    (item: CodeViewItem<IReviewHunkAnnotation>): React.ReactNode => {
      const entry = model.entry(item.id);
      if (entry === undefined) {
        return null;
      }
      const path = entry.file.path;
      const collapsed = entry.item.collapsed === true;
      const updated = model.isUpdated(path);
      return (
        <span className="jp-xtralab-Review-headerPrefix">
          {model.isCollapsible(entry) ? (
            <ToolbarButtonComponent
              icon={collapsed ? caretRightIcon : caretDownIcon}
              tooltip={
                collapsed
                  ? trans.__('Expand %1', path)
                  : trans.__('Collapse %1', path)
              }
              aria-expanded={!collapsed}
              onClick={() => model.setCollapsed(path, !collapsed)}
            />
          ) : (
            <span className="jp-xtralab-Review-iconSpacer" />
          )}
          {updated ? (
            <span
              className="jp-xtralab-Review-updatedDot"
              title={trans.__('Changed since you looked')}
              aria-label={trans.__('Changed since you looked')}
            />
          ) : null}
        </span>
      );
    },
    // `revision` makes the headers follow the model.
    [model, revision, trans]
  );

  const renderHeaderMetadata = React.useCallback(
    (item: CodeViewItem<IReviewHunkAnnotation>): React.ReactNode => {
      const entry = model.entry(item.id);
      if (entry === undefined) {
        return null;
      }
      const { file } = entry;
      const notes = [
        kindLabel(entry, trans),
        collapsedReason(model, entry, trans)
      ].filter((note): note is string => note !== null);
      const viewed = model.isViewed(file.path);
      const openTitle =
        entry.kind === 'notebook'
          ? trans.__('Open the notebook diff in its own tab')
          : entry.kind === 'image'
            ? trans.__('Open the image diff in its own tab')
            : trans.__('Open the diff in its own tab');
      return (
        <span className="jp-xtralab-Review-headerMeta">
          {notes.length > 0 ? (
            <span className="jp-xtralab-Review-note">{notes.join(' · ')}</span>
          ) : null}
          {!file.binary ? (
            <span className="jp-xtralab-Review-counts">
              <span className="jp-xtralab-Review-additions">
                +{file.additions}
              </span>
              <span className="jp-xtralab-Review-deletions">
                −{file.deletions}
              </span>
            </span>
          ) : null}
          <label className="jp-xtralab-Review-viewed">
            <input
              type="checkbox"
              checked={viewed}
              onChange={event =>
                model.setViewed(file.path, event.currentTarget.checked)
              }
            />
            {trans.__('Viewed')}
          </label>
          <ToolbarButtonComponent
            icon={launchIcon}
            tooltip={openTitle}
            onClick={() => panel.openDiff(entry)}
          />
          {file.status !== 'deleted' ? (
            <ToolbarButtonComponent
              icon={fileIcon}
              tooltip={trans.__('Open %1', file.path)}
              onClick={() => panel.openFile(entry)}
            />
          ) : null}
        </span>
      );
    },
    [model, panel, revision, trans]
  );

  const renderAnnotation = React.useCallback(
    (
      annotation:
        | LineAnnotation<IReviewHunkAnnotation>
        | DiffLineAnnotation<IReviewHunkAnnotation>,
      item: CodeViewItem<IReviewHunkAnnotation>
    ): React.ReactNode => {
      const metadata = annotation.metadata;
      if (metadata === undefined) {
        return null;
      }
      return (
        <div className="jp-xtralab-DiffWidget-hunkAnnotation">
          <button
            type="button"
            className="jp-xtralab-DiffWidget-hunkButton"
            title={trans.__("Discard this hunk's changes")}
            aria-label={trans.__('Discard hunk')}
            onClick={() => void model.discardHunk(item.id, metadata.hunkIndex)}
          >
            <undoIcon.react
              tag="span"
              className="jp-xtralab-DiffWidget-hunkButton-icon"
              elementSize="normal"
            />
          </button>
        </div>
      );
    },
    [model, trans]
  );

  const message = reviewStatusMessage(model, trans);
  if (message !== null) {
    return (
      <div
        className="jp-xtralab-Review-status"
        data-error={model.error !== null ? 'true' : undefined}
      >
        {message}
      </div>
    );
  }

  const leftPercent = splitRatio * 100;
  const style = {
    '--xtralab-split-cols': `${leftPercent}% ${100 - leftPercent}%`
  } as React.CSSProperties;

  return (
    <CodeView<IReviewHunkAnnotation>
      ref={setHandle}
      containerRef={setContainer}
      className="jp-xtralab-Review-codeView"
      style={style}
      items={model.items}
      options={options}
      onScroll={onScroll}
      renderHeaderPrefix={renderHeaderPrefix}
      renderHeaderMetadata={renderHeaderMetadata}
      renderAnnotation={renderAnnotation}
    />
  );
}

function ScopeControl(props: {
  model: ReviewModel;
  trans: TranslationBundle;
}): React.ReactElement {
  const { model, trans } = props;
  return (
    <ReviewScopeSelect
      scope={model.scope}
      base={
        model.scope === 'branch'
          ? (model.base?.ref ?? model.requestedBase ?? model.defaultBase)
          : null
      }
      defaultBase={model.defaultBase}
      candidates={model.baseCandidates}
      onChange={(scope, base) =>
        model.setScope(scope, scope === 'branch' ? base : undefined)
      }
      trans={trans}
    />
  );
}

function SummaryLabel(props: {
  model: ReviewModel;
  trans: TranslationBundle;
}): React.ReactElement {
  const { model, trans } = props;
  const count = model.entries.length;
  if (model.loading || model.error !== null || count === 0) {
    return <></>;
  }
  const { additions, deletions } = model.totals;
  return (
    <span className="jp-xtralab-Review-summary">
      {trans._n('%1 file', '%1 files', count)}
      <span className="jp-xtralab-Review-additions">+{additions}</span>
      <span className="jp-xtralab-Review-deletions">−{deletions}</span>
    </span>
  );
}

function ExpandAllButton(props: {
  model: ReviewModel;
  trans: TranslationBundle;
}): React.ReactElement {
  const { model, trans } = props;
  const collapsible = model.entries.filter(entry => model.isCollapsible(entry));
  const anyExpanded = collapsible.some(entry => entry.item.collapsed !== true);
  return (
    <ToolbarButtonComponent
      icon={anyExpanded ? collapseAllIcon : expandAllIcon}
      tooltip={
        anyExpanded
          ? trans.__('Collapse all files')
          : trans.__('Expand all files')
      }
      enabled={collapsible.length > 0}
      onClick={() => model.setAllCollapsed(anyExpanded)}
    />
  );
}

function DiffDisplayControls(props: {
  preferences: IDiffPreferences;
  trans: TranslationBundle;
}): React.ReactElement {
  const { preferences, trans } = props;
  const { diffStyle, diffStyleControl, lineWrap } =
    useDiffPreferences(preferences);
  return (
    <div className="jp-xtralab-Review-display">
      <DiffStyleControl
        diffStyle={diffStyle}
        control={diffStyleControl}
        available={true}
        onChange={next => preferences.update({ diffStyle: next })}
        trans={trans}
      />
      <LineWrapControl
        lineWrap={lineWrap}
        available={true}
        onChange={next => preferences.update({ lineWrap: next })}
        trans={trans}
      />
    </div>
  );
}

/**
 * The review tab in the main area. It polls only while it is visible.
 */
export class ReviewMainAreaWidget extends MainAreaWidget<ReviewPanel> {
  constructor(panel: ReviewPanel) {
    super({ content: panel });
    const { model, context } = panel;
    const { trans } = context;
    this.id = reviewWidgetId(model.repoPath);
    this.addClass(REVIEW_WIDGET_CSS_CLASS);
    this.title.closable = true;
    this.title.icon = LabIcon.resolve({ icon: 'git:diff' });
    this.title.caption =
      model.repoPath === ''
        ? trans.__('Review changes')
        : trans.__('Review changes in %1', model.repoPath);
    model.setActive(false);

    const withModel = (render: () => React.ReactElement): ReactWidget =>
      ReactWidget.create(
        <UseSignal signal={model.changed}>{() => render()}</UseSignal>
      );
    this.toolbar.addItem(
      'scope',
      withModel(() => <ScopeControl model={model} trans={trans} />)
    );
    this.toolbar.addItem(
      'summary',
      withModel(() => <SummaryLabel model={model} trans={trans} />)
    );
    this.toolbar.addItem('spacer', Toolbar.createSpacerItem());
    this.toolbar.addItem(
      'files',
      new ToolbarButton({
        icon: changedFilesIcon,
        tooltip: trans.__('Show the changed files in the file browser'),
        onClick: () => void context.commands.execute(SHOW_CHANGED_FILES_COMMAND)
      })
    );
    this.toolbar.addItem(
      'expand',
      withModel(() => <ExpandAllButton model={model} trans={trans} />)
    );
    this.toolbar.addItem(
      'display',
      ReactWidget.create(
        <DiffDisplayControls preferences={context.preferences} trans={trans} />
      )
    );
    this.toolbar.addItem(
      'refresh',
      new ToolbarButton({
        icon: refreshIcon,
        tooltip: trans.__('Refresh the changes'),
        onClick: () => void model.refresh()
      })
    );

    this._syncTitle();
    model.changed.connect(this._syncTitle, this);
  }

  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this.content.model.setActive(true);
  }

  protected onAfterHide(msg: Message): void {
    super.onAfterHide(msg);
    this.content.model.setActive(false);
  }

  private _syncTitle(): void {
    const { model, context } = this.content;
    const { trans } = context;
    const branch = model.branch;
    const base = model.base?.ref ?? null;
    this.title.label =
      model.scope === 'uncommitted'
        ? trans.__('Uncommitted Changes')
        : branch !== null && base !== null
          ? trans.__('Changes: %1 vs %2', branch, base)
          : trans.__('Branch Changes');
  }
}

/**
 * The id of the review tab of a repository; one tab per repository.
 */
export function reviewWidgetId(repoPath: string): string {
  return `xtralab:git-review:${repoPath}`;
}
