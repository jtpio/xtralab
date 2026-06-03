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
 * Common source extensions `@pierre/trees` has a glyph for but JupyterLab ships
 * no file type for. Registering a file type for each lets the surfaces that
 * resolve icons only through the document registry — including the git history
 * and commit-comparison lists, which load files asynchronously and expose no
 * signal to decorate — paint the tree glyph as well. Extensions an existing
 * file type already claims, or that the tree has no specific glyph for, are
 * skipped.
 */
const EXTRA_FILE_TYPE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.go',
  '.rs',
  '.rb',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.hpp',
  '.swift',
  '.zig',
  '.vue',
  '.svelte',
  '.astro',
  '.scss',
  '.sass',
  '.sh',
  '.bash',
  '.zsh',
  '.graphql',
  '.wasm'
];

/**
 * Register a tree-iconed file type for each extension in
 * {@link EXTRA_FILE_TYPE_EXTENSIONS} the registry does not already cover. The
 * types carry no widget factory, so files still open through JupyterLab's
 * default editor; only the icon (and content type) is contributed.
 */
function registerExtraFileTypes(docRegistry: DocumentRegistry): void {
  for (const extension of EXTRA_FILE_TYPE_EXTENSIONS) {
    const icon = getSpecificTreeIcon(`file${extension}`);
    if (icon === null) {
      continue;
    }
    const claimed = docRegistry
      .getFileTypesForPath(`file${extension}`)
      .some(fileType =>
        fileType.extensions?.some(e => e.toLowerCase() === extension)
      );
    if (claimed) {
      continue;
    }
    docRegistry.addFileType({
      name: `xtralab:file-type:${extension.slice(1)}`,
      extensions: [extension],
      icon,
      contentType: 'file',
      fileFormat: 'text'
    });
  }
}

/**
 * Give the xtralab file browser's `@pierre/trees` glyphs to the other places
 * JupyterLab paints per-file icons. Each surface resolves a file's icon
 * differently, so each is handled at its own source:
 *
 *   - The default file browser and `jupyterlab-git`'s history and
 *     commit-comparison lists resolve a file's icon from its
 *     `DocumentRegistry` file type, so existing types are re-skinned and types
 *     for extensions JupyterLab ships none for (e.g. `.ts`, `.tsx`) are
 *     registered.
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
    registerExtraFileTypes(docRegistry);
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
