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
 * Registers xtralab's diff rendering as `jupyterlab-git`'s diff providers.
 *
 * jupyterlab-git's notebook, plain-text and image diff plugins are disabled
 * (see `package.json`); this module registers a factory in their place via
 * `registerDiffProvider` / `registerFallbackDiffProvider`. The upstream git
 * panel, commands, status bar and context menus keep working unchanged — only
 * the rendered diff is xtralab's.
 *
 * The factory builds the shared {@link XtralabDiffWidget} from the
 * `Git.Diff.IModel` jupyterlab-git supplies, so a diff opened from the git
 * panel is the very same widget the launcher dashboard opens (the launcher
 * just builds its model from an `IFileChange` instead — see `diffModel.ts`).
 */

/**
 * Build the `Git.Diff.Factory` xtralab registers with jupyterlab-git. The
 * factory closes over the application-level context (contents manager for
 * hunk discard, rendermime for notebook outputs, theme manager) that
 * `Git.Diff.IFactoryOptions` does not carry.
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

    // Notebooks and raster images get extension-specific providers; every
    // other text file falls back to the same factory. One factory serves all
    // three — the surface auto-detects notebooks/images by filename.
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
