import { PageConfig } from '@jupyterlab/coreutils';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { TranslationBundle } from '@jupyterlab/translation';
import { homeIcon as rootIcon } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import { Widget } from '@lumino/widgets';

const EDITOR_BREADCRUMBS_CLASS = 'jp-xtralab-EditorBreadcrumbs';
const TOOLBAR_SPACER_CLASS = 'jp-Toolbar-spacer';
const BREADCRUMBS_CONTAINER_CLASS = 'jp-BreadCrumbs-container';
const BREADCRUMBS_CONTENT_CLASS = 'jp-BreadCrumbs-content';
const ROOT_CLASS = 'jp-BreadCrumbs-home';
const ITEM_CLASS = 'jp-BreadCrumbs-item';
const CURRENT_ITEM_CLASS = 'jp-mod-current';
const SEPARATOR_CLASS = 'jp-BreadCrumbs-separator';

/**
 * Registered by the file browser plugin; only the name is shared here.
 */
const REVEAL_COMMAND = 'xtralab:reveal-path';

interface IEditorBreadcrumbsOptions {
  context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
  commands: CommandRegistry;
  trans: TranslationBundle;
}

/**
 * Read-only breadcrumb path for file editor toolbars: renders the open
 * file's path as clickable segments, each dispatching the reveal command.
 */
export class EditorBreadcrumbs extends Widget {
  constructor(options: IEditorBreadcrumbsOptions) {
    super({ node: document.createElement('nav') });
    this._context = options.context;
    this._commands = options.commands;
    this._trans = options.trans;
    this.addClass(EDITOR_BREADCRUMBS_CLASS);
    // ReactiveToolbar must count the stretched breadcrumbs as a spacer (2px);
    // measured at clientWidth they would evict every item into the popup.
    this.addClass(TOOLBAR_SPACER_CLASS);
    this.node.setAttribute('aria-label', this._trans.__('Editor file path'));

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
      const isLast = index === parts.length - 1;
      const subPath = parts.slice(0, index + 1).join('/');
      // Canonical @pierre/trees paths: directories carry a trailing slash.
      const canonical = isLast ? subPath : `${subPath}/`;

      const item = document.createElement('span');
      item.className = ITEM_CLASS;
      item.textContent = part;
      item.title = subPath;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      if (isLast) {
        item.classList.add(CURRENT_ITEM_CLASS);
        item.setAttribute('aria-current', 'page');
      }
      this._attachReveal(item, canonical);
      this._content.appendChild(item);

      if (!isLast) {
        this._content.appendChild(this._createSeparator());
      }
    });
  }

  private _createRootCrumb(): HTMLElement {
    const item = rootIcon.element({
      className: ROOT_CLASS,
      tag: 'span',
      title:
        PageConfig.getOption('serverRoot') ||
        this._trans.__('Jupyter Server Root'),
      stylesheet: 'breadCrumb'
    });
    item.dataset.path = '/';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    // Empty path is the workspace-root gesture; the tree has no row for
    // the root itself.
    this._attachReveal(item, '');
    return item;
  }

  /**
   * Bind click and keyboard activation on a crumb to the reveal command;
   * dispatch failures are logged, never thrown into the toolbar.
   */
  private _attachReveal(element: HTMLElement, canonicalPath: string): void {
    const fire = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      void this._commands
        .execute(REVEAL_COMMAND, { path: canonicalPath })
        .catch((err: unknown) => {
          console.error(`xtralab: failed to reveal "${canonicalPath}"`, err);
        });
    };
    element.addEventListener('click', fire);
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        fire(event);
      }
    });
  }

  private _createSeparator(): HTMLElement {
    const item = document.createElement('span');
    item.className = SEPARATOR_CLASS;
    item.setAttribute('aria-hidden', 'true');
    item.textContent = '/';
    return item;
  }

  private _context: DocumentRegistry.IContext<DocumentRegistry.IModel>;
  private _commands: CommandRegistry;
  private _trans: TranslationBundle;
  private _container: HTMLElement;
  private _content: HTMLElement;
}
