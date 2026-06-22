import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import { fetchAvailableCommands } from './availability';
import {
  mergeEditors,
  resolveEditor,
  type IEditor,
  type IEditorSettings
} from './editors';
import {
  LAUNCHER_PLUGIN_ID,
  registerLauncherSchemaDefaults
} from './schemaDefaults';

/**
 * A read-only, observable view of the launcher's terminal editors: xtralab's
 * built-ins (Neovim, Vim) merged with the user's `editors` setting, sorted by
 * rank, with disabled entries removed.
 */
export interface IEditorRegistry {
  /**
   * The full merged editor list (disabled entries already removed). The
   * terminals panel uses it to badge a row for any configured editor that is
   * running, and to tell the server which editor commands to detect.
   */
  readonly editors: IEditor[];

  /**
   * The single editor tile the launcher shows: the first editor, by rank, whose
   * command is on `$PATH` (Neovim before Vim by default), or `null` when none
   * qualifies.
   */
  readonly current: IEditor | null;

  /**
   * Emitted whenever {@link editors} or {@link current} changes (the user
   * edited the `editors` setting). Consumers that read on demand can ignore it.
   */
  readonly changed: ISignal<IEditorRegistry, void>;
}

/**
 * DI token for {@link IEditorRegistry}. Provided by `xtralab:editor-registry`
 * and consumed — optionally — by `xtralab:launcher` (for its tile) and
 * `xtralab:terminals` (to badge running editors with their logo).
 */
export const IEditorRegistry = new Token<IEditorRegistry>(
  'xtralab:IEditorRegistry',
  'A read-only, observable view of the launcher terminal editors, shared so the launcher tile and the terminals panel agree on the list and icons.'
);

/**
 * Concrete {@link IEditorRegistry}. The provider plugin is the only writer, so
 * the write side ({@link set}) is kept off the shared token.
 */
class EditorRegistry implements IEditorRegistry {
  get editors(): IEditor[] {
    return this._editors;
  }

  get current(): IEditor | null {
    return this._current;
  }

  get changed(): ISignal<IEditorRegistry, void> {
    return this._changed;
  }

  /** Replace both lists (recomputed together) and notify observers. */
  set(editors: IEditor[], current: IEditor | null): void {
    this._editors = editors;
    this._current = current;
    this._changed.emit();
  }

  private _editors: IEditor[] = [];
  private _current: IEditor | null = null;
  private _changed = new Signal<IEditorRegistry, void>(this);
}

/**
 * Provides {@link IEditorRegistry}: merges xtralab's built-in editors with the
 * user's `editors` setting, probes the server's `$PATH` to resolve the launcher
 * tile, and re-runs both on a settings change.
 *
 * `activate` awaits the first probe before returning, so a consumer reading
 * {@link IEditorRegistry.current} on activation sees a resolved tile.
 */
export const editorRegistryPlugin: JupyterFrontEndPlugin<IEditorRegistry> = {
  id: 'xtralab:editor-registry',
  description:
    "Provides the launcher's terminal-editor list (Neovim, Vim, or user-configured), resolved against the server PATH.",
  autoStart: true,
  provides: IEditorRegistry,
  optional: [ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    settingRegistry: ISettingRegistry | null
  ): Promise<IEditorRegistry> => {
    const registry = new EditorRegistry();

    const apply = async (overrides: IEditorSettings[]): Promise<void> => {
      const editors = mergeEditors(overrides);
      // Probe only the editors that opt into the availability check; entries
      // with `requireAvailable: false` (e.g. a shell alias) are shown
      // regardless and don't need a `which` lookup.
      const probe = editors
        .filter(editor => editor.requireAvailable)
        .map(editor => editor.command);
      const available = await fetchAvailableCommands(probe);
      registry.set(editors, resolveEditor(editors, available));
    };

    const readOverrides = (
      settings: ISettingRegistry.ISettings
    ): IEditorSettings[] => {
      const raw = settings.composite.editors;
      return Array.isArray(raw) ? (raw as IEditorSettings[]) : [];
    };

    if (settingRegistry) {
      // Must precede the first `load`: the schema defers loading until a
      // transform is registered.
      registerLauncherSchemaDefaults(settingRegistry);
      try {
        const settings = await settingRegistry.load(LAUNCHER_PLUGIN_ID);
        await apply(readOverrides(settings));
        settings.changed.connect(async () => {
          try {
            await apply(readOverrides(settings));
          } catch (reason) {
            console.error('xtralab: failed to reapply editor settings', reason);
          }
        });
      } catch (reason) {
        console.error('xtralab: failed to load editor settings', reason);
        // Settings load failed — fall back to the built-in editors so the
        // launcher tile still resolves instead of going silent.
        await apply([]);
      }
    } else {
      await apply([]);
    }

    return registry;
  }
};
