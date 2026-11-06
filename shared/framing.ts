/**
 * Framing of a material shot: which part of the image or video fills the screen, at the start and at the end
 * of the segment. The renderer eases from one frame to the other.
 */
export interface ShotFrame {
  /** Point of the material, as a fraction of its width and height, that sits at the centre of the screen. */
  x: number;
  y: number;
  /** 1 fills the screen with the whole material cropped to the screen's aspect (cover); higher values zoom in. */
  zoom: number;
}

export interface Framing {
  start: ShotFrame;
  end: ShotFrame;
}

export const MAX_ZOOM = 4;

const CENTRE: ShotFrame = { x: 0.5, y: 0.5, zoom: 1 };

/** Images drift slowly closer; videos hold still. */
export const defaultFraming = (kind: "image" | "video"): Framing => ({ start: { ...CENTRE }, end: kind === "image" ? { ...CENTRE, zoom: 1.07 } : { ...CENTRE } });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where to draw a material of iw × ih pixels in a viewport of vw × vh so that `f` is shown.
 * The material always covers the whole viewport: a focus point too close to an edge is pushed inwards.
 */
export function frameRect(iw: number, ih: number, vw: number, vh: number, f: ShotFrame) {
  const scale = Math.max(vw / iw, vh / ih) * clamp(f.zoom, 1, MAX_ZOOM);
  const width = iw * scale;
  const height = ih * scale;
  return {
    left: clamp(vw / 2 - f.x * width, vw - width, 0),
    top: clamp(vh / 2 - f.y * height, vh - height, 0),
    width,
    height,
  };
}

/** The same frame with its focus point moved to where frameRect actually centres it. */
export function clampFrame(iw: number, ih: number, vw: number, vh: number, f: ShotFrame): ShotFrame {
  const zoom = clamp(f.zoom, 1, MAX_ZOOM);
  const r = frameRect(iw, ih, vw, vh, { ...f, zoom });
  return { x: (vw / 2 - r.left) / r.width, y: (vh / 2 - r.top) / r.height, zoom };
}

/** Ease-in-out between two frames; t runs from 0 to 1. */
export function frameAt(framing: Framing, t: number): ShotFrame {
  const u = clamp(t, 0, 1);
  const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
  const { start: a, end: b } = framing;
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: a.zoom + (b.zoom - a.zoom) * e };
}
