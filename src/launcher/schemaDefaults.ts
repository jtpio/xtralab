import type { PartialJSONValue } from '@lumino/coreutils';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';

import { defaultAgentSettings } from './agents';
import { defaultEditorSettings } from './editors';

/**
 * Schema id the launcher's `agents`/`editors` settings live under.
 */
export const LAUNCHER_PLUGIN_ID = 'xtralab:launcher';

/**
 * Registries that already have the transform (duplicates are rejected).
 */
const registered = new WeakSet<ISettingRegistry>();

/**
 * Merge sparse user entries over the built-in defaults, keyed by `id`.
 */
function mergeSettingsById<
  T extends { id: string; enabled?: boolean; requireAvailable?: boolean }
>(defaults: T[], user: PartialJSONValue | undefined): T[] {
  const entries = Array.isArray(user) ? (user as unknown as T[]) : [];
  const overrideById = new Map(entries.map(entry => [entry.id, entry]));
  const merged = defaults.map(base => {
    const override = overrideById.get(base.id);
    if (!override) {
      return base;
    }
    overrideById.delete(base.id);
    return { ...base, ...override };
  });
  merged.push(...overrideById.values());
  // Item schema defaults are applied before this transform runs; without the
  // refill, sparse entries render with unchecked boxes.
  return merged.map(entry => ({
    ...entry,
    enabled: entry.enabled ?? true,
    requireAvailable: entry.requireAvailable ?? true
  }));
}

/**
 * Must run before the first `load(LAUNCHER_PLUGIN_ID)` (the schema sets
 * `jupyter.lab.transform: true`); idempotent across callers.
 */
export function registerLauncherSchemaDefaults(
  settingRegistry: ISettingRegistry
): void {
  if (registered.has(settingRegistry)) {
    return;
  }
  registered.add(settingRegistry);

  settingRegistry.transform(LAUNCHER_PLUGIN_ID, {
    compose: plugin => {
      const { user } = plugin.data;
      const composite = { ...plugin.data.composite };
      composite.agents = mergeSettingsById(
        defaultAgentSettings(),
        user.agents
      ) as unknown as PartialJSONValue;
      composite.editors = mergeSettingsById(
        defaultEditorSettings(),
        user.editors
      ) as unknown as PartialJSONValue;
      plugin.data = { composite, user };
      return plugin;
    },
    fetch: plugin => {
      const properties = plugin.schema.properties;
      if (properties) {
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
