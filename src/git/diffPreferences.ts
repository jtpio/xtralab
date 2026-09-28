import * as React from 'react';

import type { ISettingRegistry } from '@jupyterlab/settingregistry';
import type { IStateDB } from '@jupyterlab/statedb';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

export type DiffStyle = 'split' | 'unified';

export type DiffStyleControlMode = 'buttons' | 'toggle';

export type NotebookDiffViewMode = 'notebook' | 'json';

export type ImageDiffViewMode = '2-up' | 'swipe' | 'onion';

export const MIN_SPLIT_RATIO = 0.1;
export const MAX_SPLIT_RATIO = 0.9;
export const DEFAULT_SPLIT_RATIO = 0.5;

const SPLIT_RATIO_STATE_KEY = 'xtralab:git-diff:split-ratio';

/**
 * Display choices shared by every diff view. The toggles live in the
 * plugin settings; the split width lives in the state database.
 */
export interface IDiffPreferences {
  /**
   * The current values; a new object after each change.
   */
  readonly values: IDiffPreferences.IValues;
  /**
   * A signal emitted when any value changes.
   */
  readonly changed: ISignal<IDiffPreferences, void>;
  /**
   * Change some values and persist them.
   */
  update(values: Partial<IDiffPreferences.IValues>): void;
}

export namespace IDiffPreferences {
  /**
   * The diff display values.
   */
  export interface IValues {
    /**
     * Split or unified layout for textual file diffs.
     */
    diffStyle: DiffStyle;
    /**
     * Two toolbar buttons for the layout, or one button that toggles it.
     */
    diffStyleControl: DiffStyleControlMode;
    /**
     * Whether long lines wrap instead of scrolling horizontally.
     */
    lineWrap: boolean;
    /**
     * Rendered or JSON view for notebook diffs.
     */
    notebookViewMode: NotebookDiffViewMode;
    /**
     * Comparison mode for image diffs.
     */
    imageViewMode: ImageDiffViewMode;
    /**
     * Width of the left pane in split view, as a fraction of the diff width.
     */
    splitRatio: number;
  }
}

export const IDiffPreferences = new Token<IDiffPreferences>(
  'xtralab:IDiffPreferences',
  'Display choices shared by the git diff views.'
);

type SettingKey = Exclude<keyof IDiffPreferences.IValues, 'splitRatio'>;

const SETTING_KEYS: SettingKey[] = [
  'diffStyle',
  'diffStyleControl',
  'lineWrap',
  'notebookViewMode',
  'imageViewMode'
];

/**
 * {@link IDiffPreferences} backed by the settings registry and the state
 * database. Without them it keeps the values in memory only.
 */
export class DiffPreferences implements IDiffPreferences {
  get values(): IDiffPreferences.IValues {
    return this._values;
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  update(values: Partial<IDiffPreferences.IValues>): void {
    if (!this._apply(values)) {
      return;
    }
    for (const key of SETTING_KEYS) {
      if (key in values) {
        this._settings?.set(key, this._values[key]).catch(reason => {
          console.error(`xtralab: failed to save the diff ${key}`, reason);
        });
      }
    }
    if ('splitRatio' in values) {
      this._state
        ?.save(SPLIT_RATIO_STATE_KEY, this._values.splitRatio)
        .catch(reason => {
          console.error('xtralab: failed to save the diff split', reason);
        });
    }
  }

  /**
   * Read the toggles from the plugin settings and follow their changes.
   */
  connectSettings(settings: ISettingRegistry.ISettings): void {
    this._settings = settings;
    const sync = (): void => {
      this._apply(settings.composite as Partial<IDiffPreferences.IValues>);
    };
    sync();
    settings.changed.connect(sync);
  }

  /**
   * Restore the split width from the state database and save it there.
   */
  async connectState(state: IStateDB): Promise<void> {
    this._state = state;
    const ratio = await state.fetch(SPLIT_RATIO_STATE_KEY);
    if (
      typeof ratio === 'number' &&
      ratio >= MIN_SPLIT_RATIO &&
      ratio <= MAX_SPLIT_RATIO
    ) {
      this._apply({ splitRatio: ratio });
    }
  }

  /**
   * Merge values without persisting them; return whether one changed.
   */
  private _apply(values: Partial<IDiffPreferences.IValues>): boolean {
    const next = { ...this._values, ...values };
    const keys = Object.keys(next) as (keyof IDiffPreferences.IValues)[];
    if (keys.every(key => next[key] === this._values[key])) {
      return false;
    }
    this._values = next;
    this._changed.emit();
    return true;
  }

  private _values: IDiffPreferences.IValues = {
    diffStyle: 'split',
    diffStyleControl: 'buttons',
    lineWrap: false,
    notebookViewMode: 'notebook',
    imageViewMode: '2-up',
    splitRatio: DEFAULT_SPLIT_RATIO
  };
  private _changed = new Signal<this, void>(this);
  private _settings: ISettingRegistry.ISettings | null = null;
  private _state: IStateDB | null = null;
}

/**
 * Re-render on every preference change and return the current values.
 */
export function useDiffPreferences(
  preferences: IDiffPreferences
): IDiffPreferences.IValues {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const slot = (): void => onChange();
      preferences.changed.connect(slot);
      return () => {
        preferences.changed.disconnect(slot);
      };
    },
    [preferences]
  );
  return React.useSyncExternalStore(subscribe, () => preferences.values);
}
