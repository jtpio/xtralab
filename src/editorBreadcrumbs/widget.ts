import { PageConfig } from '@jupyterlab/coreutils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import { homeIcon as rootIcon } from '@jupyterlab/ui-components';
import { Widget } from '@lumino/widgets';

const EDITOR_BREADCRUMBS_CLASS = 'jp-xtralab-EditorBreadcrumbs';
const BREADCRUMBS_CONTAINER_CLASS = 'jp-BreadCrumbs-container';
const BREADCRUMBS_CONTENT_CLASS = 'jp-BreadCrumbs-content';
const ROOT_CLASS = 'jp-BreadCrumbs-home';
const ITEM_CLASS = 'jp-BreadCrumbs-item';
const CURRENT_ITEM_CLASS = 'jp-mod-current';
const SEPARATOR_CLASS = 'jp-BreadCrumbs-separator';

export interface IEditorBreadcrumbsOptions {
  context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
}

/**
 * Read-only breadcrumb path for file editor toolbars.
 *
 * The upstream `@jupyterlab/filebrowser` BreadCrumbs widget is coupled to
 * FileBrowserModel navigation, drag/drop, and path editing. If that code
 * becomes reusable upstream, replace this local display-only renderer with
 * the shared implementation.
 */
export class EditorBreadcrumbs extends Widget {
  constructor(options: IEditorBreadcrumbsOptions) {
    super({ node: document.createElement('nav') });
    this._context = options.context;
    this.addClass(EDITOR_BREADCRUMBS_CLASS);
    this.node.setAttribute('aria-label', 'Editor file path');

    this._container = document.createElement('span');
    this._container.className = BREADCRUMBS_CONTAINER_CLASS;
    this._content = document.createElement('span');
    this._content.className = BREADCRUMBS_CONTENT_CLASS;
    this._container.appendChild(this._content);
    this.node.appendChild(this._container);

    this._context.pathChanged.connect(this._onPathChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._context.pathChanged.disconnect(this._onPathChanged, this);
    super.dispose();
  }

  private _onPathChanged(): void {
    this._render();
  }

  private _render(): void {
    const path = this._context.localPath || this._context.path;
    const parts = path.split('/').filter(part => part.length > 0);

    this.node.title = this._context.path;
    this._content.textContent = '';
    this._content.appendChild(this._createRootCrumb());
    if (parts.length > 0) {
      this._content.appendChild(this._createSeparator());
    }

    parts.forEach((part, index) => {
      const item = document.createElement('span');
      item.className = ITEM_CLASS;
      item.textContent = part;
      item.title = parts.slice(0, index + 1).join('/');
      if (index === parts.length - 1) {
        item.classList.add(CURRENT_ITEM_CLASS);
        item.setAttribute('aria-current', 'page');
      }
      this._content.appendChild(item);

      if (index < parts.length - 1) {
        this._content.appendChild(this._createSeparator());
      }
    });
  }

  private _createRootCrumb(): HTMLElement {
    const item = rootIcon.element({
      className: ROOT_CLASS,
      tag: 'span',
      title: PageConfig.getOption('serverRoot') || 'Jupyter Server Root',
      stylesheet: 'breadCrumb'
    });
    item.dataset.path = '/';
    item.tabIndex = -1;
    return item;
  }

  private _createSeparator(): HTMLElement {
    const item = document.createElement('span');
    item.className = SEPARATOR_CLASS;
    item.setAttribute('aria-hidden', 'true');
    item.textContent = '/';
    return item;
  }

  private _context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
  private _container: HTMLElement;
  private _content: HTMLElement;
}
