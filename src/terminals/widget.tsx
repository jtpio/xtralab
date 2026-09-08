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

const RUNNING_TERMINALS_ID = 'xtralab-running-terminals';

/**
 * Persisted by the movable-sections plugin — must stay stable across releases.
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

  /**
   * The accordion panel hosting the sections; read by the move plugin.
   */
  get accordionPanel(): AccordionPanel {
    return this.content as AccordionPanel;
  }

  /**
   * A signal emitted when a section is announced to the move plugin.
   */
  get sectionAdded(): ISignal<this, ISectionEntry> {
    return this._sectionAdded;
  }

  /**
   * The hosted section widgets, excluding the panel's own Terminals section.
   */
  get sections(): ReadonlyArray<Widget> {
    return this.accordionPanel.widgets.filter(w => w !== this._section);
  }

  /**
   * Get the movable sections: just the Terminals section, while attached here.
   */
  getSections(): ReadonlyArray<ISectionEntry> {
    const entry = this._sectionEntry();
    return entry ? [entry] : [];
  }

  /**
   * Detach the Terminals section for the move plugin and return it; `null`
   * for an unknown id or when the section is already hosted elsewhere.
   */
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

  /**
   * Re-attach the Terminals section after it moves back to this panel.
   */
  reinsertSection(widget: Widget): void {
    this.addWidget(widget);
  }

  /**
   * Host a section moved in from another sidebar panel.
   */
  addSection(widget: Widget): void {
    this.addWidget(widget);
  }

  /**
   * Detach a hosted section when it moves back to its own panel.
   */
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

  /**
   * Dispose of the panel and the registry it owns.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    // The panel owns the registry; tear down its subscriptions first.
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
  /**
   * The instantiation options for a {@link RunningTerminals} panel.
   */
  export interface IOptions {
    /**
     * The session registry the panel renders and takes ownership of.
     */
    registry: SessionRegistry;
    /**
     * The translation bundle for the panel's labels; untranslated if omitted.
     */
    trans?: TranslationBundle;
    /**
     * Resolve a row's running-agent command to its icon; supplied by the
     * plugin so the widget never imports the agent list.
     */
    iconForCommand: (command: string | null) => LabIcon;
    /**
     * Activate the named session's open tab, or reopen it in a fresh widget.
     */
    onActivate: (sessionName: string) => void;
    /**
     * Shut the named session down on the server.
     */
    onShutdown: (sessionName: string) => void;
    /**
     * Shut down every running terminal; the plugin confirms with the user first.
     */
    onShutdownAll: () => void;
    /**
     * Handle the "+" button, anchored at its bottom-left in viewport
     * coordinates; the plugin decides what to show there.
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

  /**
   * Render the listing, re-rendering on every registry state change.
   */
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
            const RowIcon = iconForCommand(
              registry.agentCommandFor(name)
            ).react;
            const isCurrent = name === currentName;
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
