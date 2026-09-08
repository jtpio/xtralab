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
 * A read-only, observable view of the launcher's terminal editors: the
 * built-ins merged with the user's `editors` setting.
 */
export interface IEditorRegistry {
  /**
   * The merged editor list (disabled entries removed); the terminals panel
   * uses it to badge running editors.
   */
  readonly editors: IEditor[];

  /**
   * The single launcher tile: the first editor, by rank, whose command is on
   * `$PATH`, or `null` when none qualifies.
   */
  readonly current: IEditor | null;

  /**
   * Emitted whenever {@link editors} or {@link current} changes.
   */
  readonly changed: ISignal<IEditorRegistry, void>;
}

export const IEditorRegistry = new Token<IEditorRegistry>(
  'xtralab:IEditorRegistry',
  'A read-only, observable view of the launcher terminal editors, shared so the launcher tile and the terminals panel agree on the list and icons.'
);

/**
 * Concrete {@link IEditorRegistry}. The provider plugin is the only writer, so
 * {@link set} is kept off the shared token.
 */
class EditorRegistry implements IEditorRegistry {
  /**
   * The merged editor list (disabled entries removed).
   */
  get editors(): IEditor[] {
    return this._editors;
  }

  /**
   * The launcher-tile editor, or `null` when none qualifies.
   */
  get current(): IEditor | null {
    return this._current;
  }

  /**
   * Emitted whenever {@link editors} or {@link current} changes.
   */
  get changed(): ISignal<IEditorRegistry, void> {
    return this._changed;
  }

  /**
   * Replace both lists and notify observers.
   */
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
 * Provides {@link IEditorRegistry}: merges the built-in editors with the
 * `editors` setting and probes the server's `$PATH`. `activate` awaits the
 * first probe, so consumers see a resolved tile on activation.
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
      const probe = Array.from(
        new Set(
          editors
            .filter(editor => editor.requireAvailable)
            .map(editor => editor.command)
        )
      );
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
        await apply([]);
      }
    } else {
      await apply([]);
    }

    return registry;
  }
};
