import type { CaptureTarget, GlobalSettings } from "../shared/projects.js";
import { currentContext } from "./context.js";
import { getProject, getConnection, findConnection, saveProject } from "./projects.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { query } from "./db.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export type AgentKind = "claude" | "codex";

export interface StudioConfig {
  port: number;
  /** Public project title used in slides and bumpers. */
  gameTitle: string;
  unity: {
    projectPath: string;
    mcp: { url: string; headerHelper: string; headerHelperArgs: string[] };
  };
  agent: {
    default: AgentKind;
    claude: { executable: string; model?: string };
    codex: { executable: string; args: string[]; model?: string };
    timeoutMinutes: number;
    /** Second agent pass that reads each new script as a viewer and fixes narration that does not follow. */
    scriptReview: boolean;
  };
  discovery: {
    /** Lookback when no previous check exists. */
    initialDays: number;
    /** Paths whose changes count as manual map/content work. */
    contentGlobs: string[];
  };
  elevenlabs: {
    /** Stored key; ELEVENLABS_API_KEY in the environment takes precedence. */
    apiKey?: string;
    voiceId: string;
    modelId: string;
    stability: number;
    similarityBoost: number;
    style: number;
    speed: number;
  };
  render: { fps: number; draftScale: number };
  publishing: {
    /** Appended to every video description, e.g. music licence and credits. */
    attribution: string;
  };
  youtube: {
    /** OAuth client of the user's Google Cloud project (type "Desktop app"). */
    clientId: string;
    /** Write-only in the UI. */
    clientSecret?: string;
    /** Never sent to the browser. */
    refreshToken?: string;
    channelTitle?: string;
    /** Time of day (HH:MM, local) for scheduled publishing when an episode has a publish date. */
    publishTime: string;
    /** Visibility for videos without a publish date, applied on approval. */
    privacyWithoutDate: "public" | "unlisted" | "private";
    categoryId: string;
    madeForKids: boolean;
    /** YouTube's disclosure for realistic altered or synthetic content. */
    containsSyntheticMedia: boolean;
    uploadCaptions: boolean;
    /** How often YouTube statistics are fetched. */
    statsIntervalHours: number;
  };
  theme: {
    colors?: Partial<import("../shared/types.js").ThemeColors>;
    logo?: import("../shared/bumpers.js").ThemeAsset;
    /** Font of slide headings and labels. */
    displayFont?: import("../shared/bumpers.js").ThemeAsset;
    /** Image materials used as slide backgrounds; none means blurred captures from the video. */
    backgroundMaterialIds: string[];
    /** Bumper over the start of the first segment; none when unset. */
    intro?: import("../shared/bumpers.js").BumperChoice;
    /** Bumper over the end of the last segment; none when unset. */
    outro?: import("../shared/bumpers.js").BumperChoice;
  };
}

/** Local scratch files (agent evidence, render inputs, downloads). Disposable. */
export const CACHE_DIR = path.join(ROOT, "cache");
/** Final videos and upload text, ready to post. A relative DEVLOG_OUTPUT_DIR counts from the app's folder. */
export const OUTPUT_DIR = path.resolve(ROOT, process.env.DEVLOG_OUTPUT_DIR || "output");

const EXAMPLE_PATH = path.join(ROOT, "config", "studio.example.json");

let globalSettings: GlobalSettings;
let example: StudioConfig | undefined;
function defaults(): StudioConfig {
  return example ??= JSON.parse(fs.readFileSync(EXAMPLE_PATH, "utf8")) as StudioConfig;
}
export function exampleConfig(): StudioConfig {
  return structuredClone(defaults());
}
export const globalConfig = () => globalSettings;
export async function loadConfig() {
  globalSettings = (await query<{ value: GlobalSettings }>("SELECT value FROM settings WHERE key = 'global'"))[0].value;
  return globalSettings;
}
export async function saveGlobal(next: GlobalSettings) {
  await query("UPDATE settings SET value = $1 WHERE key = 'global'", [next]); globalSettings = next;
}
/** A project-local view for the existing rendering and narration code. Never persisted as a whole. */
export function config(): StudioConfig {
  const example = defaults();
  const ctx = currentContext();
  const p = ctx.projectId ? getProject(ctx.projectId).settings : undefined;
  const source = p?.sources.find((s) => s.id === (ctx.sourceId ?? p.primarySourceId));
  const target = p?.captureTargets.find((t) => t.id === (ctx.targetId ?? p.defaultCaptureTargetId));
  // Only a Unity target fills the Unity part of this view.
  const unityConfig = (c?: CaptureTarget["config"]) => (c && "headerHelper" in c ? c : undefined);
  const targetConfig = unityConfig(ctx.captureConfig) ?? (target?.kind === "unity-mcp" ? target.config : undefined);
  const cid = ctx.connectionId ?? p?.publishing.connectionId;
  const connection = ctx.connectionId ? getConnection(ctx.connectionId) : findConnection(cid);
  return { ...example, ...globalSettings,
    port: Number(process.env.PORT) || globalSettings?.port || example.port,
    gameTitle: p?.publicTitle ?? "",
    unity: { projectPath: targetConfig?.projectPath || source?.path || "", mcp: targetConfig ? { url: targetConfig.url, headerHelper: targetConfig.headerHelper, headerHelperArgs: targetConfig.headerHelperArgs } : { url: "", headerHelper: "", headerHelperArgs: [] } },
    discovery: { initialDays: p?.discovery.initialDays ?? 7, contentGlobs: source?.contentGlobs ?? [] },
    elevenlabs: { ...example.elevenlabs, ...p?.narration, ...globalSettings?.elevenlabs },
    youtube: { ...example.youtube, clientId: "", ...p?.publishing, ...connection, statsIntervalHours: globalSettings?.statsIntervalHours ?? 3 },
    publishing: { attribution: p?.publishing.attribution ?? "" },
    theme: p ? p.theme : { backgroundMaterialIds: [] },
  };
}
export async function saveConfig(next: StudioConfig) {
  const p = getProject();
  await saveProject(p.id, { ...p.settings, publicTitle: next.gameTitle, discovery: { initialDays: next.discovery.initialDays }, narration: { voiceId: next.elevenlabs.voiceId, modelId: next.elevenlabs.modelId, stability: next.elevenlabs.stability, similarityBoost: next.elevenlabs.similarityBoost, style: next.elevenlabs.style, speed: next.elevenlabs.speed }, theme: next.theme, publishing: { ...p.settings.publishing, attribution: next.publishing.attribution, publishTime: next.youtube.publishTime, privacyWithoutDate: next.youtube.privacyWithoutDate, categoryId: next.youtube.categoryId, madeForKids: next.youtube.madeForKids, containsSyntheticMedia: next.youtube.containsSyntheticMedia, uploadCaptions: next.youtube.uploadCaptions } });
}
export function elevenLabsKey(): string | undefined {
  return process.env.ELEVENLABS_API_KEY || globalSettings?.elevenlabs.apiKey || undefined;
}
export function publicConfig() {
  const c = config();
  const { apiKey, ...elevenlabs } = c.elevenlabs;
  const { clientSecret, refreshToken, ...youtube } = c.youtube;
  return { ...c, elevenlabs: { ...elevenlabs, apiKeySet: !!apiKey, apiKeyFromEnv: !!process.env.ELEVENLABS_API_KEY }, youtube: { ...youtube, clientSecretSet: !!clientSecret, connected: !!refreshToken } };
}
