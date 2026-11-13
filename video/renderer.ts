import { frameAt, frameRect } from "../shared/framing";
import { STACK_STAGGER_SECONDS, themeColors, type Caption, type ThemeColors, type TimelineBumper, type TimelineProps, type TimelineSegment } from "../shared/types";
import { BUMPER_ANIMATIONS } from "./bumpers";
import type { Ctx, FootageFrame, Picture, Platform } from "./platform";
import { FADE_FRAMES, footageSeconds, segmentWindows, type SegmentWindow } from "./schedule";

/** Family of the theme's display font. */
const DISPLAY_FAMILY = "DevlogDisplay";
/**
 * Families that the server registers only where the canvas draws no letters in a generic family, as on some Linux
 * systems. A browser doesn't know them and skips them, so the preview keeps its fonts.
 */
export const FALLBACK_FAMILIES = { sans: "DevlogSans", cursive: "DevlogCursive" } as const;
const DISPLAY = `${DISPLAY_FAMILY}, 'Segoe Print', 'Comic Sans MS', ${FALLBACK_FAMILIES.cursive}, cursive`;
const BODY = `'Segoe UI', Inter, ${FALLBACK_FAMILIES.sans}, system-ui, sans-serif`;
/** The font stacks of a video's text, without size and weight. */
export const FONT_STACKS = { display: DISPLAY, body: BODY } as const;

/** A link as people read it: without the protocol, "www." or a trailing slash. */
export const displayLink = (url: string) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");

/** The text, shortened in the middle with an ellipsis until it fits. */
export function fitMiddle(width: (s: string) => number, text: string, max: number): string {
  if (width(text) <= max) return text;
  let keep = text.length - 1;
  const cut = (n: number) => `${text.slice(0, Math.ceil(n * 0.6))}…${text.slice(text.length - Math.floor(n * 0.4))}`;
  while (keep > 4 && width(cut(keep)) > max) keep--;
  return cut(keep);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Linear map from one range to another; `limit` stops at the ends of the range. */
const map = (v: number, from: [number, number], to: [number, number], limit = false) => {
  const t = (v - from[0]) / (from[1] - from[0]);
  return to[0] + (limit ? clamp(t, 0, 1) : t) * (to[1] - to[0]);
};

/** Damped spring from 0 to 1 at `frame`; 0 before frame 0. */
export function spring(frame: number, fps: number, damping: number, stiffness: number, mass: number): number {
  if (frame <= 0) return 0;
  const t = frame / fps;
  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const omega1 = omega0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * omega0 * t) * (Math.cos(omega1 * t) + ((zeta * omega0) / omega1) * Math.sin(omega1 * t));
}

