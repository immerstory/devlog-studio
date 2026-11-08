import type { OutputId, ArticleDraft } from "./outputs.js";
import type { Framing } from "./framing.js";
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** A Unity camera pose in world space. Rotation is a Unity quaternion (x, y, z, w). */
export interface Pose {
  position: Vec3;
  rotation: Quat;
  fov: number;
}

export type MotionType = "still" | "orbit" | "push" | "pan" | "turn" | "rise";

/**
 * Camera move for editor shots.
 * - orbit: circles the target (degrees).
 * - push: moves toward the target (fraction of the distance).
 * - pan: slides sideways, keeping the view direction (metres).
 * - turn: swivels on the spot (degrees).
 * - rise: moves straight up (metres).
 * pan and turn are centred on the framed pose, which is their middle frame.
 */
export interface ShotMotion {
  type: MotionType;
  amount?: number;
}

export const MOTION_DEFAULTS: Record<MotionType, number> = { still: 0, orbit: 30, push: 0.25, pan: 3, turn: 20, rise: 3 };

export type Format = "portrait" | "landscape";
export const FORMATS: Format[] = ["portrait", "landscape"];
export const FORMAT_SIZE: Record<Format, { width: number; height: number }> = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

export type SuggestionStatus = "proposed" | "approved" | "dismissed" | "merged" | "used";
export type SuggestionKind = "feature" | "map" | "art" | "fix" | "tech" | "story" | "news" | "other";

/** New wording a session review proposes for a suggestion. It applies only when the developer accepts it. */
/** What the developer asks the agent to write. Ticked commits, notes and materials must end up in the draft. */
export interface StoryRequest {
  description: string;
  from: string;
  to: string;
  /** The suggestion to tell from a different angle. */
  retellId?: string;
  commits: string[];
  notes: string[];
  materialIds: string[];
}

/** A suggestion the agent wrote from a description. It changes nothing until the developer accepts it. */
export interface StoryDraft {
  id: string;
  createdAt: string;
  request: StoryRequest;
  suggestion: Pick<Suggestion, "workDate" | "title" | "hook" | "summary" | "whyItMatters" | "kind" | "appeal" | "recommendedFormat" | "sources" | "materialIds" | "suggestedShots" | "highlights">;
  /** Open suggestions this one can replace. Accepting marks the chosen ones as merged. */
  absorbs: Array<{ suggestionId: string; title: string; reason: string }>;
  /** Posts and suggestions in posts that overlap. They stay as they are. */
  related: Array<{ title: string; reason: string }>;
  leftOut: Array<{ item: string; reason: string }>;
  /** What the description implies and the evidence doesn't show. */
  unsupported: string[];
  /** `materialId` names the material that provides a shot. Without one, the shot must be captured. */
  shots: Array<{ description: string; materialId?: string }>;
}

/** A commit as the UI links it. `subject` and `message` are missing when no working copy holds the commit. */
export interface CommitInfo {
  ref: string;
  hash: string;
  subject?: string;
  message?: string;
  url?: string;
}

export interface ProposedEdit {
  hook: string;
  summary: string;
  whyItMatters: string;
  reason: string;
  createdAt: string;
}

export interface Suggestion {
  id: string;
  createdAt: string;
  /** Day the work happened (YYYY-MM-DD). */
  workDate: string;
  /** Planned publish day (YYYY-MM-DD). */
  publishDate?: string;
  title: string;
  hook: string;
  summary: string;
  whyItMatters: string;
  kind: SuggestionKind;
  /** Agent's 1–5 estimate of how interesting this is to an outside viewer. */
  appeal: number;
  recommendedFormat: "short" | "long" | "either";
  /** sessions and feeds: IDs of the session and feed records behind this topic. */
  sources: { commits: string[]; files: string[]; notes: string[]; sessions?: string[]; feeds?: string[] };
  /** A session review found this topic. */
  fromSessionReview?: boolean;
  /** Title of an existing suggestion that shares this one's commits. One large commit can hold several stories, so the developer decides. */
  possibleRepeatOf?: string;
  proposedEdit?: ProposedEdit;
  /** Materials (screenshots, videos) that belong to this topic. */
  materialIds: string[];
  suggestedShots: string[];
  /** What the developer wants emphasised. */
  highlights: string;
  status: SuggestionStatus;
  mergedFrom?: string[];
  postId?: string;
}

