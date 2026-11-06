import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { putFile } from "./storage.js";
import type { ThemeAsset } from "../shared/bumpers.js";

/** Accepted file types per kind of theme upload, with the content type Garage serves them with. */
const KINDS = {
  font: { ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2" },
  image: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" },
} as const;
export type ThemeFileKind = keyof typeof KINDS;
export const isThemeFileKind = (k: unknown): k is ThemeFileKind => k === "font" || k === "image";

/**
 * Stores a font or image for a project's theme under projects/<id>/theme/assets/. The theme references
 * the returned asset once it is saved; project deletion removes the whole prefix.
 */
export async function storeThemeFile(projectId: string, kind: ThemeFileKind, file: string, name: string): Promise<ThemeAsset> {
  const ext = path.extname(name).toLowerCase();
  const contentType = (KINDS[kind] as Record<string, string>)[ext];
  if (!contentType) throw Object.assign(new Error(`Choose a ${Object.keys(KINDS[kind]).join(", ")} file.`), { status: 400 });
  if (!fs.statSync(file).size) throw Object.assign(new Error("The file is empty."), { status: 400 });
  const safe = path.basename(name).replace(/[^\w.\- ]+/g, "_");
  const key = `projects/${projectId}/theme/assets/${crypto.randomUUID()}/${safe}`;
  await putFile(key, file, contentType);
  return { key, name: path.basename(name) };
}
