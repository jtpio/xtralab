import * as React from 'react';

import {
  IMovableSectionDestination,
  IMovableSectionSource,
  ISectionEntry
} from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { Contents } from '@jupyterlab/services';
import { ITranslator } from '@jupyterlab/translation';
import {
  AccordionToolbar,
  PanelWithToolbar,
  ReactWidget,
  Toolbar
} from '@jupyterlab/ui-components';
import { Signal, ISignal } from '@lumino/signaling';
import { AccordionPanel, PanelLayout, Widget } from '@lumino/widgets';

import { FileBrowserComponent } from './fileBrowser';
import { xtralabFileBrowserIcon } from './icons';

export const FILE_BROWSER_ID = 'xtralab:file-browser';

/**
 * Persisted by the movable-sections plugin, so it must stay stable.
 */
const TREE_SECTION_ID = 'xtralab-file-tree-section';

/**
 * Context menu selectors hang off this class, so it sits on the section and
 * keeps matching once the tree moves to another panel.
 */
const FILE_BROWSER_CSS_CLASS = 'jp-xtralab-FileBrowser';

const PANEL_CSS_CLASS = 'jp-xtralab-FileBrowserPanel';

const TOOLBAR_CSS_CLASS = 'jp-xtralab-FileBrowser-toolbar';
const CONTENT_CSS_CLASS = 'jp-xtralab-FileBrowser-content';

const ACCORDION_CSS_CLASS = 'jp-xtralab-FileBrowser-accordion';

const MOVABLE_SECTION_CLASS = 'jp-movable-section';

interface IXtralabFileBrowserOptions {
  contentsManager: Contents.IManager;
  docManager: IDocumentManager;
  onOpenFile?: (serverPath: string) => void;
  translator?: ITranslator;
}

/**
 * Public API of the xtralab file browser used by command handlers and other
 * collaborators. Kept narrow on purpose so the React component stays free to
 * evolve the underlying tree integration.
 */
export interface IXtralabFileBrowser {
  /**
   * The contents manager backing the tree; command handlers issue rename,
   * delete, copy, … against the same drive.
   */
  readonly contentsManager: Contents.IManager;

  /** The toolbar above the tree, populated by plugin code after construction. */
  readonly toolbar: Toolbar;

  /** Canonical selected paths; folder paths carry a trailing slash. */
  readonly selectedPaths: readonly string[];

  /** Emits when the tree's selection changes. */
  readonly selectionChanged: ISignal<IXtralabFileBrowser, readonly string[]>;

  /** Emits when {@link refresh} is called. */
  readonly refreshRequested: ISignal<IXtralabFileBrowser, void>;

  /**
   * Emits a newly-created canonical path so the tree inserts it without a
   * full refresh.
   */
  readonly pathAdded: ISignal<IXtralabFileBrowser, string>;

  /**
   * Emits a canonical path to load, expand, select, and scroll to. Used by
   * the editor breadcrumbs.
   */
  readonly revealRequested: ISignal<IXtralabFileBrowser, string>;

  /**
   * Emits when the tree should return to the workspace root — the root has
   * no tree row of its own, so it cannot be revealed by path.
   */
  readonly rootRequested: ISignal<IXtralabFileBrowser, void>;

  /** Emits when every expanded folder should collapse. */
  readonly collapseAllRequested: ISignal<IXtralabFileBrowser, void>;

  /**
   * Whether the filter box above the tree is shown; also forced `true` when
   * the tree opens a search session itself (typing while it has focus).
   */
  readonly fileFilterVisible: boolean;

  /** Emits when {@link fileFilterVisible} changes. */
  readonly fileFilterVisibleChanged: ISignal<IXtralabFileBrowser, boolean>;

  /**
   * Trigger a refresh of every loaded directory in the tree.
   */
  refresh(): void;

  /**
   * Notify the React component that a new canonical path was created and
   * should appear in the tree.
   */
  notifyPathAdded(canonicalPath: string): void;

  /**
   * Reveal a non-empty canonical path: load and expand ancestors, then
   * select and scroll to it. Use {@link scrollToRoot} for the root gesture.
   */
  reveal(canonicalPath: string): void;