export interface Material {
  id: string;
  createdAt: string;
  /** Day the material shows (YYYY-MM-DD), which may be long before the upload. */
  date: string;
  kind: "image" | "video";
  fileName: string;
  contentType: string;
  size: number;
  /** Storage keys: original, 480 px thumbnail, 1280 px preview image. */
  key: string;
  thumbKey: string;
  previewKey: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** MP4 copy of an animated GIF, which videos play on a loop because a canvas only draws a GIF's first frame. */
  clipKey?: string;
  title: string;
  /** The developer's story behind the material: context, anecdotes, what changed since. */
  annotation: string;
  tags: string[];
  /** Group name. Materials with the same group belong together, for example a series of drafts shown as one polaroid stack. */
  group?: string;
  /** Set when an image generator made it; the video then credits it as generated. */
  generated?: { tool: "codex"; prompt: string };
}

export interface MaterialDeletion { deleted: true; warning?: string }

/** Trims a group name; an empty name means no group. */
export const normalizeGroup = (g: unknown): string | undefined => (typeof g === "string" && g.trim() ? g.trim() : undefined);

export interface Note {
  id: string;
  date: string;
  text: string;
  createdAt: string;
}

/** Time between two polaroids landing on a stack slide (video layout and minimum slide length). */
export const STACK_STAGGER_SECONDS = 0.55;
/** Most polaroids one stack slide shows. */
export const STACK_MAX_IMAGES = 12;

export interface SlideVisual {
  type: "slide";
  layout: "title" | "bullets" | "image" | "compare" | "stack" | "outro";
  heading: string;
  bullets?: string[];
  /** Segment or material ids whose image this slide shows: one for image, two for compare, any number for stack. */
  imageFrom?: string[];
  /** How stack polaroids arrive: dropping from the top or sliding in from alternating sides. */
  entrance?: "drop" | "slide";
  /** Caption under a picture, by image id, so it moves with the image when the order changes. */
  captions?: Record<string, string>;
  /** Who said or published what the slide shows, such as "Outlet · Author"; shown along the bottom edge. */
  credit?: string;
  /** Stack only: pictures without their own caption show their image title. */
  titleCaptions?: boolean;
}

/** Captions compare slides show when an image has none of its own, by position. */
export const COMPARE_CAPTIONS = ["Before", "After"];

export interface SceneShot {
  model: "scene";
  /** Hierarchy path or object name to frame. */
  target?: string;
  /** Explicit pose; wins over `target` framing. */
  pose?: Pose;
  /** Vertical field of view in degrees at the start of the shot; automatic when absent (see autoFov). */
  fov?: number;
  /** Vertical field of view at the end: the lens zooms from fov to fovEnd during the shot. Same as the start when absent. */
  fovEnd?: number;
  /** Orbit and push centre for an explicit pose: in Unity the first surface in the middle of the Scene view when the pose was taken, else 20 m ahead; in Blender the 3D cursor. */
  pivot?: Vec3;
  /** Name of the object the pivot lies on; absent when the view's middle hit nothing. */
  pivotObject?: string;
  angle?: ShotAngle;
  distance?: ShotDistance;
  motion: ShotMotion;
  /** Blender only: plays the file's timeline during the shot, repeating it when the shot is longer. */
  playTimeline?: boolean;
}

export const FOV_RANGE = { min: 5, max: 100 };

/** Lens of target-framed shots; portrait uses a wider vertical angle to show a similar scene width. */
export const FRAMING_FOV: Record<Format, number> = { landscape: 40, portrait: 52 };

