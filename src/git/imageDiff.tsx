import * as React from 'react';

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
}

/**
 * The image comparison surface: a segmented mode selector (reusing the
 * diff segmented-control styling so it matches the Notebook/JSON toggle)
 * plus the selected 2-up / swipe / onion-skin view.
 */
export function ImageDiffView(props: IImageDiffViewProps): React.ReactElement {
  const { reference, challenger, fileType } = props;
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
          aria-label="Image diff view mode"
        >
          {(
            [
              ['2-up', '2-up'],
              ['swipe', 'Swipe'],
              ['onion', 'Onion Skin']
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
          <TwoUp reference={ref} challenger={chall} />
        ) : mode === 'swipe' ? (
          <Swipe reference={ref} challenger={chall} />
        ) : (
          <OnionSkin reference={ref} challenger={chall} />
        )}
      </div>
    </div>
  );
}

interface ISideViewProps {
  reference: IImageSide;
  challenger: IImageSide;
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

function TwoUp({ reference, challenger }: ISideViewProps): React.ReactElement {
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
              alt="Reference revision"
              onLoad={onRefLoad}
            />
          ) : (
            <div className="jp-xtralab-ImageDiff-empty">No previous image</div>
          )}
        </div>
        <figcaption className="jp-xtralab-ImageDiff-caption">
          {caption(reference, refSize, 'Added')}
        </figcaption>
      </figure>
      <figure className="jp-xtralab-ImageDiff-col">
        <div className="jp-xtralab-ImageDiff-frame" data-side="challenger">
          {challenger.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-img"
              src={challenger.uri}
              alt="Challenger revision"
              onLoad={onChallLoad}
            />
          ) : (
            <div className="jp-xtralab-ImageDiff-empty">Deleted</div>
          )}
        </div>
        <figcaption className="jp-xtralab-ImageDiff-caption">
          {caption(challenger, challSize, 'Deleted')}
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

function Swipe({ reference, challenger }: ISideViewProps): React.ReactElement {
  const [position, setPosition] = React.useState(50);
  const [dragging, setDragging] = React.useState(false);
  const frameRef = React.useRef<HTMLDivElement>(null);

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
      <div
        className="jp-xtralab-ImageDiff-swipeFrame"
        ref={frameRef}
        onPointerDown={onPointerDown}
        data-dragging={dragging ? 'true' : undefined}
      >
        <div className="jp-xtralab-ImageDiff-stack">
          {reference.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-stackImg"
              src={reference.uri}
              alt="Reference revision"
              draggable={false}
              style={{
                clipPath: `inset(0 ${100 - position}% 0 0)`
              }}
            />
          ) : null}
          {challenger.uri !== null ? (
            <img
              className="jp-xtralab-ImageDiff-stackImg"
              src={challenger.uri}
              alt="Challenger revision"
              draggable={false}
              style={{
                clipPath: `inset(0 0 0 ${position}%)`
              }}
            />
          ) : null}
        </div>
        <div
          className="jp-xtralab-ImageDiff-swipeDivider"
          style={{ left: `${position}%` }}
          role="slider"
          aria-label="Swipe between reference and challenger"
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
  );
}

function OnionSkin({
  reference,
  challenger
}: ISideViewProps): React.ReactElement {
  const [opacity, setOpacity] = React.useState(50);
  return (
    <div className="jp-xtralab-ImageDiff-interactive">
      <div className="jp-xtralab-ImageDiff-stack">
        {reference.uri !== null ? (
          <img
            className="jp-xtralab-ImageDiff-stackImg"
            src={reference.uri}
            alt="Reference revision"
          />
        ) : null}
        {challenger.uri !== null ? (
          <img
            className="jp-xtralab-ImageDiff-stackImg"
            src={challenger.uri}
            alt="Challenger revision"
            style={{ opacity: opacity / 100 }}
          />
        ) : null}
      </div>
      <RangeSlider
        value={opacity}
        onChange={setOpacity}
        ariaLabel="Fade between reference and challenger"
      />
    </div>
  );
}
