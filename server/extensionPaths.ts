import fs from "node:fs";
import path from "node:path";

/** Folders that hold extensions. DEVLOG_EXTENSIONS_DIR lists them, separated like PATH; relative ones count from `root`. */
export function extensionRoots(root: string, value = process.env.DEVLOG_EXTENSIONS_DIR): string[] {
  return (value || "extensions").split(path.delimiter).filter(Boolean).map((dir) => path.resolve(root, dir));
}

/** One entry per subfolder with an `index.ts`, in name order within each root. */
export function extensionEntries(root: string, value?: string): Array<{ dir: string; entry: string }> {
  return extensionRoots(root, value).flatMap((parent) => {
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).sort()
      .map((name) => ({ dir: path.join(parent, name), entry: path.join(parent, name, "index.ts") }))
      .filter(({ entry }) => fs.existsSync(entry));
  });
}