/**
 * Field of view a shot uses when it sets none: the Scene view's, widened for portrait, or the framing lens.
 * Target framing may widen it further when walls force the camera closer.
 */
export function autoFov(format: Format, poseFov?: number) {
  if (poseFov === undefined) return FRAMING_FOV[format];
  return format === "portrait" ? Math.min(poseFov * 1.3, 80) : poseFov;
}

export type ShotAngle = "front" | "three-quarter" | "side" | "high" | "top" | "low";
export type ShotDistance = "close" | "medium" | "wide";

/** Camera yaw relative to the target's facing (180 = looking at its front) and pitch (positive looks down). */
export const ANGLE_FRAMING: Record<ShotAngle, { yawOffset: number; pitch: number }> = {
  front: { yawOffset: 180, pitch: 8 },
  "three-quarter": { yawOffset: 215, pitch: 15 },
  side: { yawOffset: 270, pitch: 10 },
  high: { yawOffset: 205, pitch: 38 },
  top: { yawOffset: 180, pitch: 75 },
  low: { yawOffset: 200, pitch: -6 },
};
export const DISTANCE_PADDING: Record<ShotDistance, number> = { close: 0.75, medium: 1.15, wide: 1.9 };

/** An uploaded screenshot or video; without materialId it describes footage still to be recorded. */
export interface MaterialVisual {
  type: "material";
  description: string;
  materialId?: string;
  trimStart?: number;
  /** What part of the material fills the screen at the start and end; the format's default when absent. */
  framing?: Framing;
}

export type PageDevice = "desktop" | "phone";
/** Phone for Shorts, desktop for landscape videos. */
export const defaultPageDevice = (format: Format): PageDevice => (format === "portrait" ? "phone" : "desktop");

/** A webpage filmed in a browser: it scrolls and zooms from a start to an end state across the segment. */
export interface PageShot {
  model: "page";
  /** Absolute URL, or a path resolved against the capture target's base URL. */
  url: string;
  /** Browser viewport the page is shown in; the format's default when absent. */
  device?: PageDevice;
  /** Scroll position at the start and the end: CSS pixels from the top, or a CSS selector brought to the top of the view. */
  scrollFrom: number | string;
  scrollTo: number | string;
  /** Zoom at the start and the end; 1 shows the whole viewport. */
  zoomFrom: number;
  zoomTo: number;
  /** Point the zoom closes in on, as fractions of the viewport; 0.5, 0.5 is the middle. */
  focus: { x: number; y: number };
  /** Milliseconds the page plays after loading before the first frame, for intro animations. */
  settleMs?: number;
  /** CSS selectors hidden before filming, such as cookie banners. */
  hide?: string[];
  /** CSS added to the page after it loads, after the capture target's CSS. */
  css?: string;
  /** JavaScript run in the page after its CSS, before the page settles, for example to start a video the site won't play by itself. */
  script?: string;
  /** Seconds the page holds still before scrolling and zooming start. */
  delaySeconds?: number;
  /** Average scroll speed in CSS pixels per second; absent spreads the move over the rest of the shot. */
  scrollSpeed?: number;
  /** Smooth starts and stops the move gently; linear moves at a constant speed. */
  easing?: "smooth" | "linear";
  /** Who published the page, such as "Outlet · Author", shown with the link. A credit makes this a source shot. */
  credit?: string;
  /** Text the page must show, such as an article's headline. Capture fails without it, so a moved article isn't filmed. */
  expect?: string;
  /** Leaves out the credit and link the video shows at the bottom of the shot. */
  hideLink?: boolean;
  /** A sentence the page shows. The page holds still on it and marks it word by word, instead of scrolling. */
  highlight?: string;
  /** Films the page frame by frame even without a move, so its videos and animations play; otherwise such a shot is one still. */
  play?: boolean;
  /**
   * Films on the page's own clock instead of the exact frame clock, so streamed videos play. A frame the browser can't
   * deliver in time repeats the one before, so motion may stutter.
   */
  realtime?: boolean;
}

