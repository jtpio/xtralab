import * as React from 'react';

import { ReactWidget } from '@jupyterlab/ui-components';
import { Signal, ISignal } from '@lumino/signaling';

import { gitIcon } from './icons';
import { GitPanelComponent, IGitPanelHandlers } from './panelComponent';

/**
 * The id and CSS class used for the git panel widget. The id ends up as the
 * sidebar tab id (so layout restoration can find the widget) and the CSS
 * class lets per-panel styles attach without leaking to other widgets.
 */
export const GIT_PANEL_ID = 'xtralab:git-panel';
export const GIT_PANEL_CSS_CLASS = 'jp-xtralab-GitPanel';

/**
 * The lumino host widget for the git changes panel. Owns the `refresh`
 * signal that the React component listens to, and exposes a typed callback
 * surface (`handlers`) the React component uses to react to user actions.
 */
export class GitPanel extends ReactWidget {
  constructor(handlers: IGitPanelHandlers) {
    super();
    this.id = GIT_PANEL_ID;
    this.title.icon = gitIcon;
    this.title.caption = 'Git Changes';
    this.addClass(GIT_PANEL_CSS_CLASS);
    this._handlers = handlers;
  }

  /**
   * Public refresh hook called by the plugin when something happened that
   * invalidates the current view (the user clicked the toolbar refresh, the
   * file browser refreshed, a focused notebook saved, …).
   */
  refresh(): void {
    this._refreshRequested.emit();
  }

  get refreshRequested(): ISignal<this, void> {
    return this._refreshRequested;
  }

  protected render(): React.ReactElement {
    return (
      <GitPanelComponent
        handlers={this._handlers}
        refreshSignal={this._refreshRequested}
      />
    );
  }

  private _handlers: IGitPanelHandlers;
  private _refreshRequested = new Signal<this, void>(this);
}