/** Deterministic value in [0, 1) for a seed and index, so a stack looks the same in every render. */
export function jitter(seed: string, i: number, salt: number): number {
  let h = 2166136261 ^ (i * 374761393 + salt * 668265263);
  for (let c = 0; c < seed.length; c++) h = Math.imul(h ^ seed.charCodeAt(c), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Greedy line breaking at spaces, as a browser breaks a paragraph. */
export function wrapText(measure: (text: string) => number, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Top-left corner and scale that make a picture cover a box, cropping what sticks out. */
function drawCover(ctx: Ctx, p: Picture, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / p.width, h / p.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(p.source, (p.width - sw) / 2, (p.height - sh) / 2, sw, sh, x, y, w, h);
}

interface TextBlock {
  lines: string[];
  height: number;
  /** Widest line. */
  width: number;
  /** Baseline of the first line, from the top of the block. */
  baseline: number;
  lineHeight: number;
}

/** One item of a slide's column: its size, and how to draw it with its top at `y`. */
interface SlideItem {
  height: number;
  marginBottom?: number;
  /** Drawn after the other items. */
  onTop?: boolean;
  draw(ctx: Ctx, y: number): void;
}

/** Everything one video needs in memory, and the drawing of its frames. */
export class VideoFrameRenderer {
  private readonly t: TimelineProps;
  private readonly platform: Platform;
  private readonly footage: FootageFrame;
  private readonly windows: SegmentWindow[];
  private readonly colors: ThemeColors;
  private readonly portrait: boolean;
  /** Size of the canvases, in output pixels. */
  private readonly px: { width: number; height: number };
  /** Output pixels per video pixel. */
  private readonly scale: number;
  private readonly pictures = new Map<string, Picture>();
  /** Segments whose footage is dark where the label sits, so the label swaps its colours to stand out. */
  private readonly darkBehindLabel = new Set<string>();
  private readonly blurred = new Map<string, HTMLCanvasElement>();
  private readonly backgrounds: string[];
  private readonly layers: HTMLCanvasElement[] = [];
  private readonly bumperDraw = new Map<TimelineBumper, (ctx: Ctx, frame: number) => void>();
  private readonly textCache = new Map<string, TextBlock>();
  private readonly shadowSprites = new Map<string, HTMLCanvasElement>();
  private grainCanvas?: HTMLCanvasElement;
  private bumperCanvas?: HTMLCanvasElement;

  private constructor(t: TimelineProps, platform: Platform, footage: FootageFrame, scale: number) {
    this.t = t;
    this.platform = platform;
    this.footage = footage;
    this.scale = scale;
    this.px = outputSize(t, scale);
    this.windows = segmentWindows(t);
    this.colors = themeColors(t.theme.colors);
    this.portrait = t.format === "portrait";
    const stills = t.segments.filter((s) => s.media?.kind === "image").map((s) => s.media!.src);
    this.backgrounds = t.theme.backgrounds.length ? t.theme.backgrounds : stills;
  }

  /**
   * Loads the pictures, fonts and bumpers of a timeline. A picture that fails to load stops an export, which
   * must not publish an empty frame; a preview (`tolerant`) leaves its place empty and carries on.
   */
  static async create(t: TimelineProps, platform: Platform, footage: FootageFrame, { scale = 1, tolerant = false }: { scale?: number; tolerant?: boolean } = {}): Promise<VideoFrameRenderer> {
    const r = new VideoFrameRenderer(t, platform, footage, scale);
    if (t.theme.fontUrl) await platform.loadFont(t.theme.fontUrl, DISPLAY_FAMILY).catch(() => {});
    const urls = new Set<string>([...(t.theme.logoUrl ? [t.theme.logoUrl] : [])]);
    t.segments.forEach((s, i) => {
      if (s.visual.type === "slide" && r.backgrounds.length) urls.add(r.backgrounds[i % r.backgrounds.length]);
      if (s.media?.kind === "image") urls.add(s.media.src);
      if (s.media?.poster) urls.add(s.media.poster);
      for (const src of s.slideImages ?? []) urls.add(src);
    });
    await Promise.all([...urls].map(async (url) => {
      try {
        r.pictures.set(url, await platform.loadImage(url));
      } catch (err) {
        if (!tolerant) throw err;
      }
    }));
    for (const s of t.segments) if (s.onScreen && s.media && r.isDarkBehindLabel(s)) r.darkBehindLabel.add(s.id);
    for (const [placement, bumper] of [["intro", t.theme.intro], ["outro", t.theme.outro]] as const) {
      const animation = bumper && BUMPER_ANIMATIONS[bumper.style];
      if (!animation) continue;
      r.bumperDraw.set(bumper, await animation.prepare({ platform, params: bumper.params, placement, durationInFrames: bumper.durationInFrames, fps: t.fps, width: t.width, height: t.height, portrait: r.portrait, title: t.theme.gameTitle }));
    }
    return r;
  }

  /** Draws one frame. The canvas is the size of `outputSize`. */
  draw(ctx: Ctx, frame: number) {
    const { t } = this;
    this.reset(ctx);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, t.width, t.height);
    const last = this.windows.length - 1;
    const outroFrames = t.theme.outro?.durationInFrames ?? 0;
    for (const w of this.windows) {
      if (frame < w.start || frame >= w.end) continue;
      const local = frame - w.start;
      const opacity = w.index === 0 ? 1 : map(local, [0, FADE_FRAMES], [0, 1], true);
      const labelFrames = w.index === last && outroFrames ? w.end - w.start - outroFrames : undefined;
      this.withOpacity(ctx, opacity, (c) => this.drawSegment(c, w, local, labelFrames));
    }
    this.drawCaption(ctx, frame);
    if (t.segments.length) {
      if (t.theme.intro && frame < t.theme.intro.durationInFrames) this.drawBumper(ctx, t.theme.intro, frame);
      if (t.theme.outro && frame >= t.durationInFrames - outroFrames) this.drawBumper(ctx, t.theme.outro, frame - (t.durationInFrames - outroFrames));
    }
  }

  private reset(ctx: Ctx) {
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }

  /** Draws a group as one, so its overlapping parts do not show through each other while it fades. */
  private withOpacity(ctx: Ctx, opacity: number, draw: (ctx: Ctx) => void) {
    if (opacity >= 1) return draw(ctx);
    if (opacity <= 0) return;
    const layer = this.layers.pop() ?? this.platform.createCanvas(this.px.width, this.px.height);
    const c = layer.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, layer.width, layer.height);
    this.reset(c);
    draw(c);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = opacity;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    this.layers.push(layer);
  }

  /**
   * The shadow of a box, as CSS box-shadow draws it: the blur radius is twice the deviation of the blur. Filtered
   * sprites replace canvas shadows because their strength differs between the browser and the server's canvas.
   */
  private drawBoxShadow(ctx: Ctx, x: number, y: number, width: number, height: number, color: string, blur: number, dy: number) {
    const pad = Math.ceil(blur * 1.5) + 2;
    const key = `${width}|${height}|${color}|${blur}`;
    let sprite = this.shadowSprites.get(key);
    if (!sprite) {
      sprite = this.platform.createCanvas(Math.ceil((width + 2 * pad) * this.scale), Math.ceil((height + 2 * pad) * this.scale));
      const c = sprite.getContext("2d")!;
      c.filter = `blur(${(blur / 2) * this.scale}px)`;
      c.fillStyle = color;
      c.fillRect(pad * this.scale, pad * this.scale, width * this.scale, height * this.scale);
      c.filter = "none";
      this.shadowSprites.set(key, sprite);
    }
    ctx.drawImage(sprite, x - pad, y - pad + dy, sprite.width / this.scale, sprite.height / this.scale);
  }

  /** The text shadows of a caption, drawn once per text. The sprite is centred on the block horizontally. */
  private captionShadow(font: string, block: TextBlock, strokeWidth: number) {
    // Room for the wide halo's blur, which fades out within about three times its radius.
    const pad = 72;
    const key = `${font}|${block.lines.join("\n")}`;
    let sprite = this.shadowSprites.get(key);
    if (!sprite) {
      sprite = this.platform.createCanvas(Math.ceil((block.width + 2 * pad) * this.scale), Math.ceil((block.height + 2 * pad) * this.scale));
      const c = sprite.getContext("2d")!;
      c.scale(this.scale, this.scale);
      c.font = font;
      c.textAlign = "center";
      c.lineJoin = "miter";
      c.miterLimit = 4;
      c.lineWidth = strokeWidth;
      // Painted in order: a wide dark halo first, which mutes light text of a page behind the subtitle, then the soft
      // drop shadow and the two tight outlines.
      for (const [color, blur, dy] of [["rgba(0,0,0,0.7)", 44, 0], ["rgba(0,0,0,0.8)", 14, 4], ["#000", 3, 0], ["#000", 3, 0]] as const) {
        c.filter = `blur(${(blur / 2) * this.scale}px)`;
        c.fillStyle = color;
        c.strokeStyle = color;
        block.lines.forEach((line, i) => {
          const y = pad + block.baseline + i * block.lineHeight + dy;
          c.strokeText(line, block.width / 2 + pad, y);
          c.fillText(line, block.width / 2 + pad, y);
        });
      }
      c.filter = "none";
      this.shadowSprites.set(key, sprite);
    }
    return { sprite, pad };
  }

  private drawSegment(ctx: Ctx, w: SegmentWindow, frame: number, labelFrames?: number) {
    const seg = w.segment;
    if (seg.visual.type === "slide") {
      this.drawSlide(ctx, seg, frame, this.backgrounds.length ? this.backgrounds[w.index % this.backgrounds.length] : undefined);
      if (seg.source) this.drawSource(ctx, seg.source, frame - (seg.introFrames ?? 0));
      return;
    }
    if (seg.media) {
      this.drawFootage(ctx, seg, frame);
      const shade = ctx.createLinearGradient(0, 0, 0, this.t.height);
      shade.addColorStop(0, "rgba(0,0,0,0.25)");
      shade.addColorStop(0.22, "rgba(0,0,0,0)");
      shade.addColorStop(0.62, "rgba(0,0,0,0)");
      shade.addColorStop(1, "rgba(0,0,0,0.45)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, this.t.width, this.t.height);
    } else this.drawMissing(ctx, seg);
    const intro = seg.introFrames ?? 0;
    if (seg.onScreen && frame >= intro && (labelFrames === undefined || frame < labelFrames)) this.drawLabel(ctx, seg.onScreen, frame - intro, this.darkBehindLabel.has(seg.id));
    if (seg.source && frame >= intro) this.drawSource(ctx, seg.source, frame - intro);
  }

  /**
   * The credit and link of a source, as one slim band along the bottom edge for the whole segment, so it doesn't
   * compete with the label and the subtitles. A slide with a credit and no link shows the credit alone.
   */
  private drawSource(ctx: Ctx, source: NonNullable<TimelineSegment["source"]>, frame: number) {
    const { portrait } = this;
    const { width: W, height: H } = this.t;
    const { paper, ink, accent } = this.colors;
    const size = portrait ? 28 : 22;
    const padX = portrait ? 32 : 28;
    const bandHeight = Math.round(size * 2);
    const creditFont = `600 ${size}px ${BODY}`;
    const linkFont = `${size}px ${BODY}`;
    const room = W - padX * 2;
    const separator = "  ·  ";
    ctx.font = creditFont;
    const credit = source.credit ? fitMiddle((s) => ctx.measureText(s).width, source.credit, room * 0.45) : "";
    const creditWidth = credit ? ctx.measureText(credit + (source.url ? separator : "")).width : 0;
    ctx.font = linkFont;
    const link = source.url ? fitMiddle((s) => ctx.measureText(s).width, displayLink(source.url), room - creditWidth) : "";
    const appear = map(frame, [0, 10], [0, 1], true);
    const top = H - bandHeight;
    ctx.save();
    ctx.globalAlpha = appear;
    ctx.fillStyle = `${paper}d9`;
    ctx.fillRect(0, top, W, bandHeight);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const y = top + bandHeight / 2;
    if (credit) {
      ctx.font = creditFont;
      ctx.fillStyle = ink;
      ctx.fillText(credit + (link ? separator : ""), padX, y);
    }
    if (link) {
      ctx.font = linkFont;
      ctx.fillStyle = accent;
      ctx.fillText(link, padX + creditWidth, y);
    }
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  private drawFootage(ctx: Ctx, seg: TimelineSegment, frame: number) {
    const { width: W, height: H } = this.t;
    const m = seg.media!;
    const video = m.kind === "video" ? this.footage(seg.id) : null;
    if (m.size && m.framing) {
      const r = frameRect(m.size.width, m.size.height, W, H, frameAt(m.framing, frame / Math.max(1, seg.durationInFrames - 1)));
      const still = m.kind === "video" ? (m.poster ? this.pictures.get(m.poster) : undefined) : this.pictures.get(m.src);
      if (still) ctx.drawImage(still.source, r.left, r.top, r.width, r.height);
      if (video) ctx.drawImage(video.source, r.left, r.top, r.width, r.height);
      return;
    }
    if (m.kind === "video") {
      const poster = m.poster ? this.pictures.get(m.poster) : undefined;
      if (poster) drawCover(ctx, poster, 0, 0, W, H);
      if (video) drawCover(ctx, video, 0, 0, W, H);
      return;
    }
    const picture = this.pictures.get(m.src);
    if (!picture) return;
    const scale = map(frame, [0, seg.durationInFrames], [1, 1.07]);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, scale);
    drawCover(ctx, picture, -W / 2, -H / 2, W, H);
    ctx.restore();
  }

  // ---------- text ----------

  /** Lines of a text at a font, with the line box a browser gives them. */
  private block(ctx: Ctx, font: string, text: string, maxWidth: number, lineHeightFactor?: number): TextBlock {
    const key = `${font}|${maxWidth}|${lineHeightFactor}|${text}`;
    const cached = this.textCache.get(key);
    if (cached) return cached;
    ctx.font = font;
    const lines = wrapText((s) => ctx.measureText(s).width, text, maxWidth);
    const m = ctx.measureText("Hg");
    const ascent = m.fontBoundingBoxAscent;
    const descent = m.fontBoundingBoxDescent;
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    const lineHeight = lineHeightFactor ? lineHeightFactor * size : ascent + descent;
    const block: TextBlock = {
      lines,
      lineHeight,
      height: lines.length * lineHeight,
      width: Math.max(0, ...lines.map((l) => ctx.measureText(l).width)),
      baseline: (lineHeight - (ascent + descent)) / 2 + ascent,
    };
    this.textCache.set(key, block);
    return block;
  }

  private drawBlock(ctx: Ctx, font: string, block: TextBlock, x: number, y: number, align: "left" | "center", color: string) {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    block.lines.forEach((line, i) => ctx.fillText(line, x, y + block.baseline + i * block.lineHeight));
    ctx.textAlign = "left";
  }

  /**
   * Whether the footage is dark in the band where the label sits. It reads the segment's still once, so the preview
   * and the export decide alike and a moving clip doesn't make the label flicker.
   */
  private isDarkBehindLabel(seg: TimelineSegment): boolean {
    const m = seg.media!;
    const picture = this.pictures.get(m.kind === "image" ? m.src : m.poster ?? "");
    if (!picture) return false;
    const w = this.portrait ? 54 : 96, h = this.portrait ? 96 : 54;
    const canvas = this.platform.createCanvas(w, h);
    const c = canvas.getContext("2d")!;
    drawCover(c, picture, 0, 0, w, h);
    const top = Math.floor(h * (this.portrait ? 0.1 : 0.04)), bottom = Math.ceil(h * (this.portrait ? 0.24 : 0.2));
    // Portrait labels sit centred across the width, landscape labels at the top left.
    const right = this.portrait ? w : Math.ceil(w * 0.6);
    const data = c.getImageData(0, top, right, bottom - top).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    return sum / (data.length / 4) / 255 < 0.45;
  }

  private drawLabel(ctx: Ctx, text: string, frame: number, inverted = false) {
    const { portrait } = this;
    const { paper: themePaper, ink: themeInk } = this.colors;
    // On dark footage the label swaps paper and ink, so it never sinks into the page behind it.
    const paper = inverted ? themeInk : themePaper;
    const ink = inverted ? themePaper : themeInk;
    // Large and well padded, so the label holds its own against a busy page behind it.
    const font = `${portrait ? 78 : 62}px ${DISPLAY}`;
    const block = this.block(ctx, font, text, portrait ? this.t.width - 200 : 1200);
    const padX = portrait ? 44 : 36, padY = portrait ? 22 : 18;
    const width = block.width + padX * 2;
    const height = block.height + padY * 2;
    const y = map(frame, [0, 10], [-30, 0], false);
    const dy = frame >= 10 ? 0 : y;
    const left = portrait ? this.t.width / 2 - width / 2 : 70;
    const top = (portrait ? 230 : 60) + dy;
    const rotation = (-2 * Math.PI) / 180;
    ctx.save();
    ctx.translate(left + width / 2, top + height / 2);
    ctx.rotate(rotation);
    this.drawBoxShadow(ctx, -width / 2, -height / 2, width, height, "rgba(0,0,0,0.5)", 28, 10);
    ctx.fillStyle = paper;
    ctx.fillRect(-width / 2, -height / 2, width, height);
    this.drawBlock(ctx, font, block, -width / 2 + padX, -height / 2 + padY, "left", ink);
    ctx.restore();
  }

  private drawCaption(ctx: Ctx, frame: number) {
    const ms = (frame / this.t.fps) * 1000;
    const cur: Caption | undefined = this.t.captions.find((c) => ms >= c.startMs && ms < c.endMs);
    if (!cur) return;
    if (this.t.theme.subtitlesOnTitleSlides === false) {
      const shown = this.windows.find((w) => frame >= w.start && frame < w.end)?.segment.visual;
      if (shown?.type === "slide" && shown.layout === "title") return;
    }
    const { portrait } = this;
    const { width: W, height: H } = this.t;
    const pop = map(ms - cur.startMs, [0, 90], [0.92, 1], true);
    const font = `800 ${portrait ? 76 : 50}px ${BODY}`;
    const block = this.block(ctx, font, cur.text, Math.min(W - 120, portrait ? 940 : 1500), 1.15);
    const bottom = H - (portrait ? 620 : 90);
    const top = bottom - block.height;
    ctx.save();
    ctx.translate(W / 2, top + block.height / 2);
    ctx.scale(pop, pop);
    ctx.translate(0, -block.height / 2);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.lineJoin = "miter";
    ctx.miterLimit = 4;
    const strokeWidth = portrait ? 2 : 1;
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = "#000";
    const baselines = block.lines.map((line, i) => [line, block.baseline + i * block.lineHeight] as const);
    const { sprite, pad } = this.captionShadow(font, block, strokeWidth);
    ctx.drawImage(sprite, -block.width / 2 - pad, -pad, sprite.width / this.scale, sprite.height / this.scale);
    ctx.fillStyle = cur.color ?? "#fff";
    for (const [line, y] of baselines) {
      ctx.strokeText(line, 0, y);
      ctx.fillText(line, 0, y);
    }
    ctx.restore();
  }

  // ---------- slides ----------

  /** Static print-like noise over the paper, multiplied into the picture. */
  private grain(): HTMLCanvasElement {
    if (this.grainCanvas) return this.grainCanvas;
    const { width, height } = this.px;
    const canvas = this.platform.createCanvas(width, height);
    const data = new Uint8ClampedArray(width * height * 4);
    // A fixed sequence, so a frame looks the same in every render.
    let state = 0x2f6e2b1;
    const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    for (let i = 0; i < data.length; i += 4) {
      const gray = 219 + (next() + next() - 1) * 27;
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      data[i + 3] = 255;
    }
    canvas.getContext("2d")!.putImageData(this.platform.newImageData(data, width, height), 0, 0);
    return (this.grainCanvas = canvas);
  }

  /** A background picture blurred once: the blur is the slowest part of a slide and does not change. */
  private blurredBackground(src: string): HTMLCanvasElement | undefined {
    const known = this.blurred.get(src);
    if (known) return known;
    const picture = this.pictures.get(src);
    if (!picture) return undefined;
    const canvas = this.platform.createCanvas(this.px.width, this.px.height);
    const c = canvas.getContext("2d")!;
    c.imageSmoothingQuality = "high";
    c.filter = `blur(${28 * this.scale}px) saturate(0.8)`;
    drawCover(c, picture, 0, 0, this.px.width, this.px.height);
    c.filter = "none";
    this.blurred.set(src, canvas);
    return canvas;
  }

  private drawPaper(ctx: Ctx, frame: number, image?: string) {
    const { width: W, height: H } = this.t;
    const { paper, paperLight, paperShade, wash } = this.colors;
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, W, H);
    const blurred = image ? this.blurredBackground(image) : undefined;
    if (blurred) {
      const scale = 1.15 + frame * 0.0004;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(scale, scale);
      ctx.drawImage(blurred, -W / 2, -H / 2, W, H);
      ctx.restore();
    }
    if (image) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `${paper}e6`);
      g.addColorStop(0.6, `${paper}cc`);
      g.addColorStop(1, `${wash}b3`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else {
      // An ellipse at 30% 20% reaching the farthest corner.
      const cx = 0.3 * W;
      const cy = 0.2 * H;
      const rx = 0.7 * W * Math.SQRT2;
      const ry = 0.8 * H * Math.SQRT2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, paperLight);
      g.addColorStop(0.55, paper);
      g.addColorStop(1, paperShade);
      ctx.fillStyle = g;
      ctx.fillRect(-cx / rx, -cy / ry, W / rx, H / ry);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(this.grain(), 0, 0, W, H);
    ctx.restore();
    if (!image) {
      // The wash is one frame tall and starts at 84%, so only its faint start is visible.
      const top = 0.84 * H;
      const g = ctx.createLinearGradient(0, top, 0, top + H);
      g.addColorStop(0, `${wash}00`);
      g.addColorStop(0.4, `${wash}55`);
      g.addColorStop(1, `${wash}88`);
      ctx.fillStyle = g;
      ctx.fillRect(0, top, W, H - top);
    }
  }

  /** A photo print with its centre at (cx, cy). `width` is the picture's; the frame adds 3% on each side. */
  private drawPolaroid(ctx: Ctx, src: string, cx: number, cy: number, width: number, tilt: number, caption: string | undefined, tape: boolean) {
    const { polaroid, ink } = this.colors;
    const pad = width * 0.03;
    const outerW = width + 2 * pad;
    const imageH = width * 0.62;
    const outerH = pad + imageH + width * 0.09;
    const rotation = (tilt * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.translate(-outerW / 2, -outerH / 2);
    this.drawBoxShadow(ctx, 0, 0, outerW, outerH, "rgba(0,0,0,0.35)", 40, 18);
    ctx.fillStyle = polaroid;
    ctx.fillRect(0, 0, outerW, outerH);
    const picture = this.pictures.get(src);
    if (picture) drawCover(ctx, picture, pad, pad, width, imageH);
    if (tape) {
      const tapeW = width * 0.3;
      const tapeH = Math.max(38, width * 0.075);
      ctx.save();
      ctx.translate(outerW / 2, -tapeH * 0.45 + tapeH / 2);
      ctx.rotate((-3 * Math.PI) / 180);
      ctx.fillStyle = "rgba(232,220,180,0.85)";
      ctx.fillRect(-tapeW / 2, -tapeH / 2, tapeW, tapeH);
      ctx.restore();
    }
    if (caption) {
      const size = width * 0.055;
      const font = `${size}px ${DISPLAY}`;
      ctx.font = font;
      const room = outerW - width * 0.1;
      let shown = caption;
      if (ctx.measureText(shown).width > room) {
        while (shown.length && ctx.measureText(`${shown}…`).width > room) shown = shown.slice(0, -1);
        shown = `${shown}…`;
      }
      const block = this.block(ctx, font, shown, Infinity, 1.2);
      this.drawBlock(ctx, font, block, outerW / 2, outerH - width * 0.09 + (width * 0.09 - block.height) / 2, "center", ink);
    }
    ctx.restore();
  }

  private slideItems(ctx: Ctx, seg: TimelineSegment, frame: number): { items: SlideItem[]; box: { padding: number; paddingTop: number; paddingBottom: number; gap: number }; top: boolean } {
    const { portrait } = this;
    const { width: W, height: H, fps } = this.t;
    const { ink, accent } = this.colors;
    const v = seg.visual.type === "slide" ? seg.visual : null;
    const images = (seg.slideImages ?? []);
    const layout = v?.layout ?? "title";
    const headingSize = portrait ? 96 : 92;
    const pad = portrait ? 90 : 140;
    const pictures = (layout === "image" || layout === "compare" || layout === "stack") && images.length > 0;
    const box = pictures
      ? { padding: portrait ? 60 : 80, paddingTop: portrait ? 190 : 60, paddingBottom: portrait ? 260 : 90, gap: portrait ? 36 : 28 }
      : { padding: pad, paddingTop: portrait ? 240 : pad, paddingBottom: portrait ? 760 : pad + 80, gap: portrait ? 50 : 40 };
    const contentWidth = W - 2 * box.padding;
    const rise = (delay: number) => ({
      opacity: map(frame, [delay, delay + 10], [0, 1], true),
      dy: map(frame, [delay, delay + 10], [24, 0], true),
    });
    const risen = (delay: number, draw: (c: Ctx) => void) => (c: Ctx) => {
      const { opacity, dy } = rise(delay);
      this.withOpacity(c, opacity, (layer) => {
        layer.save();
        layer.translate(0, dy);
        draw(layer);
        layer.restore();
      });
    };
    const items: SlideItem[] = [];
    const logo = this.t.theme.logoUrl ? this.pictures.get(this.t.theme.logoUrl) : undefined;
    if ((layout === "title" || layout === "outro") && logo) {
      const width = portrait ? W * 0.8 : W * (layout === "outro" ? 0.45 : 0.28);
      const height = (width * logo.height) / logo.width;
      items.push({ height, draw: (c, y) => risen(0, (l) => l.drawImage(logo.source, (W - width) / 2, y, width, height))(c) });
    }
    if (v?.heading) {
      const size = layout === "title" ? headingSize * (logo ? 1.1 : 1.3) : pictures ? headingSize * 0.8 : headingSize;
      const font = `${size}px ${DISPLAY}`;
      const block = this.block(ctx, font, v.heading, contentWidth, 1.1);
      const left = layout === "bullets";
      items.push({
        height: block.height,
        marginBottom: layout === "stack" && images.length ? (portrait ? W * 0.8 : W * 0.46) * 0.1 : 0,
        onTop: true,
        draw: (c, y) => risen(4, (l) => this.drawBlock(l, font, block, left ? box.padding : W / 2, y, left ? "left" : "center", ink))(c),
      });
    }
    if (layout === "bullets") {
      const font = `${portrait ? 56 : 50}px ${DISPLAY}`;
      const gap = portrait ? 34 : 26;
      ctx.font = font;
      const dashWidth = ctx.measureText("—").width;
      const rows = (v?.bullets ?? []).map((b) => this.block(ctx, font, b, contentWidth - dashWidth - 26, 1.2));
      const dash = this.block(ctx, font, "—", Infinity, 1.2);
      items.push({
        height: rows.reduce((n, r) => n + r.height, 0) + Math.max(0, rows.length - 1) * gap,
        draw: (c, y) => {
          let at = y;
          rows.forEach((row, i) => {
            const rowY = at;
            risen(12 + i * 8, (l) => {
              this.drawBlock(l, font, dash, box.padding, rowY, "left", accent);
              this.drawBlock(l, font, row, box.padding + dashWidth + 26, rowY, "left", ink);
            })(c);
            at += row.height + gap;
          });
        },
      });
    }
    const captions = seg.slideCaptions;
    if (layout === "image" && images[0]) {
      const width = portrait ? W * 0.88 : W * 0.54;
      items.push({ height: width * 0.74, draw: (c, y) => risen(8, (l) => this.drawPolaroid(l, images[0], W / 2, y + width * 0.37, width, -2, captions?.[0] || undefined, true))(c) });
    }
    if (layout === "stack" && images.length) {
      const size = portrait ? W * 0.8 : W * 0.46;
      const polaroidH = size * 0.74;
      const stagger = seg.stackStaggerFrames ?? Math.round(STACK_STAGGER_SECONDS * fps);
      const entrance = v?.entrance ?? "drop";
      items.push({
        height: polaroidH,
        draw: (c, y) => {
          // The print is wider than the stack's box by its frame and starts at the box's left edge.
          const boxLeft = (W - size) / 2;
          const outerW = size * 1.06;
          images.forEach((src, i) => {
            const side = i % 2 === 0 ? -1 : 1;
            const rotation = side * (2 + 6 * jitter(seg.id, i, 1));
            const dx = (jitter(seg.id, i, 2) - 0.5) * (portrait ? 0.12 : 0.16) * W;
            const dy = (jitter(seg.id, i, 3) - 0.25) * (portrait ? 0.06 : 0.08) * H;
            const t = spring(frame - 6 - i * stagger, fps, 14, 120, 0.9);
            if (t <= 0.001) return;
            const fromX = entrance === "slide" ? side * (W * 0.5 + size) : dx;
            const fromY = entrance === "drop" ? -(H * 0.5 + polaroidH) : dy;
            const x = map(t, [0, 1], [fromX, dx]);
            const py = map(t, [0, 1], [fromY, dy]);
            const r = map(t, [0, 1], [rotation + (entrance === "drop" ? side * 14 : -side * 18), rotation]);
            this.drawPolaroid(c, src, boxLeft + x + outerW / 2, y + py + polaroidH / 2, size, r, captions?.[i] || undefined, false);
          });
        },
      });
    }
    if (layout === "compare" && images.length >= 2) {
      const width = portrait ? W * 0.78 : W * 0.43;
      const outerH = width * 0.74;
      const outerW = width * 1.06;
      const gap = portrait ? 44 : 56;
      const tilts = [-2.5, 2];
      const defaults = ["Before", "After"];
      items.push({
        height: portrait ? 2 * outerH + gap : outerH,
        draw: (c, y) => risen(8, (l) => {
          for (const i of [0, 1]) {
            const cx = portrait ? W / 2 : W / 2 + (i === 0 ? -1 : 1) * (outerW + gap) / 2;
            const cy = portrait ? y + outerH / 2 + i * (outerH + gap) : y + outerH / 2;
            this.drawPolaroid(l, images[i], cx, cy, width, tilts[i], captions?.[i] ?? defaults[i], true);
          }
        })(c),
      });
    }
    return { items, box, top: portrait && layout === "stack" && images.length > 0 };
  }

  private drawSlide(ctx: Ctx, seg: TimelineSegment, frame: number, bg?: string) {
    this.drawPaper(ctx, frame, bg);
    const { items, box, top } = this.slideItems(ctx, seg, frame);
    const total = items.reduce((n, item, i) => n + item.height + (item.marginBottom ?? 0) + (i ? box.gap : 0), 0);
    const room = this.t.height - box.paddingTop - box.paddingBottom;
    let y = box.paddingTop + (top ? 0 : (room - total) / 2);
    const placed = items.map((item) => {
      const at = y;
      y += item.height + (item.marginBottom ?? 0) + box.gap;
      return { item, at };
    });
    for (const { item, at } of placed) if (!item.onTop) item.draw(ctx, at);
    for (const { item, at } of placed) if (item.onTop) item.draw(ctx, at);
  }

  private drawMissing(ctx: Ctx, seg: TimelineSegment) {
    const { portrait } = this;
    const { width: W } = this.t;
    const { ink, accent } = this.colors;
    const desc = seg.visual.type === "slide" ? seg.visual.heading : seg.visual.description;
    this.drawPaper(ctx, 0);
    const padX = portrait ? 90 : 160;
    const headFont = `700 ${portrait ? 40 : 32}px ${BODY}`;
    const textFont = `${portrait ? 40 : 34}px ${BODY}`;
    const label = seg.visual.type === "material" ? "FOOTAGE TO RECORD" : "SHOT NOT CAPTURED";
    const head = this.block(ctx, headFont, label, Infinity);
    const body = this.block(ctx, textFont, desc ?? "", W - 2 * padX, 1.35);
    const top = portrait ? 340 : 120;
    ctx.save();
    ctx.letterSpacing = "4px";
    this.drawBlock(ctx, headFont, head, W / 2, top, "center", accent);
    ctx.letterSpacing = "0px";
    ctx.beginPath();
    ctx.rect(0, top + head.height + 24, W, portrait ? 700 : 520);
    ctx.clip();
    this.drawBlock(ctx, textFont, body, W / 2, top + head.height + 24, "center", ink);
    ctx.restore();
  }

  // ---------- bumpers ----------

  private drawBumper(ctx: Ctx, bumper: TimelineBumper, frame: number) {
    const draw = this.bumperDraw.get(bumper);
    if (!draw) return;
    const canvas = (this.bumperCanvas ??= this.platform.createCanvas(this.t.width, this.t.height));
    const c = canvas.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, canvas.width, canvas.height);
    draw(c, frame);
    ctx.drawImage(canvas, 0, 0, this.t.width, this.t.height);
  }
}

/** Canvas size of a video at a scale; even, because the video encoder needs that. */
export function outputSize(t: Pick<TimelineProps, "width" | "height">, scale: number) {
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(t.width), height: even(t.height) };
}

export { footageSeconds };
