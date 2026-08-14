import {
  IMovableSectionDestination,
  IMovableSectionSource,
  ISectionEntry
} from '@jupyterlab/apputils';
import {
  type TranslationBundle,
  nullTranslator
} from '@jupyterlab/translation';
import {
  addIcon,
  closeIcon,
  LabIcon,
  PanelWithToolbar,
  ReactWidget,
  SidePanel,
  stopIcon,
  terminalIcon,
  ToolbarButton,
  UseSignal
} from '@jupyterlab/ui-components';
import { ISignal, Signal } from '@lumino/signaling';
import { AccordionPanel, Widget } from '@lumino/widgets';
import * as React from 'react';

import { SessionRegistry } from './model';

/**
 * Id of the panel widget. Used for layout restoration and as the handle
 * the sidebar visibility toggle would target.
 */
const RUNNING_TERMINALS_ID = 'xtralab-running-terminals';

/**
 * Id of the accordion section holding the terminals list. Persisted by the
 * movable-sections plugin, so it must stay stable across releases.
 */
const TERMINALS_SECTION_ID = 'xtralab-terminals-section';

/**
 * Left-sidebar panel listing every running terminal session, including the
 * sessions whose tab is closed but which are still alive on the server. The
 * list is a single movable "Terminals" section.
 */
