import { projectId } from "./context.js";
import fs from "node:fs";
import { config } from "./config.js";
import { getMaterials } from "./store.js";
import { withClip } from "./materials.js";
import { bumperParams, bumperSeconds, bumperStyle, type BumperChoice, type ThemeAsset } from "../shared/bumpers.js";
import { STACK_STAGGER_SECONDS, themeColors } from "../shared/types.js";
import { defaultFraming } from "../shared/framing.js";
import { spokenTurns } from "../shared/turns.js";
import { getProject } from "./projects.js";
import { projectVoices, usableTakes } from "./takes.js";
import { pageUrl } from "./capture/browser/index.js";
import { COMPARE_CAPTIONS, FORMAT_SIZE, type AudioClip, type Caption, type Post, type Format, type Material, type NarrationTake, type Segment, type TimelineBumper, type TimelineProps, type TimelineSegment, type Turn } from "../shared/types.js";

const WORDS_PER_PAGE: Record<Format, number> = { portrait: 3, landscape: 7 };
const MIN_SECONDS = { slide: 2.6, capture: 2.4, material: 2.4 };
const AUDIO_LEAD_MS = 150;
const SEGMENT_TAIL_MS = 350;
const GAP_SAME_SPEAKER_MS = 150;
const GAP_NEW_SPEAKER_MS = 300;
/** Share of a stack slide's narration after which the last polaroid lands. */
const STACK_SPREAD = 0.8;

/**
 * Frames between polaroid arrivals: the pile grows with the narration, the last one landing at STACK_SPREAD
 * of the speech, but never faster than STACK_STAGGER_SECONDS.
 */
export function stackStagger(count: number, speechMs: number, fps: number) {
  const min = Math.round(STACK_STAGGER_SECONDS * fps);
  if (count < 2 || !speechMs) return min;
  return Math.max(min, Math.round(((speechMs * STACK_SPREAD) / 1000) * fps / (count - 1)));
}

export const baseUrl = () => `http://localhost:${config().port}`;
/** URL of a Garage object served by this app. */
export const mediaUrl = (key: string) => `${baseUrl()}/media/${key.split("/").map(encodeURIComponent).join("/")}`;

/** Estimated timing for an unnarrated preview, close to typical TTS pacing (~150 wpm). */
export function estimateWords(text: string): NarrationTake["words"] {
  const words: NarrationTake["words"] = [];
  let t = 0;
  for (const w of text.trim().split(/\s+/).filter(Boolean)) {
    const len = Math.min(170 + w.replace(/[^\p{L}\p{N}]/gu, "").length * 42, 800);
    words.push({ text: w, startMs: t, endMs: t + len });
    t += len + (/[.!?]$/.test(w) ? 320 : /[,;:—]$/.test(w) ? 160 : 40);
  }
  return words;
}

const turnGapMs = (turns: Turn[], i: number) => (i === 0 ? 0 : turns[i].speaker === turns[i - 1].speaker ? GAP_SAME_SPEAKER_MS : GAP_NEW_SPEAKER_MS);

/** Estimated speech length of a segment before narration exists. */
export function estimatedSpeechMs(seg: Segment): number {
  const turns = spokenTurns(seg);
  return turns.reduce((n, turn, i) => n + turnGapMs(turns, i) + (estimateWords(turn.text).at(-1)?.endMs ?? 0), 0);
}

/**
 * The words a caption shows: bracketed ElevenLabs expressions such as [laughs] or [laughs harder] are spoken
 * direction, not text. Punctuation directly after an expression moves to the word before it, and an unclosed
 * bracket stays as written.
 */
export function captionWords(words: NarrationTake["words"]): NarrationTake["words"] {
  const hidden = "\0";
  const masked = words.map((w) => w.text).join(" ").replace(/\[[^[\]]*\]/g, (tag) => hidden.repeat(tag.length));
  const out: NarrationTake["words"] = [];
  let at = 0;
  for (const word of words) {
    const part = masked.slice(at, at + word.text.length);
    at += word.text.length + 1;
    const text = part.replaceAll(hidden, "");
    if (!part.includes(hidden) || /[\p{L}\p{N}]/u.test(text)) {
      if (text) out.push({ ...word, text });
    } else if (text && out.length) {
      out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text + text };
    }
  }
  return out;
}

