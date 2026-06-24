import * as React from 'react';

import type { TranslationBundle } from '@jupyterlab/translation';

/**
 * xtralab's image diff, registered in place of `@jupyterlab/git:image-diff`.
 *
 * The git server base64-encodes binary content, so both diff hosts receive
 * the two sides as base64 strings through the same `content()` getters used
 * for text. This module turns those strings into `<img>` elements and
 * offers the 2-up / swipe / onion-skin comparison modes; no diffing library
 * is involved (`@pierre/diffs` is text-only).
 */

/**
 * Raster image extensions xtralab renders as an image diff, mapped to the
 * MIME subtype used in the `data:image/<subtype>;base64,…` URL.
 *
 * `.svg` is intentionally absent: it is XML text, so the `@pierre/diffs`
 * text diff (the fallback provider) is more useful for it than an image
 * comparison.
 */
const IMAGE_DATA_TYPES: Record<string, string> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.bmp': 'bmp',
  '.ico': 'x-icon'
};

/** The file extensions registered as the xtralab image diff provider. */
export const IMAGE_DIFF_EXTENSIONS = Object.keys(IMAGE_DATA_TYPES);

/**
 * The `data:` MIME subtype for a path xtralab renders as an image, or
 * `null` when the path is not a supported raster image.
 */
export function imageDataType(path: string): string | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) {
    return null;
  }
  return IMAGE_DATA_TYPES[lower.slice(dot)] ?? null;
}

/** Comparison layouts, matching jupyterlab-git's image diff modes. */
type ImageDiffViewMode = '2-up' | 'swipe' | 'onion';

const IMAGE_DIFF_VIEW_MODE_STORAGE_KEY = 'xtralab:image-diff-view-mode';

function readStoredImageViewMode(): ImageDiffViewMode {
  try {
    const raw = window.localStorage.getItem(IMAGE_DIFF_VIEW_MODE_STORAGE_KEY);
    if (raw === '2-up' || raw === 'swipe' || raw === 'onion') {
      return raw;
    }
  } catch {
    // localStorage can throw in privacy/sandboxed contexts — 2-up is the
    // sensible default anyway.
  }
  return '2-up';
}

