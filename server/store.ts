import crypto from "node:crypto";
import type pg from "pg";
import { query, tx } from "./db.js";
import type { Post, Material, MaterialDeletion, Note, Suggestion, Script, Format } from "../shared/types.js";
import type { Snapshot } from "./discovery.js";
import { detachMaterial, mergeCaptureTargets, pruneSegmentReferences, type CaptureTargetBase } from "../shared/references.js";
import { updateProjectCache } from "./projects.js";
import { inContext } from "./context.js";
import { projectVoices, usableTakes } from "./takes.js";

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
export const today = () => new Date().toISOString().slice(0, 10);
export const notFound = (what: string) => Object.assign(new Error(`${what} not found`), { status: 404 });
export async function projectWrite<T>(pid: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return tx(async (c) => {
    const p = (await c.query("SELECT data FROM projects WHERE id = $1 FOR UPDATE", [pid])).rows[0];
    if (!p) throw notFound("Project");
    if (p.data.deletion) throw Object.assign(new Error("Project is being deleted"), { status: 409 });
    return work(c);
  });
}
export async function validateReferences(c: pg.PoolClient, pid: string, entity: unknown) {
  const materials = new Set<string>(), suggestions = new Set<string>(), targets = new Set<string>(), sources = new Set<string>();
  function visit(value: unknown, key = "") {
    if (typeof value === "string") {
      if (["materialId", "materialIds", "backgroundMaterialIds"].includes(key)) materials.add(value);
      if (key === "suggestionIds") suggestions.add(value);
      if (key === "targetId") targets.add(value);
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) {
      if (k === "sources" && v && typeof v === "object") for (const ref of (v as { commits?: string[] }).commits ?? []) { if (!/^[a-zA-Z0-9-]+:[0-9a-f]{7,40}$/i.test(ref)) throw new Error("Invalid source or commit reference"); sources.add(ref.split(":")[0]); }
      visit(v, k);
    }
  }
  visit(entity);
  const segmentIds = new Set<string>();
  const imageRefs: string[] = [];
  function slides(v: unknown) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(slides); return; }
    const obj = v as Record<string, unknown>;
    if (typeof obj.id === "string" && "visual" in obj) segmentIds.add(obj.id);
    if (Array.isArray(obj.imageFrom)) imageRefs.push(...obj.imageFrom);
    Object.values(obj).forEach(slides);
  }
  slides(entity);
  imageRefs.filter((ref) => !segmentIds.has(ref)).forEach((ref) => materials.add(ref));
  for (const [table, ids] of [["materials", materials], ["suggestions", suggestions]] as const) {
    if (ids.size && (await c.query(`SELECT id FROM ${table} WHERE project_id = $1 AND id = ANY($2)`, [pid, [...ids]])).rowCount !== ids.size) throw notFound("Referenced " + table);
  }
  const settings = (await c.query("SELECT data FROM projects WHERE id = $1", [pid])).rows[0]?.data.settings;
  if ([...targets].some((id) => !settings.captureTargets.some((t: { id: string }) => t.id === id))) throw notFound("Capture target");
  if ([...sources].some((id) => !settings.sources.some((s: { id: string }) => s.id === id))) throw notFound("Source");
}
export async function getValue<T>(pid: string, key: string): Promise<T | undefined> {
  return (await query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [`project:${pid}:${key}`]))[0]?.value;
}
export async function setValue(pid: string, key: string, value: unknown) {
  await projectWrite(pid, async (c) => { await c.query("INSERT INTO settings VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`project:${pid}:${key}`, JSON.stringify(value)]); });
}
export const getSnapshot = (pid: string) => getValue<Record<string, Snapshot>>(pid, "snapshot");
export const setSnapshot = (pid: string, s: Record<string, Snapshot>) => setValue(pid, "snapshot", s);
async function records<T>(pid: string, table: string, ids?: string[], lock?: pg.PoolClient): Promise<T[]> {
  const sql = `SELECT id, data FROM ${table} WHERE project_id = $1${ids ? " AND id = ANY($2)" : ""}${lock ? " FOR UPDATE" : " ORDER BY created_at DESC"}`;
  const rows = lock ? (await lock.query(sql, ids ? [pid, ids] : [pid])).rows : await query(sql, ids ? [pid, ids] : [pid]);
  if (!ids) return rows.map((r) => r.data as T);
  const map = new Map(rows.map((r) => [r.id, r.data as T]));
  if (ids.some((id) => !map.has(id))) throw notFound(table);
  return ids.map((id) => map.get(id)!);
}
async function write(c: pg.PoolClient, pid: string, table: string, e: { id: string; createdAt: string; [key: string]: unknown }) {
  if (table === "posts" && (!Array.isArray(e.outputs) || !e.outputs.length || e.outputs.some((o) => o !== "portrait" && o !== "landscape" && o !== "article"))) throw new Error("Choose at least one available video output");
  if (table === "posts") {
    const previous = (await c.query<{ data: Post }>("SELECT data FROM posts WHERE id = $1 AND project_id = $2", [e.id, pid])).rows[0]?.data;
    for (const [format, script] of Object.entries((e as unknown as Post).scripts)) if (script) {
      pruneSegmentReferences(script, previous?.scripts[format as keyof Post["scripts"]]?.segments.map((s) => s.id));
    }
  }
  await validateReferences(c, pid, e);
  const extra = table === "suggestions" ? ["work_date", "publish_date", "status"] : table === "materials" ? ["date"] : [];
  const values = table === "suggestions" ? [e.workDate, e.publishDate || null, e.status] : table === "materials" ? [e.date] : [];
  const columns = ["id", "project_id", "created_at", "data", ...extra];
  const updated = ["data", ...extra].map((k) => `${k} = EXCLUDED.${k}`).join(", ");
  const result = await c.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (id) DO UPDATE SET ${updated} WHERE ${table}.project_id = EXCLUDED.project_id RETURNING id`, [e.id, pid, e.createdAt, JSON.stringify(e), ...values]);
  if (!result.rowCount) throw notFound(table);
}
const entity = (e: object) => e as { id: string; createdAt: string; [key: string]: unknown };
export const listSuggestions = (pid: string) => records<Suggestion>(pid, "suggestions");
export const getSuggestions = (pid: string, ids: string[]) => records<Suggestion>(pid, "suggestions", ids);
export const insertSuggestion = (pid: string, s: Suggestion) => projectWrite(pid, (c) => write(c, pid, "suggestions", entity({ ...s, materialIds: s.materialIds ?? [] })));
export async function updateSuggestions(pid: string, ids: string[], fn: (items: Suggestion[]) => void | Suggestion[]): Promise<Suggestion[]> {
  return projectWrite(pid, async (c) => {
    const items = await records<Suggestion>(pid, "suggestions", ids, c);
    const extra = fn(items) ?? [];
    for (const s of [...items, ...extra]) await write(c, pid, "suggestions", entity(s));
    return [...items, ...extra];
  });
}
export async function listNotes(pid: string): Promise<Note[]> {
  return (await query<{ id: string; date: string; created_at: Date; text: string }>("SELECT id, to_char(date, 'YYYY-MM-DD') AS date, created_at, text FROM notes WHERE project_id = $1 ORDER BY date, created_at", [pid])).map((r) => ({ id: r.id, date: r.date, createdAt: r.created_at.toISOString(), text: r.text }));
}
export const insertNote = (pid: string, n: Note) => projectWrite(pid, async (c) => { await c.query("INSERT INTO notes (id, project_id, date, created_at, text) VALUES ($1, $2, $3, $4, $5)", [n.id, pid, n.date, n.createdAt, n.text]); });
async function remove(pid: string, table: string, id: string) {
  await projectWrite(pid, async (c) => { if (!(await c.query(`DELETE FROM ${table} WHERE id = $1 AND project_id = $2`, [id, pid])).rowCount) throw notFound(table); });
}
export const deleteNote = (pid: string, id: string) => remove(pid, "notes", id);
/** Deletes a post and returns its suggestions to the approved list, in one transaction. */
export async function deletePost(pid: string, id: string): Promise<string[]> {
  return projectWrite(pid, async (c) => {
    const row = (await c.query<{ data: Post }>("SELECT data FROM posts WHERE id = $1 AND project_id = $2 FOR UPDATE", [id, pid])).rows[0];
    if (!row) throw notFound("Post");
    const restored: string[] = [];
    for (const s of (await c.query<{ data: Suggestion }>("SELECT data FROM suggestions WHERE project_id = $1 AND id = ANY($2) FOR UPDATE", [pid, row.data.suggestionIds])).rows) {
      if (s.data.postId !== id) continue;
      delete s.data.postId;
      s.data.status = "approved";
      await c.query("UPDATE suggestions SET status = $3, data = $2 WHERE id = $1 AND project_id = $4", [s.data.id, s.data, s.data.status, pid]);
      restored.push(s.data.id);
    }
    await c.query("DELETE FROM posts WHERE id = $1 AND project_id = $2", [id, pid]);
    return restored;
  });
}
export async function listMaterials(pid: string, range?: { from?: string; to?: string; createdAfter?: string }): Promise<Material[]> {
  return (await query<{ data: Material }>(`SELECT data FROM materials WHERE project_id = $1 AND ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3) AND ($4::timestamptz IS NULL OR created_at > $4) ORDER BY date DESC, created_at DESC`, [pid, range?.from ?? null, range?.to ?? null, range?.createdAfter ?? null])).map((r) => r.data);
}
export const getMaterials = (pid: string, ids: string[]) => records<Material>(pid, "materials", ids);
export const saveMaterial = (pid: string, m: Material) => projectWrite(pid, (c) => write(c, pid, "materials", entity(m)));
/** Detach all uses and delete the row under the same project lock as reference writes. */
export async function deleteMaterial(pid: string, id: string, removeFiles?: () => Promise<void>): Promise<MaterialDeletion> {
  const updated = await projectWrite(pid, async (c) => {
    if (!(await c.query("SELECT id FROM materials WHERE id = $1 AND project_id = $2", [id, pid])).rowCount) throw notFound("Material");
    for (const row of (await c.query<{ data: Post }>("SELECT data FROM posts WHERE project_id = $1 FOR UPDATE", [pid])).rows) {
      detachMaterial(row.data, id);
      await c.query("UPDATE posts SET data = $2 WHERE id = $1 AND project_id = $3", [row.data.id, row.data, pid]);
    }
    for (const row of (await c.query<{ data: Suggestion }>("SELECT data FROM suggestions WHERE project_id = $1 FOR UPDATE", [pid])).rows) {
      row.data.materialIds = (row.data.materialIds ?? []).filter((ref) => ref !== id);
      await c.query("UPDATE suggestions SET data = $2 WHERE id = $1 AND project_id = $3", [row.data.id, row.data, pid]);
    }
    const project = (await c.query("SELECT data FROM projects WHERE id = $1", [pid])).rows[0].data;
    project.settings.theme.backgroundMaterialIds = project.settings.theme.backgroundMaterialIds.filter((ref: string) => ref !== id);
    await c.query("UPDATE projects SET data = $2 WHERE id = $1", [pid, project]);
    await c.query("DELETE FROM materials WHERE id = $1 AND project_id = $2", [id, pid]);
    return project;
  });
  updateProjectCache(pid, updated);
  try { await removeFiles?.(); }
  catch { return { deleted: true, warning: "Material deleted. Some stored files could not be removed." }; }
  return { deleted: true };
}
export const loadPost = async (pid: string, id: string) => (await records<Post>(pid, "posts", [id]))[0];
export const savePost = (pid: string, p: Post) => projectWrite(pid, (c) => write(c, pid, "posts", entity(p)));
export async function updatePost(pid: string, id: string, fn: (p: Post) => void | Promise<void>): Promise<Post> {
  return projectWrite(pid, async (c) => {
    const p = (await records<Post>(pid, "posts", [id], c))[0];
    await fn(p);
    await write(c, pid, "posts", entity(p));
    return p;
  });
}
function assertValidTurns(post: Post, format: Format, script: Script) {
  const refuse = (message: string) => Object.assign(new Error(message), { status: 400 });
  const turns = script.segments.flatMap((s) => s.turns ?? []);
  if (script.segments.some((s) => s.turns) && post.presentation?.[format] !== "coHost") throw refuse("This video is solo, so its script can't have co-host lines.");
  if (turns.some((t) => !t.id || typeof t.text !== "string" || (t.speaker !== "developer" && t.speaker !== "coHost"))) throw refuse("Each line needs an ID, a speaker and text.");
  if (new Set(turns.map((t) => t.id)).size !== turns.length) throw refuse("Each line needs its own ID.");
}
export function saveScript(pid: string, id: string, format: Format, script: Script, base?: CaptureTargetBase) {
  return updatePost(pid, id, (post) => {
    const previous = post.scripts[format];
    const next = structuredClone(script);
    assertValidTurns(post, format, next);
    mergeCaptureTargets(previous, next, base);
    // Capture results belong to the server: captures and going back a take change them, script edits do not.
    for (const segment of next.segments) {
      const saved = previous?.segments.find((p) => p.id === segment.id);
      segment.media = saved?.media;
      segment.mediaSeconds = saved?.mediaSeconds;
      segment.capturedAt = saved?.capturedAt;
      // A capture error belongs to the kind of visual it was made for; a segment that turned into another kind drops it.
      segment.captureError = saved?.visual.type === segment.visual.type ? saved.captureError : undefined;
      segment.takes = saved?.takes;
    }
    const takes = post.narration[format];
    if (takes) {
      const current = takes.filter((t) => t.turnId || next.segments.some((s) => s.id === t.segmentId && previous?.segments.find((p) => p.id === s.id)?.narration === s.narration));
      post.narration[format] = inContext({ projectId: pid }, () => usableTakes(current, next.segments, projectVoices()));
    }
    // The verification belongs to the server: only a check changes it, and comparing fingerprints shows whether it still holds.
    post.scripts[format] = { ...next, format, verification: previous?.verification };
  });
}
export const listPosts = (pid: string) => records<Post>(pid, "posts");
export async function saveRun(pid: string, id: string, kind: string, evidence: unknown, output: unknown) {
  await projectWrite(pid, async (c) => { await c.query("INSERT INTO runs (id, project_id, kind, created_at, evidence, output) VALUES ($1, $2, $3, now(), $4, $5)", [id, pid, kind, JSON.stringify(evidence), JSON.stringify(output)]); });
}
