import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ActivitySource, SessionImage } from "../shared/activity.js";
import type { Material } from "../shared/types.js";
import { CACHE_DIR } from "./config.js";
import { projectId } from "./context.js";
import { query } from "./db.js";
import { readSessionImages, type LoggedImage } from "./ingress/sessions.js";
import { shorten } from "./ingress/redact.js";
import { throwIfCancelled } from "./jobs.js";
import { ingestFile, probe, still } from "./materials.js";
import { getProject } from "./projects.js";
import { cached, contentTypeOf, deletePrefix, putFile } from "./storage.js";
import { getMaterials, getValue, setValue } from "./store.js";

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const notFound = () => Object.assign(new Error("This image is no longer in the inbox."), { status: 404 });

/** Session sources that import images, by ID. */
export const importingSources = (sources: ActivitySource[] = []) => sources.filter((s) => s.enabled && s.importImages && (s.connector === "claude-sessions" || s.connector === "codex-sessions"));

const storageFolder = (pid: string, id: string) => `projects/${pid}/session-images/${id}/`;

/**
 * Stores one logged image unless the project already has its content, whatever its status.
 * Content that ffmpeg can't read is skipped; a storage failure reaches the caller, so the log is read again.
 */
export async function storeLoggedImage(pid: string, image: LoggedImage, log: (line: string) => void = () => {}): Promise<boolean> {
  const extension = EXTENSIONS[image.mediaType.toLowerCase()];
  const data = Buffer.from(image.base64, "base64");
  if (!extension || !data.length) return false;
  const id = `si-${crypto.createHash("sha256").update(data).digest("hex").slice(0, 32)}`;
  if ((await query("SELECT 1 FROM session_images WHERE project_id = $1 AND id = $2", [pid, id])).length) return false;
  const dir = path.join(CACHE_DIR, "uploads", id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const fileName = `session-${image.date}-${id.slice(3, 11)}${extension}`;
    const original = path.join(dir, fileName);
    const thumb = path.join(dir, "thumb.jpg");
    const preview = path.join(dir, "preview.jpg");
    fs.writeFileSync(original, data);
    let info: Awaited<ReturnType<typeof probe>>;
    try {
      info = await probe(original);
      await still(original, thumb, 480, false);
      await still(original, preview, 1280, false);
    } catch {
      log(`Skipped an unreadable image from ${image.date}.`);
      return false;
    }
    const folder = storageFolder(pid, id);
    const row: SessionImage = {
      id,
      createdAt: new Date().toISOString(),
      date: image.date,
      at: image.at,
      tool: image.tool,
      sessionId: image.sessionId,
      recordId: image.recordId,
      sourceId: image.sourceId,
      sessionTitle: image.sessionTitle,
      title: shorten(image.message.split(/\r?\n/)[0] ?? "", 70) || image.sessionTitle || `Screenshot from ${image.date}`,
      message: image.message,
      status: "inbox",
      otherWork: image.otherWork || undefined,
      fileName,
      contentType: contentTypeOf(fileName),
      size: data.length,
      width: info.width,
      height: info.height,
      key: `${folder}${fileName}`,
      thumbKey: `${folder}thumb.jpg`,
      previewKey: `${folder}preview.jpg`,
    };
    await putFile(row.key, original);
    await putFile(row.thumbKey, thumb);
    await putFile(row.previewKey, preview);
    const inserted = await query("INSERT INTO session_images (project_id, id, date, data) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id", [pid, id, row.date, row]);
    return inserted.length > 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads new log lines of every session source that imports images. It keeps its own place, so it reads logs older than the activity range too. */
export async function importSessionImages(log: (line: string) => void = () => {}): Promise<{ added: number }> {
  const pid = projectId();
  const settings = getProject(pid).settings;
  const sources = importingSources(settings.activitySources);
  if (!sources.length) { log("No session source imports screenshots."); return { added: 0 }; }
  let added = 0;
  for (const source of sources) {
    const key = `activityCursor:images:${source.id}`;
    const stored = await getValue<{ cursor: unknown }>(pid, key);
    let count = 0;
    const cursor = await readSessionImages(source.connector as "claude-sessions" | "codex-sessions", settings, source, stored?.cursor, async (image) => {
      throwIfCancelled();
      if (await storeLoggedImage(pid, image, log)) count++;
    });
    await setValue(pid, key, { cursor });
    log(`${source.connector === "claude-sessions" ? "Claude Code" : "Codex"}: ${count} new image(s).`);
    added += count;
  }
  return { added };
}

/**
 * Inbox and dismissed images. An image follows its session's visibility. A session outside the activity range has no record,
 * so the rule for other work decides when the image is read.
 */
export async function listSessionImages(pid: string): Promise<SessionImage[]> {
  const rows = await query<{ data: SessionImage }>("SELECT data FROM session_images WHERE project_id = $1 AND data->>'status' <> 'added' ORDER BY data->>'at' DESC", [pid]);
  const visibility = new Map((await query<{ id: string; visibility: string }>("SELECT id, data->>'visibility' AS visibility FROM activity WHERE project_id = $1 AND data->>'kind' = 'session'", [pid])).map((r) => [r.id, r.visibility]));
  return rows.map((r) => r.data).filter((image) => {
    const state = visibility.get(image.recordId);
    return state ? state !== "excluded" : !image.otherWork;
  });
}

async function loadImage(pid: string, id: string): Promise<SessionImage> {
  const row = (await query<{ data: SessionImage }>("SELECT data FROM session_images WHERE project_id = $1 AND id = $2", [pid, id]))[0];
  if (!row) throw notFound();
  return row.data;
}

const saveImage = (pid: string, image: SessionImage) => query("UPDATE session_images SET data = $3 WHERE project_id = $1 AND id = $2", [pid, image.id, image]);

/** Dismissing keeps the content's hash, so later reads of the log don't bring the image back. */
export async function setSessionImageStatus(id: string, status: "inbox" | "dismissed"): Promise<SessionImage> {
  const pid = projectId();
  const image = await loadImage(pid, id);
  if (image.status === "added") throw notFound();
  const next = { ...image, status };
  await saveImage(pid, next);
  return next;
}

/** Makes an image a normal material. The row stays, so a deleted material's image doesn't return, and the stored copy goes away. */
export async function addSessionImage(id: string, fields: Partial<Pick<Material, "date" | "title" | "annotation" | "tags" | "group">>): Promise<Material> {
  const pid = projectId();
  const image = await loadImage(pid, id);
  if (image.status === "added") {
    const [existing] = await getMaterials(pid, [image.materialId!]).catch(() => []);
    if (existing) return existing;
    throw notFound();
  }
  const material = await ingestFile(await cached(image.key), image.fileName, { date: image.date, title: image.title, annotation: image.message, ...fields });
  await saveImage(pid, { ...image, status: "added", materialId: material.id });
  await deletePrefix(storageFolder(pid, id)).catch(() => {});
  return material;
}
