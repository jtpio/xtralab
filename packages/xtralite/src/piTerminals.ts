import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { CommandRegistry } from '@lumino/commands';
import { ISignal, Signal } from '@lumino/signaling';
import {
  hasServerExtension,
  type AgentDetectionResult,
  type IAgentDetector
} from 'xtralab';

/**
 * The command of jupyter-ai-pi-lite that returns the names of the terminals
 * where pi runs, from a version later than 0.1.2. pi-lite notifies a change
 * of the command when pi starts or stops in a terminal. A command, not a
 * token, so that xtralite does not depend on the npm package of pi-lite and
 * its many dependencies.
 */
export const PI_TERMINALS_COMMAND = '@jupyter-ai/pi-lite:list-terminals';

/**
 * The command of the Pi agent of xtralab.
 */
const PI_COMMAND = 'pi';

/**
 * Detect pi in the JupyterLite terminals, which have no server to inspect
 * their processes. Without the {@link PI_TERMINALS_COMMAND} command, it
 * detects nothing.
 */
export class PiTerminalDetector implements IAgentDetector {
  constructor(app: JupyterFrontEnd) {
    this._app = app;
    app.commands.commandChanged.connect(this._onCommandChanged, this);
  }

  /**
   * Emitted when pi starts or stops in a terminal.
   */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /**
   * Report `pi` for the terminals where it runs, and `null` for the other
   * terminals, so that a badge clears when pi stops.
   */
  async detect(commands: string[]): Promise<AgentDetectionResult | null> {
    const { commands: registry, serviceManager } = this._app;
    if (
      // pi-lite runs pi only in the JupyterLite terminals.
      hasServerExtension() ||
      !commands.includes(PI_COMMAND) ||
      !registry.hasCommand(PI_TERMINALS_COMMAND)
    ) {
      return null;
    }
    let running = this._running;
    if (running === null) {
      // Run the command only after a change: each run emits
      // `commandExecuted`, which closes the modal command palette.
      const generation = this._generation;
      const result: unknown = await registry.execute(PI_TERMINALS_COMMAND);
      if (!Array.isArray(result)) {
        return null;
      }
      running = result;
      if (generation === this._generation) {
        this._running = running;
      }
    }
    const detected: AgentDetectionResult = {};
    for (const model of serviceManager.terminals.running()) {
      detected[model.name] = running.includes(model.name) ? PI_COMMAND : null;
    }
    return detected;
  }

  private _onCommandChanged(
    sender: CommandRegistry,
    args: CommandRegistry.ICommandChangedArgs
  ): void {
    if (args.id === PI_TERMINALS_COMMAND) {
      this._running = null;
      this._generation++;
      this._changed.emit();
    }
  }

  private _app: JupyterFrontEnd;
  private _running: unknown[] | null = null;
  private _generation = 0;
  private _changed = new Signal<this, void>(this);
}
