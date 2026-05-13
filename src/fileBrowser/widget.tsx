import * as React from 'react';

import { IDocumentManager } from '@jupyterlab/docmanager';
import { Contents } from '@jupyterlab/services';
import { ReactWidget, Toolbar } from '@jupyterlab/ui-components';
import { Signal, ISignal } from '@lumino/signaling';
import { PanelLayout, Widget } from '@lumino/widgets';

import { FileBrowserComponent } from './fileBrowser';
import { xtralabFileBrowserIcon } from './icons';

export const FILE_BROWSER_ID = 'xtralab:file-browser';

/**
 * The CSS class added to the xtralab file browser widget. The selectors that
 * bind application context menu items hang off this class, so it must remain
 * specific enough not to clash with other browsers (such as the default
 * `jp-FileBrowser`).
 */
export const FILE_BROWSER_CSS_CLASS = 'jp-xtralab-FileBrowser';

const TOOLBAR_CSS_CLASS = 'jp-xtralab-FileBrowser-toolbar';
const CONTENT_CSS_CLASS = 'jp-xtralab-FileBrowser-content';

export interface IXtralabFileBrowserOptions {
  contentsManager: Contents.IManager;
  docManager: IDocumentManager;
  onOpenFile?: (serverPath: string) => void;
}

/**
 * Public API of the xtralab file browser used by command handlers and other
 * collaborators. Kept narrow on purpose so the React component stays free to
 * evolve the underlying tree integration.
 */
export interface IXtralabFileBrowser {
  /**
   * The contents manager backing the tree. Exposed so command handlers can
   * issue contents operations (rename, delete, copy, …) against the same
   * drive the tree was loaded from.
   */
  readonly contentsManager: Contents.IManager;

  /**
   * The toolbar shown above the tree. Plugin code populates it with command
   * buttons after the widget is constructed.
   */
  readonly toolbar: Toolbar;

  /**
   * Canonical paths of the items currently selected in the tree. Folder
   * paths carry a trailing slash; file paths do not.
   */
  readonly selectedPaths: readonly string[];

  /**
   * Emits when the tree's selection changes. Commands that have an
   * `isVisible` / `isEnabled` predicate should listen so they re-evaluate.
   */
  readonly selectionChanged: ISignal<IXtralabFileBrowser, readonly string[]>;

  /**
   * Emits when {@link refresh} is called. The React component listens and
   * re-fetches the directories that were previously loaded so the tree
   * matches the contents on disk again.
   */
  readonly refreshRequested: ISignal<IXtralabFileBrowser, void>;

  /**
   * Emits when the widget is asked to surface a newly-created path
   * (for example, after the toolbar's "new folder" command). The React
   * component listens and inserts the path into the model so the user
   * sees the new item without a full refresh.
   */
  readonly pathAdded: ISignal<IXtralabFileBrowser, string>;

  /**
   * Emits when an external caller asks the tree to scroll to and select
   * the given canonical path. The React component listens, lazily loads
   * any unloaded ancestor directories, expands them, and selects the
   * target. Used by the editor breadcrumbs to jump back to a file or
   * folder shown in the breadcrumb trail.
   */
  readonly revealRequested: ISignal<IXtralabFileBrowser, string>;

  /**
   * Emits when an external caller asks the tree to return to the
   * workspace root: clear any current selection and scroll back to the
   * first row. Distinct from {@link revealRequested} because the
   * workspace root has no tree row of its own — it cannot be reached
   * by passing a path.
   */
  readonly rootRequested: ISignal<IXtralabFileBrowser, void>;

  /**
   * Emits when an external caller asks the tree to collapse every
   * expanded folder. The React component listens and walks the loaded
   * directories, calling `.collapse()` on each expanded one.
   */
  readonly collapseAllRequested: ISignal<IXtralabFileBrowser, void>;

  /** Trigger a refresh of every loaded directory in the tree. */
  refresh(): void;

  /**
   * Notify the React component that a new path was created and should
   * appear in the tree. `canonicalPath` follows the `@pierre/trees`
   * convention: directories carry a trailing slash, files do not.
   */
  notifyPathAdded(canonicalPath: string): void;

  /**
   * Ask the tree to reveal {@link canonicalPath}: load and expand any
   * unloaded ancestor directories, then select and scroll the target
   * into view. `canonicalPath` follows the `@pierre/trees` convention
   * (directories carry a trailing slash, files do not). Must be a
   * non-empty path — use {@link scrollToRoot} for the root gesture.
   */
  reveal(canonicalPath: string): void;

