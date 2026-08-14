import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type {
  DocumentRegistry,
  IDocumentWidget
} from '@jupyterlab/docregistry';
import {
  ITranslator,
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import type { Widget } from '@lumino/widgets';

import { EditorBreadcrumbs } from './widget';

const PLUGIN_ID = 'xtralab:editor-breadcrumbs';
const EDITOR_FACTORY = 'Editor';
const TOOLBAR_ITEM_NAME = 'xtralab-editor-breadcrumbs';

/**
 * A widget extension that adds an `EditorBreadcrumbs` item to the toolbar of
 * each new editor widget.
 */
class EditorBreadcrumbsExtension implements DocumentRegistry.IWidgetExtension<
  IDocumentWidget<Widget, DocumentRegistry.IModel>,
  DocumentRegistry.IModel
> {
  constructor(commands: CommandRegistry, trans: TranslationBundle) {
    this._commands = commands;
    this._trans = trans;
  }

  /**
   * Create the breadcrumbs toolbar item for a new editor widget.
   */
  createNew(
    widget: IDocumentWidget<Widget, DocumentRegistry.IModel>,
    context: DocumentRegistry.IContext<DocumentRegistry.IModel>
  ): IDisposable | void {
    const breadcrumbs = new EditorBreadcrumbs({
      context,
      commands: this._commands,
      trans: this._trans
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
  private _trans: TranslationBundle;
}

/**
 * Adds a clickable path breadcrumb to text editor toolbars. Clicks dispatch
 * `xtralab:reveal-path`; the command registry is the only seam with the file
 * browser.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Display the active file path in text editor toolbars.',
  autoStart: true,
  optional: [ITranslator],
  activate: (app: JupyterFrontEnd, translator: ITranslator | null): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    app.docRegistry.addWidgetExtension(
      EDITOR_FACTORY,
      new EditorBreadcrumbsExtension(app.commands, trans)
    );
  }
};

export default plugin;
