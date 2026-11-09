import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { ISignal, Signal } from '@lumino/signaling';

import { hasServerExtension } from '../server';
import type { AgentDetectionResult, IAgentDetector } from './tokens';

/**
 * Ask the xtralab server which of `commands` runs in each open terminal
 * session: a map from session name to matched command (`null` = idle). Any
 * failure resolves the whole result to `null` — "detection unavailable",
 * not "no agents"; callers must not clear badges on it.
 */
export async function fetchRunningAgents(
  commands: string[]
): Promise<AgentDetectionResult | null> {
  if (commands.length === 0) {
    return {};
  }
  if (!hasServerExtension()) {
    return null;
  }

  const settings = ServerConnection.makeSettings();
  const url = URLExt.join(settings.baseUrl, 'xtralab', 'terminals', 'agents');

  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({ commands })
      },
      settings
    );
  } catch (error) {
    console.warn('xtralab: running-agent detection failed', error);
    return null;
  }

  if (!response.ok) {
    console.warn(
      `xtralab: detection endpoint returned HTTP ${response.status}`
    );
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.warn('xtralab: detection response was not JSON', error);
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const result: AgentDetectionResult = {};
  for (const [name, command] of Object.entries(
    payload as Record<string, unknown>
  )) {
    result[name] = typeof command === 'string' && command ? command : null;
  }
  return result;
}

/**
 * The running-agent detection of the terminals: the xtralab server, plus the
 * detectors that other extensions add.
 */
export class AgentDetection {
  /**
   * Emitted when a detector is added or removed, or reports a change.
   */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Add a detector; disposing the result removes it.
   */
  add(detector: IAgentDetector): IDisposable {
    this._detectors.push(detector);
    detector.changed?.connect(this._onDetectorChanged, this);
    this._changed.emit();
    return new DisposableDelegate(() => {
      const index = this._detectors.indexOf(detector);
      if (index === -1) {
        return;
      }
      this._detectors.splice(index, 1);
      detector.changed?.disconnect(this._onDetectorChanged, this);
      this._changed.emit();
    });
  }

  /**
   * Merge the results of the server and of every detector. A session runs an
   * agent when any source reports one. Resolves `null` ("unavailable") when
   * the xtralab server runs but its check failed, or when no source could
   * check anything.
   */
  async detect(commands: string[]): Promise<AgentDetectionResult | null> {
    if (commands.length === 0) {
      return {};
    }
    const results = await Promise.all([
      fetchRunningAgents(commands),
      ...this._detectors.map(async detector => {
        try {
          return (await detector.detect(commands)) ?? null;
        } catch (error) {
          console.warn('xtralab: running-agent detector failed', error);
          return null;
        }
      })
    ]);
    // Without the server result, the "idle" entries of the detectors would
    // clear the badges of agents that only the server can see.
    if (results[0] === null && hasServerExtension()) {
      return null;
    }
    let merged: AgentDetectionResult | null = null;
    for (const result of results) {
      if (!result || typeof result !== 'object') {
        continue;
      }
      merged = merged ?? {};
      for (const [name, command] of Object.entries(result)) {
        if (typeof command === 'string' && command) {
          merged[name] = merged[name] ?? command;
        } else if (!(name in merged)) {
          merged[name] = null;
        }
      }
    }
    return merged;
  }

  private _onDetectorChanged(): void {
    this._changed.emit();
  }

  private _detectors: IAgentDetector[] = [];
  private _changed = new Signal<this, void>(this);
}