  /**
   * Ask the tree to return to the workspace root: clear any current
   * selection and scroll back to the top of the tree.
   */
  scrollToRoot(): void;

  /**
   * Ask the tree to collapse every currently expanded folder.
   */
  collapseAll(): void;
}

/**
 * Lumino widget that hosts the React-based `@pierre/trees` file browser.
 * The widget is laid out with a JupyterLab `Toolbar` on top and the tree
 * filling the remaining space.
 */
export class XtralabFileBrowser extends Widget implements IXtralabFileBrowser {
  constructor(options: IXtralabFileBrowserOptions) {
    super();
    const layout = (this.layout = new PanelLayout());

    this._contentsManager = options.contentsManager;
    this._docManager = options.docManager;
    this._onOpenFile = options.onOpenFile;
    this.id = FILE_BROWSER_ID;
    this.title.icon = xtralabFileBrowserIcon;
    this.title.caption = 'xtralab File Browser';
    this.addClass(FILE_BROWSER_CSS_CLASS);

    this._toolbar = new Toolbar();
    this._toolbar.addClass(TOOLBAR_CSS_CLASS);
    this._toolbar.node.setAttribute('aria-label', 'file browser');
    layout.addWidget(this._toolbar);

    this._content = new XtralabFileTreeContent({
      contentsManager: this._contentsManager,
      docManager: this._docManager,
      onOpenFile: this._onOpenFile,
      browser: this
    });
    this._content.addClass(CONTENT_CSS_CLASS);
    layout.addWidget(this._content);
  }

  get contentsManager(): Contents.IManager {
    return this._contentsManager;
  }

  get toolbar(): Toolbar {
    return this._toolbar;
  }

  get selectedPaths(): readonly string[] {
    return this._selectedPaths;
  }

  get selectionChanged(): ISignal<this, readonly string[]> {
    return this._selectionChanged;
  }

  get refreshRequested(): ISignal<this, void> {
    return this._refreshRequested;
  }

  get pathAdded(): ISignal<this, string> {
    return this._pathAdded;
  }

  get revealRequested(): ISignal<this, string> {
    return this._revealRequested;
  }

  get rootRequested(): ISignal<this, void> {
    return this._rootRequested;
  }

  get collapseAllRequested(): ISignal<this, void> {
    return this._collapseAllRequested;
  }

  /**
   * Update the cached selection. Called from the React tree when the
   * underlying `@pierre/trees` model emits a selection change.
   */
  updateSelection(paths: readonly string[]): void {
    this._selectedPaths = paths;
    this._selectionChanged.emit(paths);
  }

  refresh(): void {
    this._refreshRequested.emit();
  }

  notifyPathAdded(canonicalPath: string): void {
    this._pathAdded.emit(canonicalPath);
  }

  reveal(canonicalPath: string): void {
    if (canonicalPath.length === 0) {
      throw new Error(
        'XtralabFileBrowser.reveal requires a non-empty canonical path; use scrollToRoot for the workspace root.'
      );
    }
    this._revealRequested.emit(canonicalPath);
  }

  scrollToRoot(): void {
    this._rootRequested.emit();
  }

  collapseAll(): void {
    this._collapseAllRequested.emit();
  }

  private _contentsManager: Contents.IManager;
  private _docManager: IDocumentManager;
  private _onOpenFile: ((serverPath: string) => void) | undefined;
  private _selectedPaths: readonly string[] = [];
  private _selectionChanged = new Signal<this, readonly string[]>(this);
  private _refreshRequested = new Signal<this, void>(this);
  private _pathAdded = new Signal<this, string>(this);
  private _revealRequested = new Signal<this, string>(this);
  private _rootRequested = new Signal<this, void>(this);
  private _collapseAllRequested = new Signal<this, void>(this);
  private _toolbar: Toolbar;
  private _content: XtralabFileTreeContent;
}

interface IFileTreeContentOptions {
  contentsManager: Contents.IManager;
  docManager: IDocumentManager;
  onOpenFile?: (serverPath: string) => void;
  browser: XtralabFileBrowser;
}

/**
 * The React-rendered region of the file browser. Lives inside the host
 * widget below the toolbar and renders the actual tree.
 */
class XtralabFileTreeContent extends ReactWidget {
  constructor(options: IFileTreeContentOptions) {
    super();
    this._options = options;
  }

  protected render(): React.ReactElement {
    return (
      <FileBrowserComponent
        contentsManager={this._options.contentsManager}
        docManager={this._options.docManager}
        onOpenFile={this._options.onOpenFile}
        widget={this._options.browser}
      />
    );
  }

  private _options: IFileTreeContentOptions;
}
