import { LabIcon, fileIcon } from '@jupyterlab/ui-components';
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet
} from '@pierre/trees';
import type { FileTreeIconConfig } from '@pierre/trees';

/**
 * Sidebar tab icon, distinct from the core `folderIcon` so the xtralab
 * browser is distinguishable from the built-in one. `file-tree` from SVG Repo
 * (https://www.svgrepo.com/svg/371275/file-tree), refit with
 * `fill="currentColor"` and `jp-icon3` so it follows the theme.
 */
export const xtralabFileBrowserIcon = new LabIcon({
  name: 'xtralab:file-browser',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="jp-icon3" fill="currentColor">
  <path d="M16 10v-4h-11v1h-2v-3h9v-4h-12v4h2v10h3v2h11v-4h-11v1h-2v-5h2v2z"/>
</svg>`
});

/**
 * Sprite sheet injected into the tree's shadow DOM: the JupyterLab notebook
 * glyph, since `@pierre/trees` ships no Jupyter token. The `#EF6C00` fill is
 * a presentation attribute on the inner `<g>` so it survives the tree's
 * `fill: currentColor` rule on the icon container.
 */
const JUPYTER_NOTEBOOK_SPRITE_SHEET = `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="jupyter-notebook" viewBox="0 0 22 22">
    <g fill="#EF6C00">
      <path d="M18.7 3.3v15.4H3.3V3.3zm1.5-1.5H1.8v18.3h18.3z"/>
      <path d="m16.5 16.5-5.4-4.3-5.6 4.3v-11h11z"/>
    </g>
  </symbol>
</svg>`;

/**
 * Icon config: the built-in `complete` set plus the Jupyter notebook symbol
 * for `.ipynb`. `set` must be explicit — with any custom overrides present,
 * `@pierre/trees` defaults it to `'none'`, disabling the built-in icons.
 */
export const FILE_BROWSER_ICONS: FileTreeIconConfig = {
  set: 'complete',
  colored: true,
  spriteSheet: JUPYTER_NOTEBOOK_SPRITE_SHEET,
  byFileExtension: {
    ipynb: 'jupyter-notebook'
  }
};

/**
 * Built-in sheet plus the notebook sheet, so {@link extractSymbol} can find
 * any symbol the tree itself can render.
 */
const COMBINED_SPRITE_SHEETS = [
  getBuiltInSpriteSheet(FILE_BROWSER_ICONS.set ?? 'complete'),
  JUPYTER_NOTEBOOK_SPRITE_SHEET
].join('\n');

/** Shared resolver; pure relative to the icon config, so built once. */
const treeIconResolver = createFileTreeIconResolver(FILE_BROWSER_ICONS);

/**
 * LabIcons keyed by resolved symbol id — re-registering a LabIcon under the
 * same name logs warnings.
 */
const TREE_ICON_CACHE = new Map<string, LabIcon>();

/**
 * Inner SVG markup and viewBox of the `<symbol>` with the given id in
 * {@link COMBINED_SPRITE_SHEETS}, or `null` when absent.
 */
function extractSymbol(
  symbolId: string
): { viewBox: string; inner: string } | null {
  // Non-greedy body: stop at the first `</symbol>` when symbols sit
  // back-to-back in the sheet.
  const escaped = symbolId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const symbolRegex = new RegExp(
    `<symbol\\b[^>]*\\bid="${escaped}"[^>]*>([\\s\\S]*?)</symbol>`,
    'i'
  );
  const match = symbolRegex.exec(COMBINED_SPRITE_SHEETS);
  if (match === null) {
    return null;
  }
  const viewBoxMatch = /\bviewBox="([^"]*)"/i.exec(match[0]);
  return {
    viewBox: viewBoxMatch?.[1] ?? '0 0 16 16',
    inner: match[1]
  };
}

/**
 * Fallback colors keyed by the tree's icon token. The tree exposes its colors
 * only as `--trees-file-icon-color-*` vars scoped to its shadow host, so the
 * standalone LabIcons built for main-area tabs need these literals;
 * `light-dark(…)` covers dark themes.
 */
