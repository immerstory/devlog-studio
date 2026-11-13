import type { ActivitySource } from "./activity.js";
import type { StudioConfig } from "../server/config.js";
import type { ProjectArchetype } from "./archetypes.js";

export interface Source {
  id: string;
  label: string;
  path: string;
  contentGlobs: string[];
  /** Files read for their text, such as a daily news brief. Commits that change only these files leave the commit evidence. */
  feedGlobs?: string[];
  /** Rules that import committed images and videos as materials. The first rule that matches a file applies. */
  materialRules?: MaterialRule[];
  archived?: boolean;
}
/** Which committed files of a source become materials, and where their titles, tags and dates come from. */
export interface MaterialRule {
  id: string;
  /** Globs of the images and videos to import, such as *.png or shots/v1/*.webp. A glob without a slash matches the file name in any folder. */
  include: string[];
  exclude?: string[];
  /** Placeholders that take values from the path, such as {release}/{name}.{ext}. {name} gives the title, {group} the group, and the others give tags; {ext} and names that start with _ give nothing. */
  pattern?: string;
  /** Name of the JSON file in each folder that describes the folder and its files. Absent means DEFAULT_METADATA_FILE; empty reads none. */
  metadataFile?: string;
  /** Imports only files that the folder's metadata file lists. */
  listedOnly?: boolean;
  /** "inbox" keeps new files under Materials > From sources until the developer adds them. Absent means "materials". */
  importTo?: "materials" | "inbox";
}
export const DEFAULT_METADATA_FILE = "materials.json";

/** Keeps only valid material rules and their known fields, from settings or a request. */
export function readMaterialRules(input: unknown): MaterialRule[] {
  if (!Array.isArray(input)) return [];
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
  return input.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string").map((r) => ({
    id: r.id as string,
    include: strings(r.include),
    ...(strings(r.exclude).length ? { exclude: strings(r.exclude) } : {}),
    ...(typeof r.pattern === "string" && r.pattern.trim() ? { pattern: r.pattern.trim() } : {}),
    ...(typeof r.metadataFile === "string" ? { metadataFile: r.metadataFile.trim() } : {}),
    ...(r.listedOnly === true ? { listedOnly: true } : {}),
    ...(r.importTo === "inbox" ? { importTo: "inbox" as const } : {}),
  }));
}
export type FeedTopics = "briefing" | "story";
export type UnityTargetConfig = StudioConfig["unity"]["mcp"] & { projectPath: string };
/** `scene` keeps the engine the open file uses. */
export type BlenderRenderEngine = "scene" | "eevee" | "workbench" | "cycles";
export interface BlenderTargetConfig {
  /** Address of the MCP for Blender add-on's socket. Blender has to run on the same computer, because it writes the frames to disk. */
  host: string;
  port: number;
  /** Full path of the file that has to be open; empty accepts any file. */
  blendFile?: string;
  engine?: BlenderRenderEngine;
}
export interface BrowserTargetConfig {
  /** Paths in page shots resolve against this URL; shots can also use absolute URLs. */
  baseUrl: string;
  /** User agent the browser sends; empty uses Chrome's own for desktop shots and an iPhone Safari one for phone shots. */
  userAgent?: string;
  /** CSS added to every page this target films, before a shot's own CSS. */
  css?: string;
  /** Extra request headers as "Name: value" lines; absent means DEFAULT_PAGE_HEADERS, an empty list means none. */
  headers?: string[];
}

/** Privacy signals a normal privacy-minded browser sends: Do Not Track and Global Privacy Control. */
export const DEFAULT_PAGE_HEADERS = ["DNT: 1", "Sec-GPC: 1", "Accept-Language: en-US,en;q=0.9"];

/** Parses "Name: value" lines; lines without a name and a colon are skipped. */
export function parseHeaders(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    const name = i > 0 ? line.slice(0, i).trim() : "";
    if (name && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) out[name] = line.slice(i + 1).trim();
  }
  return out;
}
export type CaptureTarget =
  | { id: string; label: string; kind: "unity-mcp"; config: UnityTargetConfig }
  | { id: string; label: string; kind: "blender-mcp"; config: BlenderTargetConfig }
  | { id: string; label: string; kind: "browser"; config: BrowserTargetConfig };
