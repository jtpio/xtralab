/**
 * Time after a tap during which the browser can send its mouse and click
 * events.
 */
const TAP_EVENTS_MS = 500;

/**
 * Make the Lumino menus respond to touch.
 *
 * Lumino before 2.10 (JupyterLab before 4.7) sets the active item on
 * `pointermove` only, and a tap does not send that event, so a tap triggers
 * nothing. Remove when JupyterLab 4.7 is the minimum version.
 */
export function enableMenuTouch(): void {
  const isMenuTouch = (event: PointerEvent): boolean =>
    event.pointerType === 'touch' &&
    event.target instanceof Element &&
    event.target.closest('.lm-Menu') !== null;

  let tapTime = -Infinity;

  document.addEventListener(
    'pointerup',
    event => {
      if (!isMenuTouch(event)) {
        return;
      }
      event.stopPropagation();
      tapTime = event.timeStamp;
      const init: PointerEventInit = {
        bubbles: true,
        clientX: event.clientX,
        clientY: event.clientY,
        pointerType: 'mouse'
      };
      event.target!.dispatchEvent(new PointerEvent('pointermove', init));
      event.target!.dispatchEvent(new PointerEvent('pointerup', init));
    },
    true
  );

  // A touch pointer leaves the menu on release, which would close the submenu
  // that the tap opened.
  for (const type of ['pointermove', 'pointerleave'] as const) {
    document.addEventListener(
      type,
      event => {
        if (isMenuTouch(event)) {
          event.stopPropagation();
        }
      },
      true
    );
  }

  // The menu can close on release, and these events would then go to the
  // element below. Scripted clicks, such as a download, are not trusted.
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    document.addEventListener(
      type,
      event => {
        if (!event.isTrusted || event.timeStamp - tapTime > TAP_EVENTS_MS) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (type === 'click') {
          tapTime = -Infinity;
        }
      },
      true
    );
  }
}
