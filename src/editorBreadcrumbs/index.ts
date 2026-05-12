import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type {
  DocumentRegistry,
  IDocumentWidget
} from '@jupyterlab/docregistry';
import type { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';

import { EditorBreadcrumbs } from './widget';

const PLUGIN_ID = 'xtralab:editor-breadcrumbs';
const EDITOR_FACTORY = 'Editor';
const TOOLBAR_ITEM_NAME = 'xtralab-editor-breadcrumbs';

class EditorBreadcrumbsExtension implements DocumentRegistry.IWidgetExtension<
  IDocumentWidget<Widget, DocumentRegistry.IModel>,
  DocumentRegistry.IModel
> {
  constructor(commands: CommandRegistry) {
    this._commands = commands;
  }

  createNew(
    widget: IDocumentWidget<Widget, DocumentRegistry.IModel>,
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>
  ): IDisposable | void {
    const breadcrumbs = new EditorBreadcrumbs({
      context,
      commands: this._commands
    });
    const added = widget.toolbar.insertItem(0, TOOLBAR_ITEM_NAME, breadcrumbs);

    if (!added) {
      breadcrumbs.dispose();
      return;
    }

    return new DisposableDelegate(() => {
      breadcrumbs.dispose();
    });
  }

  private _commands: CommandRegistry;
}

/**
 * Adds a VS Code-style path breadcrumb to text editor toolbars. Each
 * segment is clickable: clicking dispatches `xtralab:reveal-path` so
 * any plugin that listens (today, the file browser) can surface the
 * underlying folder or file. The breadcrumbs plugin therefore does not
 * import the file browser at all — the JupyterLab command registry is
 * the only seam between them.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Display the active file path in text editor toolbars.',
  autoStart: true,
  activate: (app: JupyterFrontEnd): void => {
    app.docRegistry.addWidgetExtension(
      EDITOR_FACTORY,
      new EditorBreadcrumbsExtension(app.commands)
    );
  }
};

export default plugin;