/** An optional second voice for videos. */
export interface CoHostSettings {
  /** Turned off, new videos are solo and existing co-hosted scripts keep their voice. */
  enabled: boolean;
  name: string;
  /** Required, and different from the narration voice. */
  voiceId: string;
  /** Model and voice settings; absent values use the project's narration settings. */
  voice?: Partial<Omit<StudioConfig["elevenlabs"], "apiKey" | "voiceId">>;
  /** Caption color as #rrggbb. Developer captions stay white. */
  captionColor: string;
  /** Absent means the default persona. {name} stands for the co-host's name. */
  persona?: string;
  /** Share of spoken words the co-host may have, per format, from 0 to 1. */
  share: Record<"portrait" | "landscape", number>;
  /** Whether a new post's videos start co-hosted. */
  defaultOn: boolean;
  /** Whether every co-hosted video says that the co-host is an AI; otherwise only the project's first one does. */
  alwaysDisclose: boolean;
  /** Absent means the default line in the published description. {name} stands for the co-host's name. */
  disclosure?: string;
}
/** Refreshing activity always runs. The steps that call an agent run only when they are ticked. */
export interface IntakeSchedule {
  enabled: boolean;
  /** Local time of day, HH:MM. */
  time: string;
  propose: boolean;
  review: boolean;
  /** Propose news topics from new feed entries. */
  feeds?: boolean;
}
/** What the scheduler last did for a project. */
export interface IntakeState {
  /** Local date of the last time that was due. That day doesn't run again, even after a change of time. */
  day: string;
  startedAt?: string;
  finishedAt?: string;
  jobId?: string;
  status?: "running" | "done" | "failed";
  errors?: string[];
}
export interface ProjectSettings {
  name: string;
  publicTitle: string;
  description: string;
  archetype: ProjectArchetype;
  /** Absent means the default of the archetype. */
  promptGuidance?: string;
  sources: Source[];
  primarySourceId: string;
  discovery: { initialDays: number };
  captureTargets: CaptureTarget[];
  defaultCaptureTargetId?: string;
  narration: Omit<StudioConfig["elevenlabs"], "apiKey">;
  coHost?: CoHostSettings;
  /** Connected activity beyond the project's Git sources. All are off until the developer turns them on. */
  activitySources?: ActivitySource[];
  /** How a feed entry becomes suggestions: one briefing of its most relevant stories, or one suggestion per story. Absent means "briefing". */
  feedTopics?: FeedTopics;
  /** A daily run of the intake while the app runs. Off when absent. */
  intake?: IntakeSchedule;
  theme: StudioConfig["theme"];
  publishing: Omit<StudioConfig["youtube"], "clientId" | "clientSecret" | "refreshToken" | "channelTitle" | "statsIntervalHours"> & {
    attribution: string;
    connectionId?: string;
    /** A missed publish time up to this old still goes out after a restart; anything older asks first. */
    latenessHours?: number;
  };
  outputs: { enabled: Array<"portrait" | "landscape">; articleTemplate: string };
}
export interface DeletionManifest {
  files: boolean;
  garageKeys: string[];
  folders: string[];
  rowsDeleted?: boolean;
}
export interface Project {
  id: string;
  slug: string;
  createdAt: string;
  settings: ProjectSettings;
  deletion?: DeletionManifest;
}
export interface GlobalSettings {
  port: number;
  agent: StudioConfig["agent"];
  elevenlabs: { apiKey?: string };
  render: StudioConfig["render"];
  statsIntervalHours: number;
}
export interface YouTubeConnection {
  id: string;
  name: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  channelId?: string;
  channelTitle?: string;
}
export type PublicConnection = Omit<YouTubeConnection, "clientSecret" | "refreshToken"> & { clientSecretSet: boolean; connected: boolean };
export const ARTICLE_TEMPLATE = "---\ntitle: {{title}}\ndate: {{publishDate}}\ntags: {{tags}}\nsummary: {{summary}}\ncover: {{cover}}\n---\n\n{{body}}\n";
