import { inContext, projectId } from "./context.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Busboy from "busboy";
import type { Request } from "express";
import { CACHE_DIR } from "./config.js";
import { cached, contentTypeOf, deletePrefix, putFile } from "./storage.js";
import { deleteMaterial, getMaterials, newId, saveMaterial, today } from "./store.js";
import { normalizeGroup } from "../shared/types.js";
import type { Material } from "../shared/types.js";

const run = promisify(execFile);
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv)$/i;

interface Probe {
  width?: number;
  height?: number;
  durationSeconds?: number;
}

async function probe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file], { windowsHide: true });
  const j = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  const d = Number(j.format?.duration);
  return { width: j.streams?.[0]?.width, height: j.streams?.[0]?.height, durationSeconds: Number.isFinite(d) && d > 0 ? d : undefined };
}

/** JPEG still at the given width; videos use a frame from their first seconds. */
async function still(input: string, out: string, width: number, video: boolean, duration?: number) {
  const seek = video ? ["-ss", String(Math.min(1, (duration ?? 2) / 2))] : [];
  await run("ffmpeg", ["-y", "-loglevel", "error", ...seek, "-i", input, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", out], { windowsHide: true });
}

/** Stores an uploaded file as a material: original, thumbnail and preview go to Garage. */
export async function ingestFile(file: string, fileName: string, fields: Partial<Pick<Material, "date" | "title" | "annotation" | "tags" | "group">>): Promise<Material> {
  const video = VIDEO.test(fileName);
  if (!video && !IMAGE.test(fileName)) throw Object.assign(new Error(`Unsupported file type: ${fileName}`), { status: 400 });
  const id = newId("mat");
  const info = await probe(file);
  const dir = path.join(CACHE_DIR, "uploads", id);
  fs.mkdirSync(dir, { recursive: true });
  const thumb = path.join(dir, "thumb.jpg");
  const preview = path.join(dir, "preview.jpg");
  await still(file, thumb, 480, video, info.durationSeconds);
  await still(file, preview, 1280, video, info.durationSeconds);
  const safeName = fileName.replace(/[^\w.\- ]+/g, "_");
  const m: Material = {
    id,
    createdAt: new Date().toISOString(),
    date: fields.date && /^\d{4}-\d{2}-\d{2}$/.test(fields.date) ? fields.date : today(),
    kind: video ? "video" : "image",
    fileName,
    contentType: contentTypeOf(fileName),
    size: fs.statSync(file).size,
    key: `materials/${id}/${safeName}`,
    thumbKey: `materials/${id}/thumb.jpg`,
    previewKey: `materials/${id}/preview.jpg`,
    ...info,
    title: fields.title?.trim() || path.basename(fileName, path.extname(fileName)),
    annotation: fields.annotation?.trim() ?? "",
    tags: fields.tags ?? [],
    group: normalizeGroup(fields.group),
  };
  await putFile(m.key, file);
  await putFile(m.thumbKey, thumb);
  await putFile(m.previewKey, preview);
  await saveMaterial(projectId(), m);
  fs.rmSync(dir, { recursive: true, force: true });
  return m;
}

/** Parses a multipart upload (files plus date/title/annotation/tags/group fields) and ingests each file. */
export function handleUpload(req: Request): Promise<Material[]> {
  // The upload stream's callbacks run outside the request's context, so the project is read here.
  const project = projectId();
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 ** 3 } });
    const fields: Record<string, string> = {};
    const files: Array<{ tmp: string; name: string }> = [];
    const writes: Promise<void>[] = [];
    const tmpDir = path.join(CACHE_DIR, "uploads", "incoming");
    fs.mkdirSync(tmpDir, { recursive: true });
    bb.on("field", (name, value) => (fields[name] = value));
    bb.on("file", (_name, stream, info) => {
      const name = info.filename ?? "upload";
      const tmp = path.join(tmpDir, `${newId("up")}${path.extname(name)}`);
      files.push({ tmp, name });
      writes.push(
        new Promise((res, rej) => {
          const out = fs.createWriteStream(tmp);
          stream.pipe(out);
          out.on("finish", () => res());
          out.on("error", rej);
        }),
      );
    });
    bb.on("error", reject);
    bb.on("close", () => inContext({ projectId: project }, async () => {
      try {
        await Promise.all(writes);
        const tags = (fields.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
        const out: Material[] = [];
        for (const f of files) {
          try {
            out.push(await ingestFile(f.tmp, f.name, { date: fields.date, title: files.length === 1 ? fields.title : undefined, annotation: fields.annotation, tags, group: fields.group }));
          } finally {
            fs.rmSync(f.tmp, { force: true });
          }
        }
        resolve(out);
      } catch (err) {
        reject(err);
      }
    }));
    req.pipe(bb);
  });
}

/** Streams the first file of a multipart upload to the cache; the caller deletes it. */
export function receiveSingleFile(req: Request): Promise<{ path: string; name: string }> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 1024 ** 3 } });
    let result: Promise<{ path: string; name: string }> | null = null;
    bb.on("file", (_field, stream, info) => {
      const name = info.filename ?? "upload";
      const dir = path.join(CACHE_DIR, "uploads", "incoming");
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `${newId("up")}${path.extname(name)}`);
      result = new Promise((res, rej) => {
        const out = fs.createWriteStream(tmp);
        stream.pipe(out);
        out.on("finish", () => res({ path: tmp, name }));
        out.on("error", rej);
      });
    });
    bb.on("error", reject);
    bb.on("close", () => (result ? result.then(resolve, reject) : reject(Object.assign(new Error("No file uploaded"), { status: 400 }))));
    req.pipe(bb);
  });
}

export async function removeMaterial(id: string, removeFiles = deletePrefix) {
  return deleteMaterial(projectId(), id, () => removeFiles(`materials/${id}/`));
}


/**
 * Local preview images for the agent, which reads files from disk.
 * Returns one prompt line per material, followed by one line per group with its members in date order.
 */
export async function materialsForAgent(materials: Material[]): Promise<{ lines: string[]; images: string[] }> {
  const lines: string[] = [];
  const images: string[] = [];
  for (const m of materials) {
    let preview = "";
    try {
      preview = await cached(m.previewKey);
      images.push(preview);
    } catch {
      /* preview missing: the annotation still helps */
    }
    const duration = m.durationSeconds ? `, ${m.durationSeconds.toFixed(1)} s` : "";
    lines.push(
      `- ${m.id} (${m.date}, ${m.kind}${duration}) "${m.title}"${m.tags.length ? ` [${m.tags.join(", ")}]` : ""}${m.group ? ` {group "${m.group}"}` : ""}: ${m.annotation || "(no annotation)"}${preview ? `\n  Preview image: ${preview}` : ""}`,
    );
  }
  const groups = new Map<string, Material[]>();
  for (const m of materials) if (m.group) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  const shown = [...groups].filter(([, list]) => list.length > 1);
  if (shown.length) {
    lines.push("Material groups (the developer marked these as belonging together):");
    for (const [name, list] of shown) {
      const ordered = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
      lines.push(`- "${name}": ${ordered.map((m) => m.id).join(", ")}`);
    }
  }
  return { lines, images };
}

export const materialById = async (id: string) => (await getMaterials(projectId(), [id]))[0];
