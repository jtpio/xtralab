import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Git, IGitExtension } from '@jupyterlab/git';

import { IAskAgent } from '../askAgent/tokens';

import {
  IXtralabDiffContext,
  XtralabDiffWidget,
  addDiffToolbarItems
} from './diffWidget';
import { IMAGE_DIFF_EXTENSIONS } from './imageDiff';

/**
 * Build the `Git.Diff.Factory` registered with jupyterlab-git.
 */
function makeXtralabDiffFactory(
  context: IXtralabDiffContext
): Git.Diff.Factory {
  return async (options: Git.Diff.IFactoryOptions) => {
    const widget = new XtralabDiffWidget(options.model, context);
    if (options.toolbar) {
      addDiffToolbarItems(options.toolbar, widget);
    }
    // jupyterlab-git only refreshes the diff through a manual Refresh button,
    // which xtralab hides, so re-pull automatically when the model changes.
    // While editing, the editor owns the view and its own autosaves fire
    // `changed`, so defer the reload until the session ends.
    let refreshPending = false;
    const onModelChanged = (): void => {
      if (widget.editing) {
        refreshPending = true;
        return;
      }
      void widget.refresh();
    };
    const onEditingChanged = (): void => {
      if (!widget.editing && refreshPending) {
        refreshPending = false;
        void widget.refresh();
      }
    };
    options.model.changed.connect(onModelChanged);
    widget.editingChanged.connect(onEditingChanged);
    widget.disposed.connect(() => {
      options.model.changed.disconnect(onModelChanged);
      widget.editingChanged.disconnect(onEditingChanged);
    });
    return widget;
  };
}

const diffProviderPlugin: JupyterFrontEndPlugin<void> = {
  id: 'xtralab:git-diff-providers',
  description:
    "Replaces jupyterlab-git's notebook, text and image diff plugins with xtralab's renderer.",
  autoStart: true,
  requires: [IGitExtension],
  optional: [IRenderMimeRegistry, IThemeManager, ITranslator, IAskAgent],
  activate: (
    app: JupyterFrontEnd,
    gitExtension: IGitExtension,
    rendermime: IRenderMimeRegistry | null,
    themeManager: IThemeManager | null,
    translator: ITranslator | null,
    askAgent: IAskAgent | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const factory = makeXtralabDiffFactory({
      contentsManager: app.serviceManager.contents,
      rendermime,
      themeManager,
      askAgent,
      trans
    });

    // Use one shared factory; the surface detects notebooks/images by filename.
    gitExtension.registerDiffProvider('XtralabNotebook', ['.ipynb'], factory);
    gitExtension.registerDiffProvider(
      'XtralabImage',
      IMAGE_DIFF_EXTENSIONS,
      factory
    );
    gitExtension.registerFallbackDiffProvider(factory);
  }
};

export default diffProviderPlugin;
