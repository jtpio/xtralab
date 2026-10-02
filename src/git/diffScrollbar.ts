/**
 * One mirrored diff pane: the library's scroller and its track in the bar.
 */
interface IPaneTrack {
  pane: HTMLElement;
  track: HTMLElement;
  spacer: HTMLElement;
  onPaneScroll: () => void;
}

/**
 * Copy the horizontal scroll position; the 1px tolerance stops the echo
 * between a pane and its track.
 */
function mirrorScroll(from: HTMLElement, to: HTMLElement): void {
  if (Math.abs(to.scrollLeft - from.scrollLeft) >= 1) {
    to.scrollLeft = from.scrollLeft;
  }
}

/**
 * Horizontal scrollbars for the diff panes, shown in a bar the host pins to
 * the bottom of the view. A pane is as tall as the whole diff, so its own
 * scrollbar sits below the last line.
 */
export class DiffScrollbar {
  constructor(bar: HTMLElement) {
    this._bar = bar;
    this._resizeObserver = new ResizeObserver(() => this._measure());
  }

  /**
   * Match the tracks to the panes rendered in the `diffs-container`.
   */
  sync(container: Element | null): void {
    const panes = Array.from(
      container?.shadowRoot?.querySelectorAll<HTMLElement>('[data-code]') ?? []
    );
    const unchanged =
      panes.length === this._tracks.length &&
      panes.every((pane, index) => pane === this._tracks[index].pane);
    if (!unchanged) {
      this._clear();
      this._tracks = panes.map(pane => this._createTrack(pane));
    }
    // The Pierre themes give the diff its own background color.
    this._bar.style.backgroundColor =
      container === null ? '' : getComputedStyle(container).backgroundColor;
    this._measure();
  }

  /**
   * Remove the tracks and stop observing the panes.
   */
  dispose(): void {
    this._clear();
  }

  private _createTrack(pane: HTMLElement): IPaneTrack {
    const track = document.createElement('div');
    track.className = 'jp-xtralab-DiffWidget-scrollbarTrack';
    track.tabIndex = -1;
    const spacer = document.createElement('div');
    track.appendChild(spacer);
    const onPaneScroll = (): void => mirrorScroll(pane, track);
    pane.addEventListener('scroll', onPaneScroll, { passive: true });
    track.addEventListener('scroll', () => mirrorScroll(track, pane), {
      passive: true
    });
    this._resizeObserver.observe(pane);
    this._bar.appendChild(track);
    return { pane, track, spacer, onPaneScroll };
  }

  private _clear(): void {
    this._resizeObserver.disconnect();
    for (const { pane, onPaneScroll } of this._tracks) {
      pane.removeEventListener('scroll', onPaneScroll);
    }
    this._tracks = [];
    this._bar.replaceChildren();
  }

  private _measure(): void {
    const sizes = this._tracks.map(({ pane }) => ({
      width: pane.getBoundingClientRect().width,
      range: Math.max(0, pane.scrollWidth - pane.clientWidth)
    }));
    this._tracks.forEach(({ track, spacer }, index) => {
      const { width, range } = sizes[index];
      track.style.width = `${width}px`;
      spacer.style.width = `${width + range}px`;
    });
    this._bar.hidden = !sizes.some(({ range }) => range > 0);
    for (const { pane, track } of this._tracks) {
      mirrorScroll(pane, track);
    }
  }

  private _bar: HTMLElement;
  private _resizeObserver: ResizeObserver;
  private _tracks: IPaneTrack[] = [];
}
