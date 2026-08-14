import { Token } from '@lumino/coreutils';

/**
 * A launcher overlay that fuzzy-searches workspace files and commands and
 * routes a typed prompt to a configured agent. Provided by `xtralab:omnibox`;
 * opened by the top-bar command bar.
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

/** DI token for {@link IOmnibox}. */
export const IOmnibox = new Token<IOmnibox>(
  'xtralab:IOmnibox',
  'Opens the omnibox overlay that searches files and commands and prompts agents.'
);

/**
 * Command id that opens the omnibox, shared so the command bar can look up
 * its keybinding for the shortcut hint.
 */
export const OMNIBOX_OPEN_COMMAND = 'xtralab:omnibox:open';
