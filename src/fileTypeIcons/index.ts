import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IDocumentWidgetOpener } from '@jupyterlab/docmanager';

import { DocumentRegistry } from '@jupyterlab/docregistry';

import { IGitExtension } from '@jupyterlab/git';

import { LabIcon } from '@jupyterlab/ui-components';

import { getSpecificTreeIcon } from '../fileBrowser/icons';

const PLUGIN_ID = 'xtralab:file-type-icons';

/**
 * The path the `@pierre/trees` resolver should see for a file type. The
 * resolver keys off the basename, so a synthetic `file<ext>` built from the
 * type's first extension is enough to resolve its language glyph. Types that
 * match only by pattern (no extension, e.g. directories) have no representative
 * path and keep their JupyterLab icon.
 */
function representativePath(
  fileType: DocumentRegistry.IFileType
): string | null {
  const extension = fileType.extensions?.[0];
  if (extension === undefined || extension === '') {
    return null;
  }
  // Extensions are stored with a leading dot (e.g. `.py`, `.tar.gz`).
  return `file${extension.startsWith('.') ? extension : `.${extension}`}`;
}

/**
 * Point a file type's icon at the tree glyph for its extension, leaving types
 * the tree has no specific glyph for on their existing icon.
 *
 * `IFileType.icon` is declared `readonly`, but the document registry hands back
 * the very objects it stores, so assigning in place updates the icon the
 * default file browser — which reads the file type live on every render —
 * paints.
 */
function applyTreeIcon(fileType: DocumentRegistry.IFileType): void {
  const path = representativePath(fileType);
  if (path === null) {
    return;
  }
  const icon = getSpecificTreeIcon(path);
  if (icon === null) {
    return;
  }
  (fileType as { icon?: LabIcon }).icon = icon;
}

/**
 * Give the xtralab file browser's `@pierre/trees` glyphs to the other places
 * JupyterLab paints per-file icons. Each surface resolves a file's icon
 * differently, so each is handled at its own source:
 *
 *   - The default file browser reads `DocumentRegistry.IFileType.icon` live on
 *     every render, so re-skinning the registry's file types reaches it.
 *   - A document tab takes its icon from its widget factory when the widget is
 *     created, so the glyph is set on the widget's `title` as it opens.
 *   - `jupyterlab-git`'s status panel resolves each file's type once and renders
 *     it through a memoized component, so the glyph is set on the git model's
 *     status files as they change.
 *
 * Only files the tree has a specific glyph for are touched, so an extension's
 * own icon for a type the tree does not know is never replaced with a generic
 * one. The xtralab file browser needs nothing here: it resolves icons through
 * the `@pierre/trees` resolver directly.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    "Gives the file browser's @pierre/trees glyphs to document tabs, the default file browser, and the git status panel.",
  autoStart: true,
  optional: [IDocumentWidgetOpener, IGitExtension],
  activate: (
    app: JupyterFrontEnd,
    opener: IDocumentWidgetOpener | null,
    gitExtension: IGitExtension | null
  ): void => {
    const { docRegistry } = app;
    for (const fileType of docRegistry.fileTypes()) {
      applyTreeIcon(fileType);
    }
    // File types other extensions register after this plugin activates still
    // pick up the tree glyph.
    docRegistry.changed.connect((_, args) => {
      if (
        args.type === 'fileType' &&
        args.change === 'added' &&
        args.name !== undefined
      ) {
        const fileType = docRegistry.getFileType(args.name);
        if (fileType !== undefined) {
          applyTreeIcon(fileType);
        }
      }
    });

    if (opener !== null) {
      opener.opened.connect((_, widget) => {
        const setIcon = (): void => {
          const icon = getSpecificTreeIcon(widget.context.path);
          if (icon !== null) {
            widget.title.icon = icon;
          }
        };
        setIcon();
        // Keep the tab icon right when the document is renamed to a new
        // extension. The connection clears when the context is disposed.
        widget.context.pathChanged.connect(setIcon);
      });
    }

    if (gitExtension !== null) {
      gitExtension.statusChanged.connect((_, status) => {
        for (const file of status.files) {
          if (file.type === undefined) {
            continue;
          }
          const icon = getSpecificTreeIcon(file.to);
          if (icon === null) {
            continue;
          }
          // @jupyterlab/git compiles against its own nested copy of
          // @jupyterlab/ui-components, so its `IFileType.icon` is a nominally
          // distinct `LabIcon` from `getSpecificTreeIcon`'s; the shared runtime
          // singleton makes them one. Cast across that package boundary.
          file.type = { ...file.type, icon } as unknown as typeof file.type;
        }
      });
    }
  }
};

export default plugin;