/** What a page showed when it was opened. A failed check names its problem. */
export interface PageCheck {
  url: string;
  checkedAt: string;
  ok: boolean;
  status?: number;
  /** The address after redirects, when it differs. */
  finalUrl?: string;
  title?: string;
  expect?: string;
  found?: boolean;
  /** The sentence the shot highlights, checked like the expected text. */
  highlight?: string;
  problem?: string;
}

/**
 * Progress of a page shot's move, 0 to 1, at `seconds` into a shot of `shotSeconds`. The move starts after
 * the delay and lasts distance / speed seconds, or until the end of the shot without a speed.
 */
export function pageMoveProgress(shot: Pick<PageShot, "delaySeconds" | "scrollSpeed" | "easing">, seconds: number, shotSeconds: number, distance: number): number {
  const start = Math.min(Math.max(0, shot.delaySeconds ?? 0), shotSeconds);
  const length = shot.scrollSpeed && shot.scrollSpeed > 0 && distance > 0 ? distance / shot.scrollSpeed : shotSeconds - start;
  if (length <= 0) return seconds >= start ? 1 : 0;
  const u = Math.min(1, Math.max(0, (seconds - start) / length));
  return shot.easing === "linear" ? u : u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
}

export const newPageShot = (url = ""): PageShot => ({ model: "page", url, scrollFrom: 0, scrollTo: 0, zoomFrom: 1, zoomTo: 1, focus: { x: 0.5, y: 0.5 } });

/** A page shot without scrolling or zooming is a single still frame. */
/** A shot films more than one frame when it scrolls, zooms, highlights a sentence or plays the page. */
export const pageShotMoves = (s: PageShot) => String(s.scrollFrom) !== String(s.scrollTo) || s.zoomFrom !== s.zoomTo || !!s.highlight?.trim() || !!s.play || !!s.realtime;
export interface CaptureVisual {
  type: "capture";
  targetId?: string;
  description: string;
  shot: SceneShot | PageShot;
}
export type Visual = SlideVisual | CaptureVisual | MaterialVisual;

export type Speaker = "developer" | "coHost";

/** One spoken line of a co-hosted segment. */
export interface Turn {
  id: string;
  speaker: Speaker;
  text: string;
  /** Text as the agent wrote it, for the restore action. */
  agentText?: string;
}

/** The result of checking a co-hosted script's claims. Written only by the server. */
export interface Verification {
  /** Hash of everything the check read. */
  fingerprint: string;
  /** Hash of the spoken script alone. */
  scriptFingerprint: string;
  checkedAt: string;
  flags: Array<{ key: string; turnId: string; claim: string; reason: string }>;
  /** Keys of the flags the developer chose to keep. */
  accepted: string[];
}
export type VerificationState = "current" | "flagged" | "outOfDate";

export interface Segment {
  id: string;
  /** Empty in co-hosted segments, which speak through turns. */
  narration: string;
  /** Present only in co-hosted scripts. Read speech through spokenTurns. */
  turns?: Turn[];
  /** Short on-screen label shown over footage. */
  onScreen?: string;
  /** Narration as the agent wrote it (after its read-through); differs from narration once edited. */
  agentNarration?: string;
  visual: Visual;
  /** Storage key of the captured media per format. */
  media?: Partial<Record<Format, string>>;
  /** Duration of video media per format, in seconds. */
  mediaSeconds?: Partial<Record<Format, number>>;
  /** Epoch ms of the latest capture; busts the browser cache for thumbnails. */
  capturedAt?: number;
  captureError?: string;
  /** Recent captures per format, oldest first; the last one is the current media. */
  takes?: Partial<Record<Format, CaptureTake[]>>;
}

/** One capture of a segment: its media and the visual settings that produced it. */
export interface CaptureTake {
  media: string;
  mediaSeconds?: number;
  capturedAt: number;
  /** Absent for a capture made before takes were kept. */
  visual?: Visual;
}

/** Captures kept per segment and format; older ones are deleted. */
export const MAX_TAKES = 5;

