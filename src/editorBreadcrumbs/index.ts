import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type {
  DocumentRegistry,
  IDocumentWidget
} from '@jupyterlab/docregistry';
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
  createNew(
    widget: IDocumentWidget<Widget, DocumentRegistry.IModel>,
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>
  ): IDisposable | void {
    const breadcrumbs = new EditorBreadcrumbs({ context });
    const added = widget.toolbar.insertItem(0, TOOLBAR_ITEM_NAME, breadcrumbs);

    if (!added) {
      breadcrumbs.dispose();
      return;
    }

    return new DisposableDelegate(() => {
      breadcrumbs.dispose();
    });
  }
}

/**
 * Adds a VS Code-style read-only path breadcrumb to text editor toolbars.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Display the active file path in text editor toolbars.',
  autoStart: true,
  activate: (app: JupyterFrontEnd): void => {
    app.docRegistry.addWidgetExtension(
      EDITOR_FACTORY,
      new EditorBreadcrumbsExtension()
    );
  }
};

export default plugin;