function pages(words: NarrationTake["words"], offsetMs: number, perPage: number): Caption[] {
  const out: Caption[] = [];
  let cur: NarrationTake["words"] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ text: cur.map((w) => w.text).join(" "), startMs: cur[0].startMs + offsetMs, endMs: cur.at(-1)!.endMs + offsetMs });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (cur.length >= perPage || /[.!?,;:]$/.test(w.text)) flush();
  }
  flush();
  // Close gaps so captions do not flicker between pages of one sentence.
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].startMs - out[i].endMs < 250) out[i].endMs = out[i + 1].startMs;
  return out;
}

/** Bumper parameters as the video uses them: font uploads become URLs. */
function timelineBumper(choice: BumperChoice | undefined, fps: number): TimelineBumper | undefined {
  const params = bumperParams(choice);
  const seconds = bumperSeconds(choice);
  if (!choice || !params || !seconds) return undefined;
  const style = bumperStyle(choice.style)!;
  for (const p of style.params) if (p.type === "font") params[p.key] = assetUrl(params[p.key] as ThemeAsset | undefined);
  return { style: choice.style, params, durationInFrames: Math.round(seconds * fps), audioUrl: choice.audio ? mediaUrl(choice.audio.key) : undefined, audioLeadSeconds: choice.audio?.leadSeconds };
}

const assetUrl = (asset?: ThemeAsset) => (asset?.key ? mediaUrl(asset.key) : undefined);

export async function themeAssets(t = config().theme) {
  const backgrounds = (await getMaterials(projectId(), t.backgroundMaterialIds ?? [])).filter((m) => m.kind === "image");
  return {
    gameTitle: config().gameTitle,
    colors: themeColors(t.colors),
    logoUrl: assetUrl(t.logo),
    fontUrl: assetUrl(t.displayFont),
    backgrounds: backgrounds.map((m) => mediaUrl(m.previewKey)),
    ...(t.subtitlesOnTitleSlides === false ? { subtitlesOnTitleSlides: false } : {}),
  };
}

const isVideoKey = (key: string) => /\.(mp4|mov|webm|mkv)$/i.test(key);

function segmentMedia(seg: Segment, format: Format, materials: Map<string, Material>) {
  if (seg.visual.type === "material") {
    const m = seg.visual.materialId ? materials.get(seg.visual.materialId) : undefined;
    if (!m) return undefined;
    const size = m.width && m.height ? { width: m.width, height: m.height } : undefined;
    if (m.clipKey) return { src: mediaUrl(m.clipKey), kind: "video" as const, loop: true, seconds: m.durationSeconds ?? 0, trim: 0, poster: mediaUrl(m.previewKey), size, framing: size ? seg.visual.framing ?? defaultFraming(m.kind) : undefined };
    return { src: mediaUrl(m.key), kind: m.kind, seconds: m.durationSeconds ?? 0, trim: seg.visual.trimStart ?? 0, poster: mediaUrl(m.previewKey), size, framing: size ? seg.visual.framing ?? defaultFraming(m.kind) : undefined };
  }
  // A slide draws itself; footage it kept from an earlier visual never shows.
  if (seg.visual.type === "slide") return undefined;
  const key = seg.media?.[format];
  if (!key) return undefined;
  const video = isVideoKey(key);
  return { src: mediaUrl(key), kind: video ? ("video" as const) : ("image" as const), seconds: video ? seg.mediaSeconds?.[format] ?? 0 : 0, trim: 0, poster: video ? mediaUrl(key.replace(/\.\w+$/, ".jpg")) : undefined };
}

/** A still image for slides: "seg-…" ids refer to segments, "mat-…" ids to materials. */
function stillFor(id: string, segments: Segment[], format: Format, materials: Map<string, Material>): string | undefined {
  const m = materials.get(id);
  if (m) return mediaUrl(m.previewKey);
  const seg = segments.find((s) => s.id === id);
  if (!seg) return undefined;
  if (seg.visual.type === "material") {
    const sm = seg.visual.materialId ? materials.get(seg.visual.materialId) : undefined;
    return sm ? mediaUrl(sm.previewKey) : undefined;
  }
  const key = seg.media?.[format];
  if (!key) return undefined;
  return mediaUrl(isVideoKey(key) ? key.replace(/\.\w+$/, ".jpg") : key);
}

/** The title of a slide image: the material's title, or a segment's on-screen label or description. */
function titleFor(id: string, segments: Segment[], materials: Map<string, Material>): string {
  const m = materials.get(id);
  if (m) return m.title;
  const seg = segments.find((s) => s.id === id);
  if (!seg) return "";
  if (seg.visual.type === "material") return (seg.visual.materialId && materials.get(seg.visual.materialId)?.title) || seg.onScreen || "";
  return seg.onScreen || (seg.visual.type === "capture" ? seg.visual.description : "");
}