export interface Script {
  format: Format;
  title: string;
  /** The agent run (runs table) that wrote this script, with prompt, raw output and review edits. */
  runId?: string;
  segments: Segment[];
  metadata: { title: string; description: string; tags: string[] };
  /** Present once a co-hosted script has been checked. */
  verification?: Verification;
}

export interface Question {
  id: string;
  question: string;
  why?: string;
  answer: string;
}

export type PostStage = "questions" | "script" | "capture" | "preview" | "narrated" | "final";

export interface NarrationTake {
  /** The segment that holds the line. */
  segmentId: string;
  /** Present for a turn of a co-hosted segment. */
  turnId?: string;
  speaker?: Speaker;
  file: string;
  durationMs: number;
  words: Array<{ text: string; startMs: number; endMs: number }>;
  hash: string;
  /** Epoch ms when ElevenLabs produced this take; changes on forced regeneration. */
  generatedAt?: number;
}

/** What gets published for a format: rendered at the final render, approved as a whole. */
export interface PublishPackage {
  title: string;
  description: string;
  tags: string[];
}

/** A post's status for the Posts page. */
export interface PostOverview {
  id: string;
  title: string;
  stage: PostStage;
  outputs: OutputId[];
  publishDate?: string;
  createdAt: string;
  topics: number;
  destinations: Array<{ id: string; connector: string; name: string; state: string; url?: string }>;
  /** Why this post needs the developer, in words. */
  attention: string[];
}

/** One reading of a published item. A platform reports only some of these. */
export interface StatPoint {
  t: string;
  views?: number;
  likes?: number;
  comments?: number;
  reposts?: number;
}
/** Anything published, in the shape the Statistics page shows for every platform. */
export interface StatItem {
  id: string;
  postId: string;
  title: string;
  /** Which platform, for its icon and for filtering. */
  connector: string;
  /** The platform's name, with the kind of post where a platform has several. */
  platform: string;
  url?: string;
  publishedAt?: string;
  status?: string;
  series: StatPoint[];
}

export interface YouTubeUpload {
  connectionId?: string;
  videoId?: string;
  url?: string;
  status: "uploading" | "uploaded" | "scheduled" | "failed";
  /** ISO time the video goes public; absent when it was published on upload. */
  publishAt?: string;
  privacy?: "public" | "unlisted" | "private";
  uploadedAt?: string;
  /** When YouTube published it (from the API); set by the statistics refresh. */
  publishedAt?: string;
  captions?: boolean;
  error?: string;
}

export interface RenderInfo {
  connectionId?: string;
  draft?: string;
  final?: string;
  srt?: string;
  meta?: string;
  /** Title, description (with chapters, hashtags and attribution) and tags of the final render. */
  package?: PublishPackage;
  /** The spoken script this co-hosted final render was made from. */
  scriptFingerprint?: string;
  /** ISO time of the final OK for this render. A new final render clears it. */
  approvedAt?: string;
}

export interface Post {
  outputDirs: string[];
  id: string;
  title: string;
  createdAt: string;
  publishDate?: string;
  suggestionIds: string[];
  /** Materials attached to the episode in addition to its suggestions' materials. */
  materialIds: string[];
  outputs: OutputId[];
  outputStages: Partial<Record<Format, PostStage>>;
  article?: { draft?: ArticleDraft; export?: { files: string[] }; stage: "draft" | "images" | "export" };
  /** Extra direction for the agent. */
  brief: string;
  questions: Question[];
  scripts: Partial<Record<Format, Script>>;
  narration: Partial<Record<Format, NarrationTake[]>>;
  /** draft: storage key. final, srt, meta: local paths in the output folder. */
  renders: Partial<Record<Format, RenderInfo>>;
  /** Time of day (HH:MM, local) to publish on publishDate; the YouTube default applies when unset. */
  publishTime?: string;
  stage: PostStage;
  /** Per video format; absent means solo. */
  presentation?: Partial<Record<Format, Presentation>>;
}

