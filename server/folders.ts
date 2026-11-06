import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FolderEntry {
  name: string;
  path: string;
  /** The folder holds a `.git` entry, so it is the top of a Git working copy. */
  git: boolean;
  /** The folder holds `Assets` and `ProjectSettings`, so it is a Unity project. */
  unity: boolean;
}
export interface FolderListing {
  path: string;
  parent: string | null;
  /** Top of the Git working copy this folder is in; null outside of one. */
  repo: string | null;
  unity: boolean;
  /** Drives on Windows, `/` elsewhere. */
  roots: string[];
  folders: FolderEntry[];
  /** Files that can be run directly; empty unless requested. */
  executables: Array<{ name: string; path: string }>;
}
export interface FolderOptions {
  /** Also list the executable files of the folder. */
  executables?: boolean;
  /** Also list folders whose names start with a dot. */
  hidden?: boolean;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);
const isUnityProject = async (folder: string) => (await exists(path.join(folder, "Assets"))) && (await exists(path.join(folder, "ProjectSettings")));
const concealed = (name: string, options: FolderOptions) => name === ".git" || name.startsWith("$") || name === "System Volume Information" || (name.startsWith(".") && !options.hidden);

async function roots(): Promise<string[]> {
  if (process.platform !== "win32") return ["/"];
  const drives = [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((letter) => `${letter}:\\`);
  const found = await Promise.all(drives.map(exists));
  return drives.filter((_, i) => found[i]);
}

async function repoOf(folder: string): Promise<string | null> {
  for (let at = folder; ; at = path.dirname(at)) {
    if (await exists(path.join(at, ".git"))) return at;
    if (path.dirname(at) === at) return null;
  }
}

/** Node starts only real programs without a shell, so batch files do not count on Windows. */
async function isExecutable(file: string, name: string): Promise<boolean> {
  if (process.platform === "win32") return /\.(exe|com)$/i.test(name);
  return fs.stat(file).then((s) => s.isFile() && (s.mode & 0o111) !== 0, () => false);
}

/** The contents of a folder on this computer, for the path picker; the home folder without a path. */
export async function listFolders(requested?: string, options: FolderOptions = {}): Promise<FolderListing> {
  const folder = path.resolve(requested?.trim() || os.homedir());
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    const reason = e.code === "ENOENT" ? "does not exist" : e.code === "ENOTDIR" ? "is not a folder" : "cannot be read";
    throw Object.assign(new Error(`${folder} ${reason}.`), { status: 400 });
  });
  const named = entries.filter((e) => !concealed(e.name, options));
  const isFolder = await Promise.all(named.map(async (e) => e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(path.join(folder, e.name)).then((s) => s.isDirectory(), () => false)))));
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const folders = await Promise.all(
    named.filter((_, i) => isFolder[i]).map(async (e) => {
      const full = path.join(folder, e.name);
      return { name: e.name, path: full, git: await exists(path.join(full, ".git")), unity: await isUnityProject(full) };
    }),
  );
  const files = options.executables ? named.filter((_, i) => !isFolder[i]).map((e) => ({ name: e.name, path: path.join(folder, e.name) })) : [];
  const runnable = await Promise.all(files.map((f) => isExecutable(f.path, f.name)));
  const parent = path.dirname(folder);
  return {
    path: folder,
    parent: parent === folder ? null : parent,
    repo: await repoOf(folder),
    unity: await isUnityProject(folder),
    roots: await roots(),
    folders: folders.sort(byName),
    executables: files.filter((_, i) => runnable[i]).sort(byName),
  };
}
