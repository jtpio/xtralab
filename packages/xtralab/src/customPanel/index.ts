import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  IMovableSectionDestination,
  IMovableSectionRegistry
} from '@jupyterlab/apputils';
import {
  ITranslator,
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { SidePanel, tableRowsIcon } from '@jupyterlab/ui-components';
import { ISignal, Signal } from '@lumino/signaling';
import { AccordionPanel, Widget } from '@lumino/widgets';

const PLUGIN_ID = 'xtralab:custom-panel';

const CUSTOM_PANEL_ID = 'xtralab-custom-panel';

/**
 * A sidebar panel holding only the sections moved in from other panels.
 */
class CustomPanel extends SidePanel implements IMovableSectionDestination {
  constructor(options: { trans: TranslationBundle }) {
    super();
    this.id = CUSTOM_PANEL_ID;
    this.title.icon = tableRowsIcon;
    this.title.caption = options.trans.__('Custom Panel');
    this.addClass('jp-xtralab-CustomPanel');
  }

  /**
   * The accordion panel hosting the sections.
   */
  get accordionPanel(): AccordionPanel {
    return this.content as AccordionPanel;
  }

  /**
   * The section widgets currently hosted by the panel.
   */
  get sections(): ReadonlyArray<Widget> {
    return this.content.widgets;
  }

  /**
   * A signal emitted with the new count when the number of sections changes.
   */
  get sectionCountChanged(): ISignal<this, number> {
    return this._sectionCountChanged;
  }

  /**
   * Add a section widget to the panel.
   */
  addSection(widget: Widget): void {
    this.addWidget(widget);
    this._sectionCountChanged.emit(this.content.widgets.length);
  }

  /**
   * Remove a section widget from the panel, if it is hosted here.
   */
  removeSectionWidget(widget: Widget): void {
    if (widget.parent !== this.content) {
      return;
    }
    widget.parent = null;
    this._sectionCountChanged.emit(this.content.widgets.length);
  }

  private _sectionCountChanged = new Signal<this, number>(this);
}

/**
 * Registers "Custom Panel", which takes a sidebar tab only while it hosts a
 * section.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description:
    'A user-assembled sidebar panel hosting sections moved in from other panels; hidden while empty.',
  autoStart: true,
  optional: [IMovableSectionRegistry, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    registry: IMovableSectionRegistry | null,
    translator: ITranslator | null
  ): void => {
    if (!registry) {
      return;
    }
    const trans = (translator ?? nullTranslator).load('jupyterlab');
    const panel = new CustomPanel({ trans });

    // Only a user move should switch the sidebar, not the startup restoration.
    let restored = false;
    void app.restored.then(() => {
      restored = true;
    });

    panel.sectionCountChanged.connect((_, count) => {
      if (count > 0 && !panel.parent) {
        app.shell.add(panel, 'left', { rank: 3 });
        if (restored) {
          app.shell.activateById(panel.id);
        }
      } else if (count === 0 && panel.parent) {
        panel.parent = null;
      }
    });

    registry.registerTarget(PLUGIN_ID, trans.__('Custom Panel'), panel);
  }
};

export default plugin;