/** Ids of all materials a script refers to. */
export function scriptMaterialIds(segments: Segment[]): string[] {
  const ids = new Set<string>();
  for (const s of segments) {
    if (s.visual.type === "material" && s.visual.materialId) ids.add(s.visual.materialId);
    if (s.visual.type === "slide") for (const id of s.visual.imageFrom ?? []) if (id.startsWith("mat-")) ids.add(id);
  }
  return [...ids];
}

/** `theme` replaces the saved theme, for previews of unsaved settings. */
/** The credit of a material an image generator made, so the video never passes it off as footage. */
export const GENERATED_CREDIT = "AI-generated image";
function generatedCredit(visual: Segment["visual"], materials: Map<string, Material>): TimelineSegment["source"] {
  const material = visual.type === "material" && visual.materialId ? materials.get(visual.materialId) : undefined;
  return material?.generated ? { credit: GENERATED_CREDIT } : undefined;
}

/** The source a segment shows: a slide's credit, or the page a webpage shot films, resolved against its target's base URL, unless the shot leaves the link out. */
export function pageSource(visual: Segment["visual"]): TimelineSegment["source"] {
  if (visual.type === "slide") return visual.credit?.trim() ? { credit: visual.credit.trim() } : undefined;
  if (visual.type !== "capture" || visual.shot?.model !== "page" || visual.shot.hideLink || !visual.shot.url?.trim()) return undefined;
  const settings = getProject().settings;
  const target = settings.captureTargets.find((t) => t.id === (visual.targetId ?? settings.defaultCaptureTargetId));
  let url = visual.shot.url.trim();
  try { if (target?.kind === "browser") url = pageUrl(target.config, url); } catch { /* An invalid address is shown as entered; capture reports it. */ }
  const credit = visual.shot.credit?.trim();
  return { url, ...(credit ? { credit } : {}) };
}

