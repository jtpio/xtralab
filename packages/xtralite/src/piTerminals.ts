import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { CommandRegistry } from '@lumino/commands';
import { ISignal, Signal } from '@lumino/signaling';
import type { AgentDetectionResult, IAgentDetector } from 'xtralab';

/**
 * The command of jupyter-ai-pi-lite that returns the names of the terminals
 * where pi runs. A command, not a token, so that xtralite does not depend on
 * the npm package of pi-lite and its many dependencies.
 */
export const PI_TERMINALS_COMMAND = '@jupyter-ai/pi-lite:list-terminals';

/**
 * The command of the Pi agent of xtralab.
 */
const PI_COMMAND = 'pi';

/**
 * Detect pi in the JupyterLite terminals, which have no server to inspect
 * their processes. Needs a version of jupyter-ai-pi-lite with the
 * {@link PI_TERMINALS_COMMAND} command; without it, detects nothing.
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
      !commands.includes(PI_COMMAND) ||
      !registry.hasCommand(PI_TERMINALS_COMMAND)
    ) {
      return null;
    }
    const running: unknown = await registry.execute(PI_TERMINALS_COMMAND);
    if (!Array.isArray(running)) {
      return null;
    }
    const result: AgentDetectionResult = {};
    for (const model of serviceManager.terminals.running()) {
      result[model.name] = running.includes(model.name) ? PI_COMMAND : null;
    }
    return result;
  }

  private _onCommandChanged(
    sender: CommandRegistry,
    args: CommandRegistry.ICommandChangedArgs
  ): void {
    if (args.id === PI_TERMINALS_COMMAND) {
      this._changed.emit();
    }
  }

  private _app: JupyterFrontEnd;
  private _changed = new Signal<this, void>(this);
}
