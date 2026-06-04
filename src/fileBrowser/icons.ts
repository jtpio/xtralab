import { LabIcon, fileIcon } from '@jupyterlab/ui-components';
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet
} from '@pierre/trees';
import type { FileTreeIconConfig } from '@pierre/trees';

/**
 * The glyph used as the xtralab file browser's sidebar tab icon. Defined as a
 * `LabIcon` (rather than the default `folderIcon` from
 * `@jupyterlab/ui-components`) so the xtralab browser is visually distinguishable
 * from JupyterLab's built-in file browser, which also lives in the left
 * sidebar.
 *
 * Source: `file-tree` from SVG Repo (https://www.svgrepo.com/svg/371275/file-tree).
 * The original `fill="#444"` is replaced with `fill="currentColor"` and the
 * root element is given the `jp-icon3` class so the icon picks up JupyterLab's
 * theme color and the sidebar's inverse-color painting automatically.
 */
export const xtralabFileBrowserIcon = new LabIcon({
  name: 'xtralab:file-browser',
  svgstr: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" class="jp-icon3" fill="currentColor">
  <path d="M16 10v-4h-11v1h-2v-3h9v-4h-12v4h2v10h3v2h11v-4h-11v1h-2v-5h2v2z"/>
</svg>`
});

/**
 * Sprite sheet injected into the `@pierre/trees` shadow DOM. Contains a single
 * `<symbol>` for the Jupyter notebook icon, drawn from the JupyterLab core
 * notebook icon (`@jupyterlab/ui-components/style/icons/filetype/notebook.svg`).
 *
 * `@pierre/trees` does not ship a Jupyter token, so `.ipynb` files would
 * otherwise fall through to the generic file icon. The symbol id below is
 * referenced from `byFileExtension` in {@link FILE_BROWSER_ICONS}.
 *
 * The orange `#EF6C00` fill is set as a presentation attribute on the inner
 * `<g>` so it survives the `fill: currentColor` rule the tree applies on the
 * icon container — the inherited color does not override a presentation
 * attribute set directly on a child.
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
 * Icon configuration for the xtralab file browser. Keeps the default `complete`
 * built-in icon set (the colored language icons) and layers a Jupyter notebook
 * symbol on top so `.ipynb` files render with the JupyterLab notebook glyph.
 *
 * `set` must be set explicitly: when a config object includes any custom
 * overrides without `set`, `@pierre/trees` defaults `set` to `'none'`, which
 * disables the built-in icons entirely.
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
 * Concatenated sprite-sheet text. Combines the built-in sheet for the active
 * icon set with our custom Jupyter notebook sheet so {@link extractSymbol}
 * can find the body of any symbol the tree itself can render.
 */
const COMBINED_SPRITE_SHEETS = [
  getBuiltInSpriteSheet(FILE_BROWSER_ICONS.set ?? 'complete'),
  JUPYTER_NOTEBOOK_SPRITE_SHEET
].join('\n');

/**
 * Resolver instance reused across calls to {@link getTreeIcon}. The resolver
 * is pure relative to the icon config, so building it once at module load
 * avoids re-walking the icon rules on every diff that opens.
 */
const treeIconResolver = createFileTreeIconResolver(FILE_BROWSER_ICONS);

/**
 * Cache of LabIcons keyed by the resolved sprite symbol id (e.g.
 * `file-tree-builtin-python`). All Python files share the same icon, so
 * caching by symbol id prevents repeated LabIcon registration warnings and
 * keeps the JupyterLab icon registry small.
 */
const TREE_ICON_CACHE = new Map<string, LabIcon>();

/**
 * Extract the inner SVG markup and viewBox of the `<symbol>` with the given
 * id from {@link COMBINED_SPRITE_SHEETS}. Returns `null` if no matching
 * symbol exists, in which case the caller falls back to JupyterLab's default
 * file icon.
 */
function extractSymbol(
  symbolId: string
): { viewBox: string; inner: string } | null {
  // Match a `<symbol>` whose `id` attribute equals `symbolId` (allowing other
  // attributes in any order). The `[\s\S]*?` body is non-greedy so we stop
  // at the first matching `</symbol>` even when multiple symbols sit
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
 * Fallback colors for the built-in file icons, keyed by the icon token
 * `@pierre/trees` resolves for a path (e.g. `python`, `typescript`).
 *
 * The tree only exposes these as `--trees-file-icon-color-<token>` CSS
 * variables scoped to its shadow host, so they resolve to nothing for the
 * standalone {@link LabIcon}s {@link getTreeIcon} builds for main-area tabs.
 * Mirroring them here lets {@link getBuiltInFileIconColor} bottom out in a
 * real color. Each is a `light-dark(…)` pair for dark themes.
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
 * Color the file tree would paint for the built-in icon `token`, as a
 * self-contained CSS value usable outside the tree's shadow DOM: the tree's
 * `--trees-file-icon-color-*` properties when in scope, else the literal from
 * {@link BUILT_IN_FILE_ICON_COLOR_FALLBACKS}. Returns `undefined` for unknown
 * tokens.
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
  // Built-in language icons paint with `fill="currentColor"` so the colored
  // tier of the tree can recolor them by setting `color` on the host
  // element. Reproduce that here by setting the same color value as an
  // inline `style="color: …"` on the outer `<svg>`. `getBuiltInFileIconColor`
  // returns a `var(--trees-…)` chain that bottoms out in `light-dark(…)`,
  // which respects the page's `color-scheme` declaration so dark themes pick
  // up the brighter variants automatically.
  const colored = FILE_BROWSER_ICONS.colored === true;
  const color =
    colored && resolved.token !== undefined
      ? getBuiltInFileIconColor(resolved.token)
      : undefined;
  const styleAttr = color !== undefined ? ` style="color: ${color};"` : '';
  // Prefer a viewBox the resolver supplies (custom sprite overrides may set
  // one), then fall back to the symbol's own viewBox so 22x22 sprites like
  // the Jupyter notebook glyph render at the right scale rather than being
  // cropped to a 16x16 box.
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
