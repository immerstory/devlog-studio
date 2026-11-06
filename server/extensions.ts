import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./config.js";
import { extensionEntries } from "./extensionPaths.js";
import { installExtension } from "../video/extensions.js";
import type { DevlogExtension } from "../shared/extension.js";

/** Each extension's folder, for the files its theme presets name. */
const folders = new Map<string, string>([["title-card", path.join(ROOT, "examples", "title-card")]]);

export const extensionFolder = (id: string) => folders.get(id);

/** Installs every extension. One that fails to load stops the start, because its bumpers would vanish from videos. */
export async function loadExtensions(log: (line: string) => void = console.log) {
  for (const { dir, entry } of extensionEntries(ROOT)) {
    try {
      const extension = (await import(pathToFileURL(entry).href)).default as DevlogExtension;
      installExtension(extension);
      folders.set(extension.id, dir);
      log(`Extension: ${extension.name}`);
    } catch (err) {
      throw new Error(`The extension in ${dir} failed to load: ${(err as Error).message}`, { cause: err });
    }
  }
}