function writeStoredImageViewMode(mode: ImageDiffViewMode): void {
  try {
    window.localStorage.setItem(IMAGE_DIFF_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort.
  }
}

/**
 * Strip whitespace from a base64 payload. Python's `base64.encodebytes`
 * (used by the git server) inserts a newline every 76 characters; most
 * browsers tolerate that inside a `data:` URL but some are stricter, and
 * the cleaned length also lets us size the file accurately.
 */
function cleanBase64(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Decoded byte length of a (whitespace-free) base64 string. */
function base64ByteLength(clean: string): number {
  if (clean.length === 0) {
    return 0;
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

interface IImageSide {
  /** Cleaned base64 payload; empty string means the side does not exist. */
  data: string;
  present: boolean;
  uri: string | null;
  bytes: number;
}

function toSide(raw: string, fileType: string): IImageSide {
  const data = cleanBase64(raw);
  const present = data.length > 0;
  return {
    data,
    present,
    uri: present ? `data:image/${fileType};base64,${data}` : null,
    bytes: base64ByteLength(data)
  };
}

interface IImageDiffViewProps {
  /** Base64 of the reference (old) revision; empty when added. */
  reference: string;
  /** Base64 of the challenger (new) revision; empty when deleted. */
  challenger: string;
  /** MIME subtype from {@link imageDataType}. */
  fileType: string;
  /** Translation bundle for user-facing strings. */
  trans: TranslationBundle;
}

/**
 * The image comparison surface: a segmented mode selector (reusing the
 * diff segmented-control styling so it matches the Notebook/JSON toggle)
 * plus the selected 2-up / swipe / onion-skin view.
 */
export function ImageDiffView(props: IImageDiffViewProps): React.ReactElement {
  const { reference, challenger, fileType, trans } = props;
  const ref = React.useMemo(
    () => toSide(reference, fileType),
    [reference, fileType]
  );
  const chall = React.useMemo(
    () => toSide(challenger, fileType),
    [challenger, fileType]
  );

  const [mode, setMode] = React.useState<ImageDiffViewMode>(() =>
    readStoredImageViewMode()
  );
  const changeMode = React.useCallback((next: ImageDiffViewMode) => {
    setMode(next);
    writeStoredImageViewMode(next);
  }, []);

  return (
    <div className="jp-xtralab-ImageDiff">
      <div className="jp-xtralab-ImageDiff-header">
        <div
          className="jp-xtralab-DiffWidget-segmented"
          role="tablist"
          aria-label={trans.__('Image diff view mode')}
        >
          {(
            [
              ['2-up', trans.__('2-up')],
              ['swipe', trans.__('Swipe')],
              ['onion', trans.__('Onion Skin')]
            ] as [ImageDiffViewMode, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              data-active={mode === value}
              className="jp-xtralab-DiffWidget-segmentedButton"
              onClick={() => changeMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="jp-xtralab-ImageDiff-body">
        {mode === '2-up' ? (
          <TwoUp reference={ref} challenger={chall} trans={trans} />
        ) : mode === 'swipe' ? (
          <Swipe reference={ref} challenger={chall} trans={trans} />
        ) : (
          <OnionSkin reference={ref} challenger={chall} trans={trans} />
        )}
      </div>
    </div>
  );
}

interface ISideViewProps {
  reference: IImageSide;
  challenger: IImageSide;
  trans: TranslationBundle;
}

function useNaturalSize(): [
  [number, number] | null,
  (event: React.SyntheticEvent<HTMLImageElement>) => void
] {
  const [size, setSize] = React.useState<[number, number] | null>(null);
  const onLoad = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      setSize([
        event.currentTarget.naturalWidth,
        event.currentTarget.naturalHeight
      ]);
    },
    []
  );
  return [size, onLoad];
}

function caption(
  side: IImageSide,
  size: [number, number] | null,
  emptyLabel: string
): string {
  if (!side.present) {
    return emptyLabel;
  }
  const dims = size !== null ? `${size[0]}×${size[1]} · ` : '';
  return `${dims}${formatBytes(side.bytes)}`;
}

function TwoUp({
  reference,
  challenger,
  trans
}: ISideViewProps): React.ReactElement {
  const [refSize, onRefLoad] = useNaturalSize();
  const [challSize, onChallLoad] = useNaturalSize();
  return (
    <div className="jp-xtralab-ImageDiff-twoUp">
      <figure className="jp-xtralab-ImageDiff-col">
        <div className="jp-xtralab-ImageDiff-frame" data-side="reference">
          {reference.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-img"
              src={reference.uri}
              alt={trans.__('Reference revision')}
              onLoad={onRefLoad}
            />
          ) : (
            <div className="jp-xtralab-ImageDiff-empty">
              {trans.__('No previous image')}
            </div>
          )}
        </div>
        <figcaption className="jp-xtralab-ImageDiff-caption">
          {caption(reference, refSize, trans.__('Added'))}
        </figcaption>
      </figure>
      <figure className="jp-xtralab-ImageDiff-col">
        <div className="jp-xtralab-ImageDiff-frame" data-side="challenger">
          {challenger.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-img"
              src={challenger.uri}
              alt={trans.__('Challenger revision')}
              onLoad={onChallLoad}
            />
          ) : (
            <div className="jp-xtralab-ImageDiff-empty">
              {trans.__('Deleted')}
            </div>
          )}
        </div>
        <figcaption className="jp-xtralab-ImageDiff-caption">
          {caption(challenger, challSize, trans.__('Deleted'))}
        </figcaption>
      </figure>
    </div>
  );
}

/**
 * Range slider shared by the swipe and onion-skin views. A native
 * `<input type="range">` (styled via CSS) keeps the bundle free of a UI
 * component dependency.
 */
function RangeSlider(props: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}): React.ReactElement {
  const { value, onChange, ariaLabel } = props;
  return (
    <input
      className="jp-xtralab-ImageDiff-slider"
      type="range"
      min={0}
      max={100}
      step={1}
      value={value}
      aria-label={ariaLabel}
      onChange={event => onChange(Number(event.target.value))}
    />
  );
}

/**
 * Fit a `naturalWidth × naturalHeight` image inside an `areaWidth ×
 * areaHeight` box without upscaling past its intrinsic size — the same
 * "contain, never enlarge" rule the 2-up and onion views get for free from
 * `max-width/height: 100%; width/height: auto`. Returns the displayed pixel
 * box, or `null` until both the image and the area have been measured.
 */
function containBox(
  naturalWidth: number,
  naturalHeight: number,
  areaWidth: number,
  areaHeight: number
): { width: number; height: number } | null {
  if (
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    areaWidth <= 0 ||
    areaHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    areaWidth / naturalWidth,
    areaHeight / naturalHeight,
    1
  );
  return { width: naturalWidth * scale, height: naturalHeight * scale };
}

/** Track an element's content-box size, kept current across layout changes. */
function useElementSize(): readonly [
  React.RefObject<HTMLDivElement>,
  { width: number; height: number }
] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  React.useEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const measure = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, size] as const;
}

function Swipe({
  reference,
  challenger,
  trans
}: ISideViewProps): React.ReactElement {
  const [position, setPosition] = React.useState(50);
  const [dragging, setDragging] = React.useState(false);
  const [refSize, onRefLoad] = useNaturalSize();
  const [challSize, onChallLoad] = useNaturalSize();
  const [areaRef, area] = useElementSize();
  const frameRef = React.useRef<HTMLDivElement>(null);

  // Display both revisions in a single box — the union of their intrinsic
  // sizes, scaled down to fit but never enlarged — and size the frame to
  // exactly that box. The divider's `left: N%`, the pointer-to-percent
  // mapping (below) and each image's `clip-path` inset then all resolve
  // against the same width, so the white line sits precisely on the seam
  // between the two revisions at every position. A full-width frame instead
  // let the line drift off the seam by as much as half the letterbox.
  const naturalWidth = Math.max(refSize?.[0] ?? 0, challSize?.[0] ?? 0);
  const naturalHeight = Math.max(refSize?.[1] ?? 0, challSize?.[1] ?? 0);
  const box = containBox(naturalWidth, naturalHeight, area.width, area.height);

  const setFromClientX = React.useCallback((clientX: number) => {
    const frame = frameRef.current;
    if (frame === null) {
      return;
    }
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.max(0, Math.min(100, next)));
  }, []);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only react to the primary pointer (left click / touch / pen tip).
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      setDragging(true);
      setFromClientX(event.clientX);
    },
    [setFromClientX]
  );

  React.useEffect(() => {
    if (!dragging) {
      return;
    }
    const onMove = (event: PointerEvent) => {
      setFromClientX(event.clientX);
    };
    const onUp = () => {
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, setFromClientX]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      let next: number | null = null;
      switch (event.key) {
        case 'ArrowLeft':
          next = position - step;
          break;
        case 'ArrowRight':
          next = position + step;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = 100;
          break;
      }
      if (next === null) {
        return;
      }
      event.preventDefault();
      setPosition(Math.max(0, Math.min(100, next)));
    },
    [position]
  );

  return (
    <div className="jp-xtralab-ImageDiff-interactive">
      <div className="jp-xtralab-ImageDiff-swipeArea" ref={areaRef}>
        <div
          className="jp-xtralab-ImageDiff-swipeFrame"
          ref={frameRef}
          style={
            box !== null
              ? { width: `${box.width}px`, height: `${box.height}px` }
              : { width: 0, height: 0, visibility: 'hidden' }
          }
          onPointerDown={onPointerDown}
          data-dragging={dragging ? 'true' : undefined}
        >
          {reference.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-swipeImg"
              src={reference.uri}
              alt={trans.__('Reference revision')}
              draggable={false}
              onLoad={onRefLoad}
              style={{
                clipPath: `inset(0 ${100 - position}% 0 0)`
              }}
            />
          ) : null}
          {challenger.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-swipeImg"
              src={challenger.uri}
              alt={trans.__('Challenger revision')}
              draggable={false}
              onLoad={onChallLoad}
              style={{
                clipPath: `inset(0 0 0 ${position}%)`
              }}
            />
          ) : null}
          <div
            className="jp-xtralab-ImageDiff-swipeDivider"
            style={{ left: `${position}%` }}
            role="slider"
            aria-label={trans.__('Swipe between reference and challenger')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(position)}
            aria-orientation="vertical"
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            <div className="jp-xtralab-ImageDiff-swipeDividerHandle jp-mod-top">
              <div className="jp-xtralab-ImageDiff-swipeDividerArrow jp-mod-left" />
              <div className="jp-xtralab-ImageDiff-swipeDividerArrow jp-mod-right" />
            </div>
            <div className="jp-xtralab-ImageDiff-swipeDividerHandle jp-mod-bottom">
              <div className="jp-xtralab-ImageDiff-swipeDividerArrow jp-mod-left" />
              <div className="jp-xtralab-ImageDiff-swipeDividerArrow jp-mod-right" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OnionSkin({
  reference,
  challenger,
  trans
}: ISideViewProps): React.ReactElement {
  const [opacity, setOpacity] = React.useState(50);
  return (
    <div className="jp-xtralab-ImageDiff-interactive">
      <div className="jp-xtralab-ImageDiff-stack">
        {reference.uri !== null ? (
          <img
            className="jp-xtralab-ImageDiff-stackImg"
            src={reference.uri}
            alt={trans.__('Reference revision')}
          />
        ) : null}
        {challenger.uri !== null ? (
          <img
            className="jp-xtralab-ImageDiff-stackImg"
            src={challenger.uri}
            alt={trans.__('Challenger revision')}
            style={{ opacity: opacity / 100 }}
          />
        ) : null}
      </div>
      <RangeSlider
        value={opacity}
        onChange={setOpacity}
        ariaLabel={trans.__('Fade between reference and challenger')}
      />
    </div>
  );
}
