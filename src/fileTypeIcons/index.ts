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
 * Synthetic path used to resolve a file type's tree glyph.
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
 * Point a file type's icon at the tree glyph for its extension.
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
  // The registry owns these objects; `readonly` only blocks the type shape.
  (fileType as { icon?: LabIcon }).icon = icon;
}

/**
 * Source extensions with tree glyphs but no default JupyterLab file type.
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
 * Register icon-only file types for unclaimed source extensions.
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
 * Share the file browser's tree glyphs with tabs and git file lists.
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
    // Pick up file types registered after this plugin activates.
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
        // Keep the tab icon right after a rename.
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
          // Cross jupyterlab-git's nested `LabIcon` package boundary.
          file.type = { ...file.type, icon } as unknown as typeof file.type;
        }
      });
    }
  }
};

export default plugin;