  /** Return to the workspace root: clear the selection and scroll to the top. */
  scrollToRoot(): void;

  /**
   * Ask the tree to collapse every currently expanded folder.
   */
  collapseAll(): void;

  /**
   * Show or hide the filter box above the tree.
   */
  setFileFilterVisible(visible: boolean): void;

  /**
   * Toggle the filter box above the tree.
   */
  toggleFileFilter(): void;

  readonly sectionNode: HTMLElement;
}

/**
 * Lumino widget hosting the React-based `@pierre/trees` file browser. The tree
 * and its toolbar form one movable "Files" section, and sections from other
 * panels can be moved in below it.
 */
export class XtralabFileBrowser
  extends Widget
  implements
    IXtralabFileBrowser,
    IMovableSectionSource,
    IMovableSectionDestination
{
  constructor(options: IXtralabFileBrowserOptions) {
    super();
    const layout = (this._panelLayout = this.layout = new PanelLayout());

    this._contentsManager = options.contentsManager;
    this._docManager = options.docManager;
    this._onOpenFile = options.onOpenFile;
    this._translator = options.translator;
    this.id = FILE_BROWSER_ID;
    this.title.icon = xtralabFileBrowserIcon;
    this.title.caption = 'xtralab File Browser';
    this.addClass(PANEL_CSS_CLASS);

    this._toolbar = new Toolbar();
    this._toolbar.addClass(TOOLBAR_CSS_CLASS);
    this._toolbar.node.setAttribute('aria-label', 'file browser');

    this._content = new XtralabFileTreeContent({
      contentsManager: this._contentsManager,
      docManager: this._docManager,
      onOpenFile: this._onOpenFile,
      translator: this._translator,
      browser: this
    });
    this._content.addClass(CONTENT_CSS_CLASS);

    this._section = new PanelWithToolbar({ toolbar: this._toolbar });
    this._section.id = TREE_SECTION_ID;
    // Only an accordion host draws this; a plain `PanelLayout` shows no title.
    this._section.title.label = 'Files';
    this._section.addClass(FILE_BROWSER_CSS_CLASS);
    this._section.addWidget(this._toolbar);
    this._section.addWidget(this._content);
    layout.addWidget(this._section);
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

  get fileFilterVisible(): boolean {
    return this._fileFilterVisible;
  }

  get fileFilterVisibleChanged(): ISignal<this, boolean> {
    return this._fileFilterVisibleChanged;
  }

  /** Update the cached selection from the React tree. */
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

  setFileFilterVisible(visible: boolean): void {
    if (this._fileFilterVisible === visible) {
      return;
    }
    this._fileFilterVisible = visible;
    this._fileFilterVisibleChanged.emit(visible);
  }

  toggleFileFilter(): void {
    this.setFileFilterVisible(!this._fileFilterVisible);
  }

  get sectionNode(): HTMLElement {
    return this._section.node;
  }

  get isEmpty(): boolean {
    return this._panelLayout.widgets.length === 0;
  }

  get contentChanged(): ISignal<this, void> {
    return this._contentChanged;
  }

  get sectionAdded(): ISignal<this, ISectionEntry> {
    return this._sectionAdded;
  }

  get accordionPanel(): AccordionPanel | null {
    return this._accordion;
  }

  get sections(): ReadonlyArray<Widget> {
    if (!this._accordion) {
      return [];
    }
    return this._accordion.widgets.filter(w => w !== this._section);
  }

  /**
   * The toolbar is the section's title node: it is the tree's header row at
   * home, and an accordion host renders it inside the section title.
   */
  getSections(): ReadonlyArray<ISectionEntry> {
    return this._isSectionHome()
      ? [
          {
            id: TREE_SECTION_ID,
            titleNode: this._toolbar.node,
            widget: this._section
          }
        ]
      : [];
  }

  removeSectionById(sectionId: string): Widget | null {
    if (sectionId !== TREE_SECTION_ID || !this._isSectionHome()) {
      return null;
    }
    this._section.parent = null;
    if (this._accordion && this._accordion.widgets.length === 0) {
      this._accordion.dispose();
      this._accordion = null;
    }
    // Away from home the toolbar must not offer "Move to …" as well;
    // `getSections` re-marks it on the way back.
    this._toolbar.node.classList.remove(MOVABLE_SECTION_CLASS);
    this._contentChanged.emit();
    return this._section;
  }

  reinsertSection(widget: Widget): void {
    if (this._accordion) {
      this._accordion.insertWidget(0, widget);
    } else {
      this._panelLayout.addWidget(widget);
      this._restoreToolbar();
    }
    this._contentChanged.emit();
  }

  /**
   * The move plugin reconciles persisted moves only against sections announced
   * after `registerSource`, and this panel builds its section in the constructor.
   */
  announceSections(): void {
    for (const entry of this.getSections()) {
      this._sectionAdded.emit(entry);
    }
  }

  /**
   * The first hosted section moves the tree into an accordion.
   */
  addSection(widget: Widget): void {
    if (!this._accordion) {
      const accordion = new AccordionPanel({
        layout: AccordionToolbar.createLayout({})
      });
      accordion.addClass(ACCORDION_CSS_CLASS);
      if (this._section.parent === this) {
        accordion.addWidget(this._section);
      }
      accordion.addWidget(widget);
      this._accordion = accordion;
      this._panelLayout.addWidget(accordion);
    } else {
      this._accordion.addWidget(widget);
    }
    this._contentChanged.emit();
  }

  removeSectionWidget(widget: Widget): void {
    if (!this._accordion || widget.parent !== this._accordion) {
      return;
    }
    widget.parent = null;
    const remaining = this._accordion.widgets;
    const treeOnly = remaining.length === 1 && remaining[0] === this._section;
    if (treeOnly || remaining.length === 0) {
      if (treeOnly) {
        if (this._section.isHidden) {
          this._section.show();
        }
        this._panelLayout.addWidget(this._section);
        this._restoreToolbar();
      }
      this._accordion.dispose();
      this._accordion = null;
    }
    this._contentChanged.emit();
  }

  private _isSectionHome(): boolean {
    const parent = this._section.parent;
    return parent === this || (!!this._accordion && parent === this._accordion);
  }

  /**
   * An accordion host moves the toolbar node into the section title and leaves
   * it orphaned on detach; re-parenting makes the layout attach it again.
   */
  private _restoreToolbar(): void {
    this._toolbar.parent = null;
    this._section.insertWidget(0, this._toolbar);
  }

  private _contentsManager: Contents.IManager;
  private _docManager: IDocumentManager;
  private _onOpenFile: ((serverPath: string) => void) | undefined;
  private _translator: ITranslator | undefined;
  private _selectedPaths: readonly string[] = [];
  private _selectionChanged = new Signal<this, readonly string[]>(this);
  private _refreshRequested = new Signal<this, void>(this);
  private _pathAdded = new Signal<this, string>(this);
  private _revealRequested = new Signal<this, string>(this);
  private _rootRequested = new Signal<this, void>(this);
  private _collapseAllRequested = new Signal<this, void>(this);
  private _fileFilterVisible = false;
  private _fileFilterVisibleChanged = new Signal<this, boolean>(this);
  private _toolbar: Toolbar;
  private _content: XtralabFileTreeContent;
  private _section: PanelWithToolbar;
  private _panelLayout: PanelLayout;
  private _accordion: AccordionPanel | null = null;
  private _contentChanged = new Signal<this, void>(this);
  private _sectionAdded = new Signal<this, ISectionEntry>(this);
}

interface IFileTreeContentOptions {
  contentsManager: Contents.IManager;
  docManager: IDocumentManager;
  onOpenFile?: (serverPath: string) => void;
  translator?: ITranslator;
  browser: XtralabFileBrowser;
}

/** The React-rendered region below the toolbar that hosts the actual tree. */
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
        translator={this._options.translator}
        widget={this._options.browser}
      />
    );
  }

  private _options: IFileTreeContentOptions;
}