export class RunningTerminals
  extends SidePanel
  implements IMovableSectionSource, IMovableSectionDestination
{
  constructor(options: RunningTerminals.IOptions) {
    super();
    this._registry = options.registry;
    const trans = options.trans ?? nullTranslator.load('jupyterlab');

    this.id = RUNNING_TERMINALS_ID;
    this.title.icon = terminalIcon;
    this.title.caption = trans.__('Running Terminals');
    this.addClass('jp-xtralab-Terminals');

    const section = (this._section = new PanelWithToolbar());
    section.id = TERMINALS_SECTION_ID;
    section.title.label = trans.__('Terminals');
    section.addClass('jp-xtralab-Terminals-section');

    const shutdownAll = new ToolbarButton({
      icon: stopIcon,
      onClick: options.onShutdownAll,
      tooltip: trans.__('Shut Down All Terminals'),
      enabled: this._registry.sessionNames().length > 0
    });
    this._registry.stateChanged.connect(() => {
      shutdownAll.enabled = this._registry.sessionNames().length > 0;
    });
    section.toolbar.addItem('shutdown-all', shutdownAll);

    const newTerminal = new ToolbarButton({
      icon: addIcon,
      onClick: () => {
        // Anchor whatever the plugin shows (usually an agent menu) to the
        // button's bottom-left, in the viewport coordinates `Menu.open` wants.
        const rect = newTerminal.node.getBoundingClientRect();
        options.onCreate({ x: rect.left, y: rect.bottom });
      },
      tooltip: trans.__('New Terminal')
    });
    section.toolbar.addItem('new-terminal', newTerminal);

    section.addWidget(
      new TerminalsListing({
        registry: this._registry,
        trans,
        iconForCommand: options.iconForCommand,
        onActivate: options.onActivate,
        onShutdown: options.onShutdown
      })
    );

    this.addWidget(section);
  }

  get accordionPanel(): AccordionPanel {
    return this.content as AccordionPanel;
  }

  get sectionAdded(): ISignal<this, ISectionEntry> {
    return this._sectionAdded;
  }

  get sections(): ReadonlyArray<Widget> {
    return this.accordionPanel.widgets.filter(w => w !== this._section);
  }

  getSections(): ReadonlyArray<ISectionEntry> {
    const entry = this._sectionEntry();
    return entry ? [entry] : [];
  }

  removeSectionById(sectionId: string): Widget | null {
    if (
      sectionId !== TERMINALS_SECTION_ID ||
      this._section.parent !== this.content
    ) {
      return null;
    }
    this._section.parent = null;
    return this._section;
  }

  reinsertSection(widget: Widget): void {
    this.addWidget(widget);
  }

  addSection(widget: Widget): void {
    this.addWidget(widget);
  }

  removeSectionWidget(widget: Widget): void {
    if (widget.parent === this.content) {
      widget.parent = null;
    }
  }

  /**
   * The layout restorer stores a section as collapsed whenever its panel is off
   * screen at save time, so it can come back collapsed without the user asking.
   */
  expandOwnSection(): void {
    const accordion = this.accordionPanel;
    const index = Array.from(accordion.widgets).indexOf(this._section);
    if (index >= 0) {
      accordion.expand(index);
    }
  }

  /**
   * The move plugin reconciles persisted moves only against sections announced
   * after `registerSource`, and this panel builds its section in the constructor.
   */
  announceSections(): void {
    const entry = this._sectionEntry();
    if (entry) {
      this._sectionAdded.emit(entry);
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    // The panel owns the registry, so tear down its upstream
    // subscriptions before the React tree goes away.
    this._registry.dispose();
    super.dispose();
  }

  private _sectionEntry(): ISectionEntry | null {
    const accordion = this.accordionPanel;
    const index = Array.from(accordion.widgets).indexOf(this._section);
    const titleNode = accordion.titles[index] as HTMLElement | undefined;
    if (index < 0 || !titleNode) {
      return null;
    }
    return {
      id: TERMINALS_SECTION_ID,
      titleNode,
      widget: this._section
    };
  }

  private _registry: SessionRegistry;
  private _section: PanelWithToolbar;
  private _sectionAdded = new Signal<this, ISectionEntry>(this);
}

export namespace RunningTerminals {
  export interface IOptions {
    registry: SessionRegistry;
    trans?: TranslationBundle;
    /**
     * Resolve the running-agent command for a row (from
     * `registry.agentCommandFor`) to the icon to show before its label —
     * the agent's logo, or the plain terminal icon. Supplied by the plugin
     * so the widget never imports the agent list.
     */
    iconForCommand: (command: string | null) => LabIcon;
    /**
     * Activate the named session's open tab, or reopen it in a fresh
     * terminal widget if no tab is currently attached.
     */
    onActivate: (sessionName: string) => void;
    /**
     * Shut the named session down on the server.
     */
    onShutdown: (sessionName: string) => void;
    /**
     * Shut down every running terminal at once. The plugin is expected to
     * confirm with the user first, since it tears down all live sessions.
     */
    onShutdownAll: () => void;
    /**
     * Activate the "+" button, anchored at the given viewport coordinates
     * (the bottom-left of the button). The plugin decides what to show
     * there — a menu of agents plus a plain terminal, or just a new
     * terminal when no agents are available — so the panel only reports
     * where the button is and never imports the command/menu machinery.
     */
    onCreate: (anchor: { x: number; y: number }) => void;
  }
}

/**
 * The body of the Terminals section.
 */
class TerminalsListing extends ReactWidget {
  constructor(options: {
    registry: SessionRegistry;
    trans: TranslationBundle;
    iconForCommand: (command: string | null) => LabIcon;
    onActivate: (sessionName: string) => void;
    onShutdown: (sessionName: string) => void;
  }) {
    super();
    this._options = options;
    this.addClass('jp-xtralab-Terminals-listing');
  }

  protected render(): React.ReactElement {
    return (
      <UseSignal signal={this._options.registry.stateChanged}>
        {() => (
          <RunningTerminalsComponent
            registry={this._options.registry}
            trans={this._options.trans}
            iconForCommand={this._options.iconForCommand}
            onActivate={this._options.onActivate}
            onShutdown={this._options.onShutdown}
          />
        )}
      </UseSignal>
    );
  }

  private _options: {
    registry: SessionRegistry;
    trans: TranslationBundle;
    iconForCommand: (command: string | null) => LabIcon;
    onActivate: (sessionName: string) => void;
    onShutdown: (sessionName: string) => void;
  };
}

function RunningTerminalsComponent(props: {
  registry: SessionRegistry;
  trans: TranslationBundle;
  iconForCommand: (command: string | null) => LabIcon;
  onActivate: (sessionName: string) => void;
  onShutdown: (sessionName: string) => void;
}): React.ReactElement {
  const { registry, trans, iconForCommand, onActivate, onShutdown } = props;
  const names = registry.sessionNames();
  // The session whose terminal is the current widget in the main area, so its
  // row can be highlighted. `null` when the current tab is a notebook or any
  // other non-terminal widget.
  const currentName = registry.currentSessionName();

  return (
    <div className="jp-xtralab-Terminals-body">
      {names.length === 0 ? (
        <p className="jp-xtralab-Terminals-empty">
          {trans.__('No running terminals.')}
        </p>
      ) : (
        <ul className="jp-xtralab-Terminals-list">
          {names.map(name => {
            const label = registry.labelFor(name);
            const hasWidget = registry.widgetFor(name) !== null;
            const tooltip = hasWidget
              ? trans.__('Activate %1', label)
              : trans.__('Reopen %1', label);
            // The running agent's logo (e.g. Claude), or the plain terminal
            // icon when nothing recognised is running in the session.
            const RowIcon = iconForCommand(
              registry.agentCommandFor(name)
            ).react;
            const isCurrent = name === currentName;
            // The latest line of output from the session's agent, shown as a
            // smaller line under the title; `null` for rows with nothing to
            // surface (no agent running, or no open tab to read a live buffer).
            const activity = registry.activityFor(name);
            return (
              <li
                key={name}
                className={
                  isCurrent
                    ? 'jp-xtralab-Terminals-item jp-mod-current'
                    : 'jp-xtralab-Terminals-item'
                }
              >
                <button
                  type="button"
                  className="jp-xtralab-Terminals-item-activate"
                  onClick={() => onActivate(name)}
                  title={tooltip}
                  aria-label={tooltip}
                  aria-current={isCurrent || undefined}
                >
                  <RowIcon
                    tag="span"
                    className="jp-xtralab-Terminals-item-icon"
                    verticalAlign="middle"
                  />
                  <span className="jp-xtralab-Terminals-item-text">
                    <span className="jp-xtralab-Terminals-item-label">
                      {label}
                    </span>
                    {activity ? (
                      <span className="jp-xtralab-Terminals-item-detail">
                        {activity}
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="jp-xtralab-Terminals-item-close"
                  onClick={() => onShutdown(name)}
                  title={trans.__('Shut down %1', label)}
                  aria-label={trans.__('Shut down %1', label)}
                >
                  <closeIcon.react tag="span" verticalAlign="middle" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