export type Presentation = "solo" | "coHost";

// ---------- render timeline ----------

export interface Caption {
  text: string;
  startMs: number;
  endMs: number;
  /** CSS color; absent means white. */
  color?: string;
  /** First caption after another speaker's line. */
  speakerChange?: boolean;
}

export interface AudioClip {
  src: string;
  /** Frames after the segment's speech starts. */
  startFrame: number;
}

export interface TimelineSegment {
  id: string;
  from: number;
  durationInFrames: number;
  onScreen?: string;
  visual: Visual;
  /** Resolved URLs for the visual. */
  /** poster: still shown behind a video, covering the time after footage ends. */
  /** size and framing: a material's pixel size and the frames to ease between; absent for captured editor shots. */
  media?: { src: string; kind: "image" | "video"; trimStartFrames?: number; playbackRate?: number; /** Repeats the footage for as long as the segment lasts. */ loop?: boolean; poster?: string; size?: { width: number; height: number }; framing?: Framing };
  slideImages?: string[];
  /** Caption under each slide image, aligned with slideImages; empty for none. */
  slideCaptions?: string[];
  /** Frames between two polaroids landing on a stack slide, spread across the narration. */
  stackStaggerFrames?: number;
  audio?: AudioClip[];
  /** Frames the narration and the on-screen label wait, because the intro plays over the segment first. */
  introFrames?: number;
  /** The source a segment shows: a webpage shot's page with its credit, or a slide's credit alone. */
  source?: { url?: string; credit?: string };
}

/** Slide palette. Hex colours as #rrggbb, because the slides append alpha digits to them. */
export interface ThemeColors {
  /** Slide background. */
  paper: string;
  /** Highlight at the top left of the background gradient. */
  paperLight: string;
  /** Edge of the background gradient. */
  paperShade: string;
  /** Wash along the bottom of slides and over blurred background images. */
  wash: string;
  /** Text. */
  ink: string;
  /** Bullet marks and notices. */
  accent: string;
  /** Frame of photo prints. */
  polaroid: string;
}

export const DEFAULT_THEME_COLORS: ThemeColors = {
  paper: "#f2ebdc",
  paperLight: "#fbf6ea",
  paperShade: "#e4dac4",
  wash: "#6f97b8",
  ink: "#211f1b",
  accent: "#e2673a",
  polaroid: "#fbf8f1",
};

export const THEME_COLOR_LABELS: Record<keyof ThemeColors, string> = {
  paper: "Background",
  paperLight: "Background highlight",
  paperShade: "Background edge",
  wash: "Wash",
  ink: "Text",
  accent: "Accent",
  polaroid: "Photo frame",
};

/** Fills missing or malformed colours from the defaults. */
export function themeColors(colors?: Partial<ThemeColors>): ThemeColors {
  const out = { ...DEFAULT_THEME_COLORS };
  for (const key of Object.keys(out) as Array<keyof ThemeColors>) {
    const value = colors?.[key];
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) out[key] = value.toLowerCase();
  }
  return out;
}

export interface Theme {
  gameTitle: string;
  colors: ThemeColors;
  logoUrl?: string;
  fontUrl?: string;
  backgrounds: string[];
  /** False leaves the subtitles out while a title slide shows, whose heading carries the point. */
  subtitlesOnTitleSlides?: boolean;
  /** Title outro over the last segment; its frames are part of the last segment's duration. */
  /** Bumpers over the first and last segment; their frames are part of those segments' durations. */
  intro?: TimelineBumper;
  outro?: TimelineBumper;
}

/** A bumper as the video plays it: font parameters resolved to URLs. */
export interface TimelineBumper {
  style: string;
  params: Record<string, unknown>;
  durationInFrames: number;
  audioUrl?: string;
  audioLeadSeconds?: number;
}

export interface TimelineProps {
  [key: string]: unknown;
  format: Format;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  theme: Theme;
  segments: TimelineSegment[];
  captions: Caption[];
  narrated: boolean;
}
