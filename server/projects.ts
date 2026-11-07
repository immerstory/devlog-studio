import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, tx } from "./db.js";
import { currentContext } from "./context.js";
import { newId, notFound, projectWrite, validateReferences } from "./store.js";
import { exampleConfig, OUTPUT_DIR } from "./config.js";
import { projectFromStudio } from "./project-model.js";
import type pg from "pg";
import type { Project, ProjectSettings, Source, YouTubeConnection } from "../shared/projects.js";
import type { EgressConnection } from "../shared/publications.js";
import { listJobs } from "./jobs.js";
import { deleteKey, deletePrefix, listKeys } from "./storage.js";
import { pinDefaultCaptureTarget } from "../shared/references.js";
import { ARCHETYPES, isArchetype, type ProjectArchetype } from "../shared/archetypes.js";

const projects = new Map<string, Project>();
const connections = new Map<string, YouTubeConnection>();
/** A YouTube connection is a publishing connection: this is its view for the code that talks to YouTube. */
export const youtubeFromEgress = (c: EgressConnection): YouTubeConnection => ({ id: c.id, name: c.name, clientId: String(c.config.clientId ?? ""), clientSecret: c.secrets?.clientSecret, refreshToken: c.secrets?.refreshToken, channelId: c.config.channelId as string | undefined, channelTitle: c.config.channelTitle as string | undefined });
export const egressFromYoutube = (c: YouTubeConnection): EgressConnection => ({ id: c.id, connector: "youtube", name: c.name, config: { clientId: c.clientId, channelId: c.channelId, channelTitle: c.channelTitle }, secrets: { clientSecret: c.clientSecret, refreshToken: c.refreshToken } });
export const cacheYoutubeConnection = (c: EgressConnection) => { connections.set(c.id, youtubeFromEgress(c)); };
export async function loadProjects() {
  projects.clear(); connections.clear();
  for (const row of await query("SELECT * FROM projects ORDER BY created_at")) projects.set(row.id, { ...row.data, id: row.id, slug: row.slug, createdAt: row.created_at.toISOString() });
  for (const row of await query<{ data: EgressConnection }>("SELECT data FROM egress_connections WHERE connector = 'youtube'")) connections.set(row.data.id, youtubeFromEgress(row.data));
}
export const listProjects = () => [...projects.values()];
export function getProject(id = currentContext().projectId): Project {
  const p = id && projects.get(id);
  if (!p) throw notFound("Project");
  return p;
}
export function updateProjectCache(id: string, data: Pick<Project, "settings" | "deletion">) {
  projects.set(id, { ...getProject(id), ...data });
}
export const listConnections = () => [...connections.values()];
export const findConnection = (id?: string) => id ? connections.get(id) : undefined;
export function getConnection(id?: string): YouTubeConnection {
  const c = id && connections.get(id);
  if (!c) throw notFound("YouTube connection");
  return c;
}
export function publicConnection(c: YouTubeConnection) {
  const { clientSecret, refreshToken, ...rest } = c;
  return { ...rest, clientSecretSet: !!clientSecret, connected: !!refreshToken };
}
export async function saveConnection(c: YouTubeConnection) {
  await query("INSERT INTO egress_connections (id, connector, data) VALUES ($1, 'youtube', $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data", [c.id, egressFromYoutube(c)]);
  connections.set(c.id, c);
}
export async function deleteConnection(id: string) {
  getConnection(id);
  const changed = await tx(async (c) => {
    const rows = (await c.query("SELECT id, data FROM projects WHERE data #>> '{settings,publishing,connectionId}' = $1 ORDER BY id FOR UPDATE", [id])).rows;
    await c.query("SELECT id FROM egress_connections WHERE id = $1 FOR UPDATE", [id]);
    const used = await c.query("SELECT 1 FROM posts WHERE data::text LIKE $1 UNION ALL SELECT 1 FROM publications WHERE data->>'connectionId' = $2 LIMIT 1", [`%${id}%`, id]);
    if (used.rowCount) throw Object.assign(new Error("Uploaded videos still reference this connection"), { status: 409 });
    for (const row of rows) {
      delete row.data.settings.publishing.connectionId;
      await c.query("UPDATE projects SET data = $2 WHERE id = $1", [row.id, row.data]);
    }
    await c.query("DELETE FROM egress_connections WHERE id = $1", [id]);
    return rows;
  });
  for (const row of changed) projects.set(row.id, { ...getProject(row.id), ...row.data });
  connections.delete(id);
}
export async function checkSource(sourcePath: string) {
  const refuse = (message: string) => Object.assign(new Error(message), { status: 400 });
  if (!sourcePath?.trim()) throw refuse("Choose a Git working copy.");
  if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isDirectory()) throw refuse(`This folder does not exist: ${sourcePath}`);
  const run = promisify(execFile);
  const git = async (...args: string[]) => (await run("git", args, { cwd: sourcePath, windowsHide: true })).stdout.trim();
  // Git's own explanation, such as the command to trust a folder owned by another user.
  const reason = (e: unknown) => (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
  const inside = await git("rev-parse", "--is-inside-work-tree").catch((e) => {
    throw refuse(/not a git repository/i.test(reason(e)) ? `This folder is not in a Git working copy: ${sourcePath}` : reason(e));
  });
  if (inside !== "true") throw refuse(`This folder is not in a Git working copy: ${sourcePath}`);
  const head = await git("rev-parse", "HEAD").catch(() => { throw refuse("This Git repository has no commits yet."); });
  return { path: await git("rev-parse", "--show-toplevel"), branch: await git("branch", "--show-current"), head };
}
export async function createProject(input: { name: string; publicTitle?: string; description?: string; archetype?: ProjectArchetype; sourcePath: string }) {
  if (!input.name?.trim()) throw new Error("Enter a project name");
  const archetype = input.archetype ?? "other";
  if (!isArchetype(archetype)) throw Object.assign(new Error("Choose a project type"), { status: 400 });
  const source = await checkSource(input.sourcePath);
  const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  let slug = base;
  for (let i = 2; listProjects().some((p) => p.slug === slug); i++) slug = `${base}-${i}`;
  const defaults = projectFromStudio(exampleConfig(), newId("source"), newId("target"));
  const settings: ProjectSettings = { ...defaults, name: input.name.trim(), publicTitle: input.publicTitle?.trim() || input.name.trim(), description: input.description?.trim() || input.name.trim(), archetype, sources: [{ ...defaults.sources[0], label: "Source", path: source.path, contentGlobs: ARCHETYPES[archetype].contentGlobs }], captureTargets: [], defaultCaptureTargetId: undefined, theme: { backgroundMaterialIds: [] } };
  const p: Project = { id: newId("project"), slug, createdAt: new Date().toISOString(), settings };
  await query("INSERT INTO projects VALUES ($1, $2, $3, $4)", [p.id, p.slug, p.createdAt, { settings }]); projects.set(p.id, p); return p;
}
export async function saveProject(id: string, settings: ProjectSettings, slug = getProject(id).slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Use a URL slug with letters, numbers and hyphens");
  if (!settings.name?.trim() || !settings.sources.some((s) => s.id === settings.primarySourceId && !s.archived)) throw new Error("A name and an active primary source are required");
  if (!isArchetype(settings.archetype)) throw new Error("Choose a project type");
  if (settings.coHost?.enabled) {
    if (!settings.coHost.name?.trim()) throw new Error("Enter a name for the co-host");
    if (!settings.coHost.voiceId?.trim()) throw new Error("Enter a voice ID for the co-host");
    if (settings.coHost.voiceId === settings.narration.voiceId) throw new Error("The co-host needs a different voice than the narrator");
    if (!/^#[0-9a-f]{6}$/i.test(settings.coHost.captionColor ?? "")) throw new Error("Use a caption color in the form #rrggbb");
    if (Object.values(settings.coHost.share ?? {}).some((n) => !(n >= 0 && n <= 1))) throw new Error("Use a co-host word share from 0 to 100%");
  }
  if (settings.defaultCaptureTargetId && !settings.captureTargets.some((t) => t.id === settings.defaultCaptureTargetId)) throw notFound("Default capture target");
  if (settings.captureTargets.length && !settings.defaultCaptureTargetId) throw new Error("Choose a default capture target");
  if (settings.publishing.connectionId) getConnection(settings.publishing.connectionId);
  if (!settings.outputs.enabled.length || settings.outputs.enabled.some((o) => o !== "portrait" && o !== "landscape")) throw new Error("Choose at least one available video output");
  const old = getProject(id);
  const removedSources = old.settings.sources.filter((s) => !settings.sources.some((n) => n.id === s.id));
  if (new Set(settings.sources.map((s) => s.id)).size !== settings.sources.length || new Set(settings.captureTargets.map((t) => t.id)).size !== settings.captureTargets.length) throw new Error("Sources and capture targets need unique IDs");
  for (const source of settings.sources.filter((s) => !s.archived && old.settings.sources.find((o) => o.id === s.id)?.path !== s.path)) await checkSource(source.path);
  const p = { ...old, settings, slug };
  let removedImages: string[] = [];
  await projectWrite(id, async (c) => {
    const previous = (await c.query("SELECT data FROM projects WHERE id = $1", [id])).rows[0].data.settings as ProjectSettings;
    const posts = (await c.query("SELECT data FROM posts WHERE project_id = $1", [id])).rows.map((r) => r.data);
    validateCaptureTargetChange(previous, settings, posts);
    if (removedSources.length) removedImages = await removeSources(c, id, removedSources);
    if (settings.publishing.connectionId && !(await c.query("SELECT id FROM egress_connections WHERE id = $1 AND connector = 'youtube' FOR KEY SHARE", [settings.publishing.connectionId])).rowCount) throw notFound("YouTube connection");
    await validateReferences(c, id, { materialIds: settings.theme.backgroundMaterialIds });
    if (previous.defaultCaptureTargetId && previous.defaultCaptureTargetId !== settings.defaultCaptureTargetId) {
      for (const post of posts) if (pinDefaultCaptureTarget(post, previous.defaultCaptureTargetId)) {
        await c.query("UPDATE posts SET data = $2 WHERE id = $1 AND project_id = $3", [post.id, post, id]);
      }
    }
    await c.query("UPDATE projects SET slug = $2, data = $3 WHERE id = $1", [id, slug, { settings }]);
  });
  projects.set(id, p);
  await Promise.all(removedImages.map((image) => deletePrefix(`projects/${id}/session-images/${image}/`).catch(() => {})));
  return p;
}
/** Suggestions per source. A suggestion cites its source's commits, so that source has to stay readable. */
export async function sourceUsage(pid: string) {
  const uses: Record<string, number> = {};
  for (const row of await query<{ data: { sources?: { commits?: string[] } } }>("SELECT data FROM suggestions WHERE project_id = $1", [pid])) {
    for (const id of new Set((row.data.sources?.commits ?? []).map((ref) => ref.split(":")[0]))) uses[id] = (uses[id] ?? 0) + 1;
  }
  return uses;
}

/** Deletes sources nothing depends on, with what was only read from them. A source that suggestions cite can only be archived. */
async function removeSources(c: pg.PoolClient, pid: string, removed: Source[]) {
  const ids = new Set(removed.map((s) => s.id));
  for (const row of (await c.query("SELECT data FROM suggestions WHERE project_id = $1", [pid])).rows) {
    const used = removed.find((s) => (row.data.sources?.commits ?? []).some((ref: string) => ref.split(":")[0] === s.id));
    if (used) throw Object.assign(new Error(`Suggestions use the source "${used.label}", so archive it instead of deleting it.`), { status: 409 });
  }
  const records = (await c.query("SELECT id FROM activity WHERE project_id = $1 AND data->>'sourceId' = ANY($2)", [pid, [...ids]])).rows.map((r: { id: string }) => r.id);
  const images = (await c.query("DELETE FROM session_images WHERE project_id = $1 AND data->>'sourceId' = ANY($2) RETURNING id", [pid, [...ids]])).rows.map((r: { id: string }) => r.id);
  await c.query("DELETE FROM activity_links WHERE project_id = $1 AND (a = ANY($2) OR b = ANY($2))", [pid, records]);
  await c.query("DELETE FROM activity WHERE project_id = $1 AND id = ANY($2)", [pid, records]);
  for (const row of (await c.query("SELECT key, value FROM settings WHERE key = ANY($1) OR key LIKE $2", [[`project:${pid}:snapshot`, `project:${pid}:backfilledWeeks`], `project:${pid}:activityCursor:%`])).rows) {
    const value = row.value;
    if (row.key.includes(":activityCursor:")) {
      // A session log remembered for this source is read again, in case another source now claims it.
      const cursor = value.cursor;
      if (cursor && typeof cursor === "object") for (const [file, entry] of Object.entries(cursor) as Array<[string, { sourceId?: string }]>) if (entry?.sourceId && ids.has(entry.sourceId)) delete cursor[file];
    } else for (const id of ids) delete value[id];
    await c.query("UPDATE settings SET value = $2 WHERE key = $1", [row.key, value]);
  }
  return images;
}
export function validateCaptureTargetChange(previous: ProjectSettings, next: ProjectSettings, posts: import("../shared/types.js").Post[]) {
  const ids = new Set(next.captureTargets.map((t) => t.id));
  for (const post of posts) for (const script of Object.values(post.scripts)) for (const segment of script?.segments ?? []) {
    if (segment.visual.type !== "capture") continue;
    const targetId = segment.visual.targetId ?? previous.defaultCaptureTargetId;
    if (targetId && !ids.has(targetId)) throw Object.assign(new Error("A post still uses this capture target"), { status: 409 });
  }
}
export function referencedKeys(value: unknown): string[] {
  const keys = new Set<string>();
  function visit(v: unknown) {
    if (typeof v === "string" && /^(materials|episodes|tts|theme|projects)\//.test(v)) {
      keys.add(v);
      if (/^tts\/.*\.mp3$/.test(v)) keys.add(v.replace(/\.mp3$/, ".json"));
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  }
  visit(value); return [...keys];
}
async function otherReferences(pid: string) {
  return [...(await query("SELECT data FROM posts WHERE project_id <> $1 UNION ALL SELECT data FROM materials WHERE project_id <> $1 UNION ALL SELECT data FROM projects WHERE id <> $1", [pid])).map((r) => r.data)];
}
export interface CleanupIO {
  listKeys: typeof listKeys;
  deleteKey: typeof deleteKey;
  removeFolder: (dir: string) => void;
}
const cleanupIO: CleanupIO = { listKeys, deleteKey, removeFolder: (dir) => fs.rmSync(dir, { recursive: true, force: true }) };
export async function deleteProject(pid: string, files: boolean, io = cleanupIO) {
  await tx(async (c) => {
    const row = (await c.query("SELECT data FROM projects WHERE id = $1 FOR UPDATE", [pid])).rows[0];
    if (!row) throw notFound("Project");
    if (row.data.deletion) return;
    if (listJobs().some((j) => j.projectId === pid && j.status === "running")) throw Object.assign(new Error("Wait for running project jobs to finish"), { status: 409 });
    const rows = (await c.query("SELECT id, data FROM posts WHERE project_id = $1 UNION ALL SELECT id, data FROM materials WHERE project_id = $1", [pid])).rows;
    const others = await otherReferences(pid);
    const sharedKeys = new Set(referencedKeys(others));
    const sharedFolders = new Set(others.flatMap((v) => v.outputDirs ?? []));
    const keys = new Set(referencedKeys([row.data, ...rows.map((r) => r.data)]));
    if (files) {
      for (const r of rows) for (const prefix of [`episodes/${r.id}/`, `materials/${r.id}/`]) for (const key of await io.listKeys(prefix)) keys.add(key);
      // Theme uploads and bumper music, including uploads a theme no longer references.
      for (const key of await io.listKeys(`projects/${pid}/`)) keys.add(key);
    }
    const folders = [...new Set<string>(rows.flatMap((r) => r.data.outputDirs ?? []))].filter((dir) => !sharedFolders.has(dir));
    row.data.deletion = { files, garageKeys: files ? [...keys].filter((k) => !sharedKeys.has(k)) : [], folders: files ? folders : [] };
    await c.query("UPDATE projects SET data = $2 WHERE id = $1", [pid, row.data]);
    projects.set(pid, { ...getProject(pid), deletion: row.data.deletion });
  });
  await resumeDeletion(pid, io);
}
export async function resumeDeletion(pid: string, io = cleanupIO) {
  const p = getProject(pid), manifest = p.deletion;
  if (!manifest) return;
  const persist = () => query("UPDATE projects SET data = $2 WHERE id = $1", [pid, { settings: p.settings, deletion: manifest }]);
  if (!manifest.rowsDeleted) {
    await tx(async (c) => {
      const uploads = async (where: string) => (await c.query<{ video: string }>(`SELECT data->'result'->>'platformId' AS video FROM publications WHERE project_id ${where} $1 AND data->>'connector' = 'youtube' AND data->'result'->>'platformId' IS NOT NULL`, [pid])).rows.map((r) => r.video);
      const owned = await uploads("=");
      const shared = new Set(await uploads("<>"));
      await c.query("DELETE FROM video_stats WHERE video_id = ANY($1)", [owned.filter((id) => !shared.has(id))]);
      for (const table of ["suggestions", "notes", "materials", "posts", "runs", "activity", "activity_links", "session_images", "publications", "publication_stats"]) await c.query(`DELETE FROM ${table} WHERE project_id = $1`, [pid]);
      await c.query("DELETE FROM settings WHERE key LIKE $1", [`project:${pid}:%`]);
      manifest.rowsDeleted = true;
      await c.query("UPDATE projects SET data = $2 WHERE id = $1", [pid, { settings: p.settings, deletion: manifest }]);
    });
  }
  for (const key of [...manifest.garageKeys]) {
    if (!referencedKeys(await otherReferences(pid)).includes(key)) await io.deleteKey(key);
    manifest.garageKeys = manifest.garageKeys.filter((k) => k !== key); await persist();
  }
  for (const dir of [...manifest.folders]) {
    const resolved = path.resolve(dir);
    if (!resolved.startsWith(path.resolve(OUTPUT_DIR) + path.sep)) throw new Error("Refusing to delete a folder outside output");
    if (!(await otherReferences(pid)).some((v) => v.outputDirs?.includes(dir))) io.removeFolder(resolved);
    manifest.folders = manifest.folders.filter((f) => f !== dir); await persist();
  }
  await query("DELETE FROM projects WHERE id = $1", [pid]); projects.delete(pid);
}
