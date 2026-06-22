import type { PartialJSONValue } from '@lumino/coreutils';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';

import { defaultAgentSettings } from './agents';
import { defaultEditorSettings } from './editors';

/** Schema id the launcher's `agents`/`editors` settings live under. */
export const LAUNCHER_PLUGIN_ID = 'xtralab:launcher';

/**
 * Setting registries that already have the transform, so both callers skip
 * re-registering (the registry rejects a duplicate transformer).
 */
const registered = new WeakSet<ISettingRegistry>();

/**
 * Register a `fetch` transform that injects xtralab's built-in agent and
 * editor lists as the schema defaults for the `xtralab:launcher` settings, so
 * the Settings Editor shows the shipped list.
 *
 * The schema declares `jupyter.lab.transform: true`, so the registry defers
 * loading the plugin until a transform is registered: callers must invoke this
 * before their first `settingRegistry.load(LAUNCHER_PLUGIN_ID)`. Idempotent, so
 * the two plugins that load these settings can both call it regardless of
 * activation order.
 */
export function registerLauncherSchemaDefaults(
  settingRegistry: ISettingRegistry
): void {
  if (registered.has(settingRegistry)) {
    return;
  }
  registered.add(settingRegistry);

  settingRegistry.transform(LAUNCHER_PLUGIN_ID, {
    fetch: plugin => {
      const properties = plugin.schema.properties;
      if (properties) {
        // The settings shapes are plain JSON by construction, but their named
        // interfaces lack an index signature, so cast at this TS→JSON boundary.
        if (properties.agents) {
          properties.agents.default =
            defaultAgentSettings() as unknown as PartialJSONValue;
        }
        if (properties.editors) {
          properties.editors.default =
            defaultEditorSettings() as unknown as PartialJSONValue;
        }
      }
      return plugin;
    }
  });
}