const BUILT_IN_FILE_ICON_COLOR_FALLBACKS: Record<string, string> = {
  astro: 'light-dark(#a631be, #d568ea)',
  babel: 'light-dark(#d5a910, #ffd452)',
  bash: 'light-dark(#199f43, #5ecc71)',
  biome: 'light-dark(#1a85d4, #69b1ff)',
  bootstrap: 'light-dark(#693acf, #9d6afb)',
  browserslist: 'light-dark(#d5a910, #ffd452)',
  bun: 'light-dark(#594c5b, #79697b)',
  c: 'light-dark(#1a85d4, #69b1ff)',
  claude: 'light-dark(#d47628, #ffa359)',
  cpp: 'light-dark(#1a85d4, #69b1ff)',
  css: 'light-dark(#693acf, #9d6afb)',
  database: 'light-dark(#a631be, #d568ea)',
  default: 'light-dark(#84848a, #adadb1)',
  docker: 'light-dark(#1a85d4, #69b1ff)',
  eslint: 'light-dark(#693acf, #9d6afb)',
  git: 'light-dark(#ff8c5b, #d5512f)',
  go: 'light-dark(#1ca1c7, #68cdf2)',
  graphql: 'light-dark(#d32a61, #ff678d)',
  html: 'light-dark(#d47628, #ffa359)',
  image: 'light-dark(#d32a61, #ff678d)',
  javascript: 'light-dark(#d5a910, #ffd452)',
  json: 'light-dark(#d47628, #ffa359)',
  markdown: 'light-dark(#199f43, #5ecc71)',
  mcp: 'light-dark(#17a5af, #64d1db)',
  npm: 'light-dark(#d52c36, #ff6762)',
  oxc: 'light-dark(#1ca1c7, #68cdf2)',
  postcss: 'light-dark(#d52c36, #ff6762)',
  prettier: 'light-dark(#17a5af, #64d1db)',
  python: 'light-dark(#1a85d4, #69b1ff)',
  react: 'light-dark(#1ca1c7, #68cdf2)',
  ruby: 'light-dark(#d52c36, #ff6762)',
  rust: 'light-dark(#d47628, #ffa359)',
  sass: 'light-dark(#d32a61, #ff678d)',
  svelte: 'light-dark(#d52c36, #ff6762)',
  svg: 'light-dark(#d47628, #ffa359)',
  svgo: 'light-dark(#199f43, #5ecc71)',
  swift: 'light-dark(#d47628, #ffa359)',
  table: 'light-dark(#17a5af, #64d1db)',
  tailwind: 'light-dark(#1ca1c7, #68cdf2)',
  terraform: 'light-dark(#693acf, #9d6afb)',
  text: 'light-dark(#84848a, #adadb1)',
  typescript: 'light-dark(#1a85d4, #69b1ff)',
  vite: 'light-dark(#a631be, #d568ea)',
  vscode: 'light-dark(#1a85d4, #69b1ff)',
  vue: 'light-dark(#199f43, #5ecc71)',
  wasm: 'light-dark(#693acf, #9d6afb)',
  webpack: 'light-dark(#1a85d4, #69b1ff)',
  yml: 'light-dark(#d52c36, #ff6762)',
  zig: 'light-dark(#d47628, #ffa359)',
  zip: 'light-dark(#d47628, #ffa359)'
};

/**
 * The tree's color for `token` as a self-contained CSS value: its CSS vars
 * when in scope, else the mirrored literal. `undefined` for unknown tokens.
 */
function getBuiltInFileIconColor(token: string): string | undefined {
  const fallback = BUILT_IN_FILE_ICON_COLOR_FALLBACKS[token];
  if (fallback === undefined) {
    return undefined;
  }
  return `var(--trees-file-icon-color-${token}, var(--trees-file-icon-color, ${fallback}))`;
}

/**
 * Resolve a tree glyph into a standalone `LabIcon`.
 */
function resolveTreeIcon(filePath: string): {
  icon: LabIcon | null;
  specific: boolean;
} {
  const resolved = treeIconResolver.resolveIcon(
    'file-tree-icon-file',
    filePath
  );
  // Anything other than the catch-all glyph is specific to this file.
  const specific =
    resolved.token !== 'default' && resolved.name !== 'file-tree-icon-file';
  const cached = TREE_ICON_CACHE.get(resolved.name);
  if (cached !== undefined) {
    return { icon: cached, specific };
  }
  const symbol = extractSymbol(resolved.name);
  if (symbol === null) {
    return { icon: null, specific };
  }
  // Built-in glyphs paint with `fill="currentColor"`; an inline `color`
  // style reproduces the tree's colored tier outside its shadow DOM.
  const colored = FILE_BROWSER_ICONS.colored === true;
  const color =
    colored && resolved.token !== undefined
      ? getBuiltInFileIconColor(resolved.token)
      : undefined;
  const styleAttr = color !== undefined ? ` style="color: ${color};"` : '';
  // Prefer the resolver's viewBox, then the symbol's own, so 22x22 sprites
  // like the notebook glyph aren't cropped to a 16x16 box.
  const viewBox = resolved.viewBox ?? symbol.viewBox;
  const svgstr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${styleAttr}>${symbol.inner}</svg>`;
  const icon = new LabIcon({
    name: `xtralab:tree-icon-${resolved.name}`,
    svgstr
  });
  TREE_ICON_CACHE.set(resolved.name, icon);
  return { icon, specific };
}

/**
 * Return the icon the xtralab file tree would render for `filePath`.
 */
export function getTreeIcon(filePath: string): LabIcon {
  return resolveTreeIcon(filePath).icon ?? fileIcon;
}

/**
 * Like {@link getTreeIcon}, but returns `null` for the generic file glyph.
 */
export function getSpecificTreeIcon(filePath: string): LabIcon | null {
  const { icon, specific } = resolveTreeIcon(filePath);
  return specific ? icon : null;
}