export async function buildTimeline(ep: Post, format: Format, narrated: boolean, theme = config().theme): Promise<TimelineProps> {
  const script = ep.scripts[format];
  if (!script) throw new Error(`No ${format} script yet`);
  const fps = config().render.fps;
  const materials = new Map((await Promise.all((await getMaterials(projectId(), scriptMaterialIds(script.segments))).map(withClip))).map((m) => [m.id, m]));
  const takes = new Map(usableTakes(ep.narration[format] ?? [], script.segments, projectVoices()).map((t) => [t.turnId ?? t.segmentId, t]));
  const coHostColor = getProject().settings.coHost?.captionColor;
  const assets = await themeAssets(theme);
  const intro = timelineBumper(theme.intro, fps);
  const outro = timelineBumper(theme.outro, fps);
  const introMs = intro ? (intro.durationInFrames / fps) * 1000 : 0;
  const outroMs = outro ? (outro.durationInFrames / fps) * 1000 : 0;
  if (narrated) {
    const missing = script.segments.flatMap(spokenTurns).filter((t) => !takes.has(t.id));
    if (missing.length) throw new Error(`Narration missing for ${missing.length} line(s); generate narration first.`);
  }

  const segments: TimelineSegment[] = [];
  const captions: Caption[] = [];
  let cursorMs = 0;
  let lastSpeaker: Turn["speaker"] | undefined;

  script.segments.forEach((seg, idx) => {
    const turns = spokenTurns(seg);
    const lines = turns.map((turn) => {
      const take = narrated ? takes.get(turn.id) : undefined;
      const words = take ? take.words : estimateWords(turn.text);
      return { turn, take, words, speechMs: take ? take.durationMs : words.at(-1)?.endMs ?? 0, atMs: 0 };
    });
    let speechMs = 0;
    lines.forEach((line, i) => {
      line.atMs = speechMs + turnGapMs(turns, i);
      speechMs = line.atMs + line.speechMs;
    });
    const stackCount = seg.visual.type === "slide" && seg.visual.layout === "stack" ? seg.visual.imageFrom?.length ?? 0 : 0;
    const minMs = Math.max((MIN_SECONDS[seg.visual.type] ?? 2.4) * 1000, stackCount ? (1.6 + STACK_STAGGER_SECONDS * stackCount) * 1000 : 0);
    const isLast = idx === script.segments.length - 1;
    // The first visual carries the intro before its narration starts.
    const startMs = idx === 0 ? introMs : 0;
    // The last visual holds on after the narration: a short beat, or the whole outro.
    const endMs = isLast ? (outroMs ? outroMs : 900) : 0;
    const durMs = startMs + Math.max(minMs, speechMs ? AUDIO_LEAD_MS + speechMs + SEGMENT_TAIL_MS : minMs) + endMs;
    const from = Math.round((cursorMs / 1000) * fps);
    const durationInFrames = Math.max(1, Math.round(((cursorMs + durMs) / 1000) * fps) - from);

    const media = segmentMedia(seg, format, materials);
    let resolved: TimelineSegment["media"];
    if (media) {
      resolved = { src: media.src, kind: media.kind, poster: media.poster };
      if ("size" in media && media.size && media.framing) Object.assign(resolved, { size: media.size, framing: media.framing });
      if ("loop" in media && media.loop) resolved.loop = true;
      else if (media.kind === "video") {
        const segSeconds = durationInFrames / fps;
        const available = Math.max(0.1, media.seconds - media.trim);
        // Camera moves stretch or compress to fill the segment; recorded footage only slows down slightly
        // when it is too short, and its preview frame covers any remainder.
        resolved.playbackRate = seg.visual.type === "capture" ? Math.min(2, Math.max(0.5, available / segSeconds)) : Math.min(1, Math.max(0.75, available / segSeconds));
        resolved.trimStartFrames = Math.round(media.trim * fps);
      }
    }
    let slideImages: string[] | undefined;
    let slideCaptions: string[] | undefined;
    if (seg.visual.type === "slide" && seg.visual.imageFrom?.length) {
      const v = seg.visual;
      const shown = v.imageFrom!.map((id) => ({ id, src: stillFor(id, script.segments, format, materials) })).filter((x): x is { id: string; src: string } => !!x.src);
      slideImages = shown.map((x) => x.src);
      slideCaptions = shown.map(({ id }, k) => {
        const own = v.captions?.[id]?.trim();
        if (own) return own;
        if (v.layout === "compare") return COMPARE_CAPTIONS[k] ?? "";
        if (v.layout === "stack" && v.titleCaptions) return titleFor(id, script.segments, materials);
        return "";
      });
    }

    const audio: AudioClip[] = lines.flatMap(({ take, atMs }) => (take ? [{ src: `${mediaUrl(take.file)}?v=${take.generatedAt ?? 0}`, startFrame: Math.round((atMs / 1000) * fps) }] : []));
    segments.push({
      id: seg.id,
      from,
      durationInFrames,
      onScreen: seg.onScreen || undefined,
      visual: seg.visual,
      media: resolved,
      slideImages,
      slideCaptions,
      stackStaggerFrames: stackCount ? stackStagger(stackCount, speechMs, fps) : undefined,
      audio: audio.length ? audio : undefined,
      introFrames: startMs ? Math.round((startMs / 1000) * fps) : undefined,
      source: pageSource(seg.visual) ?? generatedCredit(seg.visual, materials),
    });
    for (const { turn, words, atMs } of lines) {
      const visible = captionWords(words);
      if (!visible.length) continue;
      const shown = pages(visible, cursorMs + startMs + AUDIO_LEAD_MS + atMs, WORDS_PER_PAGE[format]);
      if (lastSpeaker && lastSpeaker !== turn.speaker) shown[0].speakerChange = true;
      if (turn.speaker === "coHost" && coHostColor) for (const page of shown) page.color = coHostColor;
      lastSpeaker = turn.speaker;
      captions.push(...shown);
    }
    cursorMs += durMs;
  });

  const durationInFrames = segments.reduce((n, s) => Math.max(n, s.from + s.durationInFrames), 1);
  const { width, height } = FORMAT_SIZE[format];
  return { format, fps, width, height, durationInFrames, theme: { ...assets, intro, outro }, segments, captions, narrated };
}

const srtTime = (ms: number) => {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

export function toSrt(captions: Caption[]): string {
  return captions.map((c, i) => `${i + 1}\n${srtTime(Math.round(c.startMs))} --> ${srtTime(Math.round(c.endMs))}\n${c.speakerChange ? ">> " : ""}${c.text}\n`).join("\n");
}

/** YouTube chapters from heading slides; requires the first chapter at 0:00. */
export function chapters(t: TimelineProps): string[] {
  const fmt = (frames: number) => {
    const s = Math.floor(frames / t.fps);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const out = t.segments
    .filter((s) => s.visual.type === "slide" && (s.visual.layout === "title" || s.visual.layout === "bullets") && s.visual.heading)
    .map((s) => ({ at: s.from, label: s.visual.type === "slide" ? s.visual.heading : "" }));
  if (!out.length) return [];
  if (out[0].at > 0) out.unshift({ at: 0, label: "Intro" });
  return out.length >= 3 ? out.map((c) => `${fmt(c.at)} ${c.label}`) : [];
}
