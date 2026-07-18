import { Token } from '@lumino/coreutils';

/**
 * A launcher overlay that fuzzy-searches across multiple sources — workspace
 * files, JupyterLab commands — and routes a typed prompt to one of the
 * configured agents. Provided by `xtralab:omnibox` and consumed (optionally)
 * by the top-bar command bar, which opens it on click.
 */
export interface IOmnibox {
  /**
   * Open the overlay, optionally seeding the input with `query`.
   */
  open(query?: string): void;
  /**
   * Close the overlay if it is open.
   */
  close(): void;
}

/**
 * DI token for {@link IOmnibox}. Provided by `xtralab:omnibox`; consumed by
 * `xtralab:command-bar` so the top-bar pill opens the omnibox.
 */
export const IOmnibox = new Token<IOmnibox>(
  'xtralab:IOmnibox',
  'Opens the omnibox overlay that searches files and commands and prompts agents.'
);

/**
 * Command id that opens the omnibox (registered by `xtralab:omnibox`). Shared
 * here so the command bar can look up its keybinding and show a shortcut hint.
 */
export const OMNIBOX_OPEN_COMMAND = 'xtralab:omnibox:open';
