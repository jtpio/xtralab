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
    // jupyterlab-git only refreshes through a manual button xtralab hides, so
    // re-pull when the model changes. The editable surface adopts a reload
    // only once there are no unsaved edits, so refreshing mid-edit is safe.
    const onModelChanged = (): void => {
      void widget.refresh();
    };
    options.model.changed.connect(onModelChanged);
    widget.disposed.connect(() => {
      options.model.changed.disconnect(onModelChanged);
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
