import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IThemeManager } from '@jupyterlab/apputils';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { Git, IGitExtension } from '@jupyterlab/git';

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
    return widget;
  };
}

const diffProviderPlugin: JupyterFrontEndPlugin<void> = {
  id: 'xtralab:git-diff-providers',
  description:
    "Replaces jupyterlab-git's notebook, text and image diff plugins with xtralab's renderer.",
  autoStart: true,
  requires: [IGitExtension],
  optional: [IRenderMimeRegistry, IThemeManager],
  activate: (
    app: JupyterFrontEnd,
    gitExtension: IGitExtension,
    rendermime: IRenderMimeRegistry | null,
    themeManager: IThemeManager | null
  ): void => {
    const factory = makeXtralabDiffFactory({
      contentsManager: app.serviceManager.contents,
      rendermime,
      themeManager
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
