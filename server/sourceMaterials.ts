import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { DEFAULT_METADATA_FILE, type MaterialRule, type Source } from "../shared/projects.js";
import { normalizeGroup, ORIGIN_FIELDS, type DateFrom, type InboxFile, type Material, type MaterialOrigin, type OriginField, type PreviewFile, type PreviewState, type RulePreview } from "../shared/types.js";
import { CACHE_DIR } from "./config.js";
import { projectId } from "./context.js";
import { query } from "./db.js";
import { activeSources, matchesGlob, READ_ONLY } from "./discovery.js";
import { localDate } from "./ingress/provider.js";
import { throwIfCancelled } from "./jobs.js";
import { DELETED_SOURCE_FILES, ingestFile, isMediaFile, isVideoFile, type IngestOptions, type MaterialFields } from "./materials.js";
import { deletePrefix } from "./storage.js";
import { getValue, listMaterials, newId, updateMaterial } from "./store.js";

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await run("git", [...READ_ONLY, ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const shared = {
  annotation: z.string().optional(),
  tags: z.array(z.string()).optional(),
  group: z.string().optional(),
  date: z.string().regex(DATE, "is not a YYYY-MM-DD date").optional(),
  commit: z.string().regex(/^[0-9a-f]{4,40}$/i, "is not a commit hash").optional(),
};
/** A folder's metadata file. Other keys are ignored, so the file can hold more than this format. */
export const metadataSchema = z.object({
  folder: z.object(shared).optional(),
  files: z.record(z.string(), z.object({ ...shared, title: z.string().optional(), exclude: z.boolean().optional() })).optional(),
});
export type FolderMetadata = z.infer<typeof metadataSchema>;

/** Reads a metadata file, or throws with what is wrong in it. */
export function parseMetadata(text: string): FolderMetadata {
  let json: unknown;
  try { json = JSON.parse(text); } catch (err) { throw new Error(`not valid JSON: ${(err as Error).message}`); }
  const parsed = metadataSchema.safeParse(json);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "file"} ${i.message}`).join("; "));
  return parsed.data;
}

/** Values of the pattern's placeholders in a path, or null when the path doesn't fit. The pattern matches the end of the path. */
export function patternValues(pattern: string, filePath: string): Record<string, string> | null {
  const keys: string[] = [];
  const source = pattern.split(/(\{\w+\})/).map((part) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!key) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    keys.push(key);
    // An extension has no dots, so a name can have them.
    return key.toLowerCase() === "ext" ? "([^/.]+)" : "([^/]+?)";
  }).join("");
  const m = new RegExp(`(?:^|/)${source}$`, "i").exec(filePath);
  return m ? Object.fromEntries(keys.map((k, i) => [k, m[i + 1]])) : null;
}

const humanize = (name: string) => name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
const baseName = (p: string) => path.posix.basename(p, path.posix.extname(p));

export interface Described {
  fields: Required<Pick<Material, "title" | "annotation" | "tags">> & { group?: string };
  /** Where the date comes from: a date, a commit to look up, or neither, which means the file's first commit. */
  date?: string;
  commit?: string;
}

/**
 * What a rule says about one file, or null when the file is excluded. A file's entry wins over the folder's, and tags
 * of the pattern, the folder and the file are combined.
 */
export function describeFile(rule: MaterialRule, filePath: string, metadata?: FolderMetadata): Described | null {
  const fileEntry = metadata?.files?.[path.posix.basename(filePath)];
  if (fileEntry?.exclude || (rule.listedOnly && !fileEntry)) return null;
  const folder = metadata?.folder;
  const values = rule.pattern ? patternValues(rule.pattern, filePath) ?? {} : {};
  const valueTags = Object.entries(values).filter(([k]) => !["name", "group", "ext"].includes(k.toLowerCase()) && !k.startsWith("_")).map(([, v]) => v);
  const tags = [...new Set([...valueTags, ...(folder?.tags ?? []), ...(fileEntry?.tags ?? [])].map((t) => t.trim()).filter(Boolean))];
  return {
    fields: {
      title: fileEntry?.title?.trim() || humanize(values.name ?? baseName(filePath)),
      annotation: (fileEntry?.annotation ?? folder?.annotation ?? "").trim(),
      tags,
      group: normalizeGroup(fileEntry?.group ?? folder?.group ?? values.group),
    },
    date: fileEntry?.date ?? (fileEntry?.commit ? undefined : folder?.date),
    commit: fileEntry?.date ? undefined : fileEntry?.commit ?? (folder?.date ? undefined : folder?.commit),
  };
}

/** True when the rule imports this path. Only images and videos qualify. */
export const ruleMatches = (rule: MaterialRule, filePath: string) =>
  isMediaFile(filePath) && rule.include.length > 0 && matchesGlob(filePath, rule.include) && !matchesGlob(filePath, rule.exclude ?? []);

/** The fields the developer changed between two versions of an imported material, added to those changed before. */
export function editedFields(before: Material, after: Material): OriginField[] {
  const edited = new Set(before.origin?.edited ?? []);
  for (const field of ORIGIN_FIELDS) if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) edited.add(field);
  return ORIGIN_FIELDS.filter((f) => edited.has(f));
}

/** Records the developer's edits on an imported material, so that later imports keep them. */
export function withEdits(before: Material, after: Material): Material {
  if (!before.origin) return after;
  const edited = editedFields(before, after);
  return { ...after, origin: { ...before.origin, ...(edited.length ? { edited } : {}) } };
}

const valuesHash = (fields: MaterialFields) => crypto.createHash("sha256").update(JSON.stringify(ORIGIN_FIELDS.map((f) => fields[f] ?? null))).digest("hex").slice(0, 16);

/**
 * Writes a process's output to a file. It waits for both the exit and the closed file, which can come in either order:
 * a busy server can see the process exit after the file is closed.
 */
export function writeOutput(child: ChildProcess, file: string, what: string): Promise<void> {
  const out = fs.createWriteStream(file);
  let err = "";
  child.stderr?.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  const written = new Promise<void>((resolve, reject) => { out.on("close", resolve); out.on("error", reject); });
  child.stdout!.pipe(out);
  return Promise.all([exited, written]).then(([code]) => { if (code !== 0) throw new Error(`${what} failed: ${err.trim()}`); });
}

/** Writes a blob to a file without holding it in memory. */
const writeBlob = (cwd: string, blob: string, file: string) =>
  writeOutput(spawn("git", [...READ_ONLY, "cat-file", "blob", blob], { cwd, windowsHide: true }), file, "git cat-file");

interface TreeFile { blob: string; size: number }
/** Committed files of a source, with their blobs and sizes. */
async function committedFiles(source: Source): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  for (const entry of (await git(source.path, ["ls-tree", "-r", "-l", "-z", "HEAD"])).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [, type, blob, size] = entry.slice(0, tab).trim().split(/\s+/);
    if (type === "blob") files.set(entry.slice(tab + 1), { blob, size: Number(size) });
  }
  return files;
}

/** The time each of these files was first committed. Only their folders' history is read. */
async function firstCommits(source: Source, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const folders = [...new Set(paths.map((p) => path.posix.dirname(p)))];
  for (let i = 0; i < folders.length; i += 100) {
    let at = "";
    const specs = folders.slice(i, i + 100).map((f) => `:(literal)${f}`);
    // Newest first, so the last time seen for a path is its first commit.
    for (const line of (await git(source.path, ["-c", "core.quotePath=false", "log", "--diff-filter=A", "--no-renames", "--format=@@%aI", "--name-only", "--", ...specs])).split("\n")) {
      if (line.startsWith("@@")) at = line.slice(2);
      else if (line) out.set(line, at);
    }
  }
  return out;
}

/** Looks up commits in the project's active sources. */
function commitDates() {
  const known = new Map<string, Promise<string | undefined>>();
  return (hash: string) => {
    if (!known.has(hash)) known.set(hash, (async () => {
      for (const source of activeSources()) {
        try { return localDate((await git(source.path, ["show", "-s", "--format=%aI", `${hash}^{commit}`, "--"])).trim()); } catch { /* not in this source */ }
      }
      return undefined;
    })());
    return known.get(hash)!;
  };
}

/** A Git LFS pointer is a small text file in place of the content. */
const LFS_POINTER = "version https://git-lfs";

/** One file a rule matches, as the import and the preview see it. */
export interface MatchedFile {
  sourceId: string;
  ruleId: string;
  path: string;
  blob: string;
  fields: InboxFile["fields"];
  dateFrom: DateFrom;
}

export interface SourceMatch {
  files: MatchedFile[];
  /** Every committed path, so a moved file can be told from a copy. */
  paths: Set<string>;
  /** Files a rule matches that this run leaves alone: those in a folder with an invalid metadata file, and Git LFS pointers. */
  held: string[];
  errors: string[];
}

/** The files the rules of one source import, with their resolved fields. Problems in metadata files skip their folder. */
export async function matchSourceFiles(source: Source, log: (line: string) => void = () => {}): Promise<SourceMatch> {
  const rules = source.materialRules ?? [];
  const errors: string[] = [];
  if (!rules.some((r) => r.include.length)) return { files: [], paths: new Set(), held: [], errors };
  const tree = await committedFiles(source);
  // A metadata file per folder: undefined when there is none, null when it is invalid, which skips the folder.
  const metadata = new Map<string, FolderMetadata | null | undefined>();
  const readMetadata = async (rule: MaterialRule, folder: string): Promise<FolderMetadata | null | undefined> => {
    const name = rule.metadataFile ?? DEFAULT_METADATA_FILE;
    if (!name) return undefined;
    const file = folder === "." ? name : `${folder}/${name}`;
    if (!metadata.has(file)) {
      const entry = tree.get(file);
      let parsed: FolderMetadata | null | undefined;
      if (entry) {
        try { parsed = parseMetadata(await git(source.path, ["cat-file", "blob", entry.blob])); }
        catch (err) {
          parsed = null;
          errors.push(`${source.label}: ${file} ${(err as Error).message}. The import leaves its folder as it is until the file is fixed.`);
          log(errors.at(-1)!);
        }
      }
      metadata.set(file, parsed);
    }
    return metadata.get(file);
  };
  const held: string[] = [];
  const pointers: string[] = [];
  const pending: Array<{ rule: MaterialRule; filePath: string; blob: string; described: Described }> = [];
  for (const [filePath, entry] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
    const rule = rules.find((r) => ruleMatches(r, filePath));
    if (!rule) continue;
    const meta = await readMetadata(rule, path.posix.dirname(filePath));
    if (meta === null) { held.push(filePath); continue; }
    const described = describeFile(rule, filePath, meta);
    if (!described) continue;
    if (entry.size < 1024 && (await git(source.path, ["cat-file", "blob", entry.blob])).startsWith(LFS_POINTER)) {
      held.push(filePath);
      pointers.push(filePath);
      continue;
    }
    pending.push({ rule, filePath, blob: entry.blob, described });
  }
  if (pointers.length) {
    errors.push(`${source.label}: ${pointers.length} matched file${pointers.length === 1 ? " is a Git LFS pointer" : "s are Git LFS pointers"}, such as ${pointers[0]}. The import reads committed content only, so it leaves them out.`);
    log(errors.at(-1)!);
  }
  const lookUp = commitDates();
  const dated = await Promise.all(pending.map(async (p) => {
    const date = p.described.date ?? (p.described.commit ? await lookUp(p.described.commit) : undefined);
    if (!p.described.date && p.described.commit && !date) log(`${source.label}: commit ${p.described.commit} for ${p.filePath} isn't in any active source, so the file's first commit dates it.`);
    return { ...p, date, dateFrom: (p.described.date ? "metadata" : date ? "commit" : "first-commit") as MatchedFile["dateFrom"] };
  }));
  const undated = dated.filter((d) => !d.date).map((d) => d.filePath);
  const first = undated.length ? await firstCommits(source, undated) : new Map<string, string>();
  const files = dated.map((d): MatchedFile => {
    const at = first.get(d.filePath);
    const date = d.date ?? (at ? localDate(at) : localDate(new Date()));
    return { sourceId: source.id, ruleId: d.rule.id, path: d.filePath, blob: d.blob, fields: { ...d.described.fields, date }, dateFrom: d.dateFrom };
  });
  return { files, paths: new Set(tree.keys()), held, errors };
}

export interface ImportIO {
  ingest: (file: string, fileName: string, fields: MaterialFields, options: IngestOptions) => Promise<Material>;
  removeFiles: (prefix: string) => Promise<void>;
}
const storageIO: ImportIO = { ingest: ingestFile, removeFiles: deletePrefix };

export interface ImportResult { added: number; updated: number; moved: number; removed: number; skipped: number; inbox: number; errors: string[] }

/** The fields from the source, except those the developer edited, which keep their stored value. */
const merged = (m: Material, fields: MaterialFields): Material => {
  const edited = new Set(m.origin?.edited ?? []);
  const next = { ...m } as Material & Record<string, unknown>;
  for (const f of ORIGIN_FIELDS) if (!edited.has(f)) next[f] = fields[f] as never;
  return next;
};

const fileKey = (sourceId: string, filePath: string) => `${sourceId}:${filePath}`;
const splitKey = (key: string) => ({ sourceId: key.slice(0, key.indexOf(":")), path: key.slice(key.indexOf(":") + 1) });
const folderOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);

/** Imports of one project run one at a time, so two of them never store one file twice. */
const queues = new Map<string, Promise<unknown>>();
export function oneImportAtATime<T>(pid: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(pid) ?? Promise.resolve()).catch(() => {}).then(work);
  const tail = next.catch(() => {});
  queues.set(pid, tail);
  void tail.then(() => { if (queues.get(pid) === tail) queues.delete(pid); });
  return next;
}

/**
 * Stores a file of a source as a new material, or as a new version of an existing one. The files of a version have a
 * folder of their own. A material deleted meanwhile stays deleted, and the folder that is no longer used is removed.
 */
async function storeFile(source: Source, file: Pick<MatchedFile, "ruleId" | "path" | "blob" | "fields">, existing: Material | undefined, io: ImportIO, log: (line: string) => void, edits?: { fields: MaterialFields; edited: OriginField[] }): Promise<Material | undefined> {
  const pid = projectId();
  const origin: MaterialOrigin = { sourceId: source.id, ruleId: file.ruleId, path: file.path, blob: file.blob, values: valuesHash(file.fields), ...(edits?.edited.length ? { edited: edits.edited } : {}) };
  const tmp = path.join(CACHE_DIR, "uploads", "incoming", `${newId("src")}${path.extname(file.path)}`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  try {
    await writeBlob(source.path, file.blob, tmp);
    const version = file.blob.slice(0, 12);
    if (!existing) return await io.ingest(tmp, path.posix.basename(file.path), { ...file.fields, ...edits?.fields, origin }, { version });
    const stored = await io.ingest(tmp, path.posix.basename(file.path), { ...file.fields, origin }, { id: existing.id, createdAt: existing.createdAt, version, save: false });
    let old: Material | undefined;
    const saved = await updateMaterial(pid, existing.id, (current) => {
      old = current;
      return current ? keepEdits(stored, current, file.fields, origin) : undefined;
    });
    const unused = saved ? old && folderOf(old.key) !== folderOf(saved.key) ? folderOf(old.key) : undefined : folderOf(stored.key);
    if (unused) await io.removeFiles(unused).catch(() => log(`Some unused files of ${file.path} could not be removed.`));
    return saved;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A new version of a material: the stored files of `next`, the source's fields where the developer didn't edit them. */
function keepEdits(next: Material, current: Material, fields: MaterialFields, origin: MaterialOrigin): Material {
  const edited = current.origin?.edited ?? [];
  return merged({ ...next, ...Object.fromEntries(edited.map((f) => [f, current[f]])), origin: { ...origin, ...(edited.length ? { edited } : {}) } }, fields);
}

/** Changes a stored material's fields and origin, unless it was deleted meanwhile. */
const refresh = (pid: string, id: string, fields: MaterialFields, origin: Partial<MaterialOrigin>) =>
  updateMaterial(pid, id, (current) => (current?.origin ? merged({ ...current, origin: { ...current.origin, ...origin, removed: undefined } }, fields) : undefined));

export const inboxFileId = (sourceId: string, filePath: string) => `sf-${crypto.createHash("sha256").update(fileKey(sourceId, filePath)).digest("hex").slice(0, 32)}`;
const inboxRows = async (pid: string) => (await query<{ data: InboxFile }>("SELECT data FROM source_files WHERE project_id = $1 ORDER BY data->>'path'", [pid])).map((r) => r.data);
/** Inbox files of the project's active sources. */
export const listInboxFiles = async (pid: string) => {
  const active = new Set(activeSources().map((s) => s.id));
  return (await inboxRows(pid)).filter((f) => active.has(f.sourceId));
};
const saveInboxFile = (pid: string, f: InboxFile) =>
  query("INSERT INTO source_files (project_id, id, data) VALUES ($1, $2, $3) ON CONFLICT (project_id, id) DO UPDATE SET data = $3", [pid, f.id, f]);
const deleteInboxFile = (pid: string, id: string) => query("DELETE FROM source_files WHERE project_id = $1 AND id = $2", [pid, id]);
/** True when the stored row already says what the import would store. */
const sameInboxFile = (a: InboxFile, b: InboxFile) => a.blob === b.blob && a.ruleId === b.ruleId && a.kind === b.kind && a.status === b.status && valuesHash(a.fields) === valuesHash(b.fields);

const DUPLICATES_LOGGED = 5;

/**
 * Imports the files that the material rules of all active sources match. A file is stored again only when its blob
 * changes. A file with the content of another imported file or inbox file is skipped, unless that file left the same
 * source: then its material or inbox file moves to the new path. A material whose file leaves the source or no longer
 * matches a rule stays, marked as removed. A material the developer deleted isn't imported again from its path, and a
 * dismissed inbox file stays dismissed while it is in the source. An inbox rule's new files wait in the inbox; a file
 * it already imported stays a material and follows the source.
 */
export function importSourceMaterials(log: (line: string) => void = () => {}, io: ImportIO = storageIO): Promise<ImportResult> {
  const pid = projectId();
  return oneImportAtATime(pid, () => runImport(pid, log, io));
}

async function runImport(pid: string, log: (line: string) => void, io: ImportIO): Promise<ImportResult> {
  const result: ImportResult = { added: 0, updated: 0, moved: 0, removed: 0, skipped: 0, inbox: 0, errors: [] };
  const imported = (await listMaterials(pid)).filter((m) => m.origin);
  const waiting = await inboxRows(pid);
  const sources = activeSources().filter((s) => s.materialRules?.some((r) => r.include.length) || imported.some((m) => m.origin!.sourceId === s.id) || waiting.some((f) => f.sourceId === s.id));
  if (!sources.length) return result;
  const byPath = new Map(imported.map((m) => [fileKey(m.origin!.sourceId, m.origin!.path), m]));
  const inbox = new Map(waiting.map((f) => [fileKey(f.sourceId, f.path), f]));
  const blobs = new Map([...waiting.map((f) => [f.blob, fileKey(f.sourceId, f.path)] as const), ...imported.map((m) => [m.origin!.blob, fileKey(m.origin!.sourceId, m.origin!.path)] as const)]);
  const deleted = new Set((await getValue<string[]>(pid, DELETED_SOURCE_FILES)) ?? []);
  for (const source of sources) {
    let match: SourceMatch;
    try {
      match = await matchSourceFiles(source, log);
      result.errors.push(...match.errors);
    } catch (err) {
      const message = `${source.label}: ${(err as Error).message}`;
      result.errors.push(message);
      log(message);
      continue;
    }
    const toInbox = new Set((source.materialRules ?? []).filter((r) => r.importTo === "inbox").map((r) => r.id));
    const seen = new Set(match.held.map((p) => fileKey(source.id, p)));
    for (const file of match.files) {
      throwIfCancelled();
      const key = fileKey(source.id, file.path);
      seen.add(key);
      const waitingFile = inbox.get(key);
      if (deleted.has(key) || waitingFile?.status === "dismissed") continue;
      const existing = byPath.get(key);
      const twin = blobs.get(file.blob);
      try {
        if (!existing && !waitingFile && twin && twin !== key) {
          const from = splitKey(twin);
          const movable = from.sourceId === source.id && !match.paths.has(from.path);
          const moving = byPath.get(twin);
          const movingInbox = inbox.get(twin);
          if (movable && moving) {
            const moved = await refresh(pid, moving.id, file.fields, { path: file.path, ruleId: file.ruleId, values: valuesHash(file.fields) });
            if (moved) {
              byPath.delete(twin);
              byPath.set(key, moved);
              blobs.set(file.blob, key);
              result.moved++;
              log(`Moved ${from.path} to ${file.path}.`);
              continue;
            }
          } else if (movable && movingInbox) {
            const next: InboxFile = { ...movingInbox, id: inboxFileId(source.id, file.path), ruleId: file.ruleId, path: file.path, fields: file.fields };
            await saveInboxFile(pid, next);
            await deleteInboxFile(pid, movingInbox.id);
            inbox.delete(twin);
            inbox.set(key, next);
            blobs.set(file.blob, key);
            result.moved++;
            log(`Moved ${from.path} to ${file.path} in the inbox.`);
            continue;
          }
          if (result.skipped++ < DUPLICATES_LOGGED) log(`Skipped ${source.label}: ${file.path}, because ${from.path} has the same content.`);
          continue;
        }
        if (!existing && toInbox.has(file.ruleId)) {
          const next: InboxFile = { id: inboxFileId(source.id, file.path), sourceId: source.id, ruleId: file.ruleId, path: file.path, blob: file.blob, kind: isVideoFile(file.path) ? "video" : "image", fields: file.fields, status: "inbox" };
          if (waitingFile && sameInboxFile(waitingFile, next)) continue;
          await saveInboxFile(pid, next);
          if (!waitingFile) result.inbox++;
          inbox.set(key, next);
          blobs.set(file.blob, key);
          continue;
        }
        if (existing && existing.origin!.blob === file.blob) {
          const values = valuesHash(file.fields);
          if (existing.origin!.values === values && existing.origin!.ruleId === file.ruleId && !existing.origin!.removed) continue;
          if (await refresh(pid, existing.id, file.fields, { ruleId: file.ruleId, values })) result.updated++;
          continue;
        }
        const stored = await storeFile(source, file, existing, io, log);
        if (!stored) continue;
        if (existing) result.updated++;
        else result.added++;
        if (waitingFile) {
          await deleteInboxFile(pid, waitingFile.id);
          inbox.delete(key);
        }
        byPath.set(key, stored);
        blobs.set(file.blob, key);
      } catch (err) {
        const message = `${source.label}: ${file.path}: ${(err as Error).message}`;
        result.errors.push(message);
        log(message);
      }
    }
    for (const m of imported.filter((x) => x.origin!.sourceId === source.id && byPath.get(fileKey(source.id, x.origin!.path))?.id === x.id && !seen.has(fileKey(source.id, x.origin!.path)))) {
      const marked = await updateMaterial(pid, m.id, (current) => (current?.origin && !current.origin.removed && current.origin.path === m.origin!.path ? { ...current, origin: { ...current.origin, removed: true } } : undefined));
      if (marked) result.removed++;
    }
    // A waiting file leaves the inbox when it no longer matches; a dismissed one only when it leaves the source.
    for (const f of [...inbox.values()].filter((x) => x.sourceId === source.id && !seen.has(fileKey(source.id, x.path)))) {
      if (f.status === "dismissed" && match.paths.has(f.path)) continue;
      await deleteInboxFile(pid, f.id);
      inbox.delete(fileKey(source.id, f.path));
    }
  }
  if (result.skipped > DUPLICATES_LOGGED) log(`Skipped ${result.skipped - DUPLICATES_LOGGED} more files with the same content as another.`);
  log(`Materials from sources: ${result.added} added, ${result.inbox} new in the inbox, ${result.updated} updated, ${result.moved} moved, ${result.removed} no longer in their source, ${result.skipped} skipped as duplicates.`);
  return result;
}

const notInInbox = () => Object.assign(new Error("This file is no longer in the inbox."), { status: 404 });
async function loadInboxFile(pid: string, id: string): Promise<{ file: InboxFile; source: Source }> {
  const file = (await query<{ data: InboxFile }>("SELECT data FROM source_files WHERE project_id = $1 AND id = $2", [pid, id]))[0]?.data;
  const source = file && activeSources().find((s) => s.id === file.sourceId);
  if (!file || !source) throw notInInbox();
  return { file, source };
}

/** The committed content of an inbox file as a local file, kept by blob, so the browser can load parts of it. */
export async function inboxFilePath(id: string): Promise<{ file: string; blob: string }> {
  const { file, source } = await loadInboxFile(projectId(), id);
  const dir = path.join(CACHE_DIR, "source-files");
  const local = path.join(dir, `${file.blob}${path.posix.extname(file.path).toLowerCase()}`);
  if (!fs.existsSync(local)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${local}.${newId("part")}`;
    try {
      await writeBlob(source.path, file.blob, tmp);
      fs.renameSync(tmp, local);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return { file: local, blob: file.blob };
}

/** Dismissing keeps the row, so later imports don't bring the file back while it is in the source. */
export function setInboxFileStatus(id: string, status: InboxFile["status"]): Promise<InboxFile> {
  const pid = projectId();
  return oneImportAtATime(pid, async () => {
    const { file } = await loadInboxFile(pid, id);
    const next = { ...file, status };
    await saveInboxFile(pid, next);
    return next;
  });
}

/**
 * Makes inbox files materials that follow their source. Fields given here count as the developer's edits, so later
 * imports keep them. It waits for a running import, so the import can't put an added file back in the inbox.
 */
export function addInboxFiles(ids: string[], fields: Partial<InboxFile["fields"]> = {}, log: (line: string) => void = () => {}, io: ImportIO = storageIO): Promise<Material[]> {
  const pid = projectId();
  return oneImportAtATime(pid, async () => {
    const added: Material[] = [];
    for (const id of ids) {
      throwIfCancelled();
      const { file, source } = await loadInboxFile(pid, id);
      const edited = ORIGIN_FIELDS.filter((f) => f in fields && JSON.stringify(fields[f] ?? null) !== JSON.stringify(file.fields[f] ?? null));
      const material = await storeFile(source, file, undefined, io, log, { fields: Object.fromEntries(edited.map((f) => [f, fields[f]])), edited });
      await deleteInboxFile(pid, id);
      fs.rmSync(path.join(CACHE_DIR, "source-files", `${file.blob}${path.posix.extname(file.path).toLowerCase()}`), { force: true });
      log(`Added ${file.path}.`);
      if (material) added.push(material);
    }
    return added;
  });
}

/** Files the preview lists; the total counts all of them. */
export const PREVIEW_LIMIT = 500;

/** Matches rules against a saved source without importing anything. The rules may be unsaved. */
export async function previewRules(sourceId: string, rules: MaterialRule[], log: (line: string) => void = () => {}): Promise<RulePreview> {
  const pid = projectId();
  const source = activeSources().find((s) => s.id === sourceId);
  if (!source) throw Object.assign(new Error("Save the source first, then preview its rules."), { status: 400 });
  const found = await matchSourceFiles({ ...source, materialRules: rules }, log);
  const materials = new Map((await listMaterials(pid)).filter((m) => m.origin).map((m) => [fileKey(m.origin!.sourceId, m.origin!.path), m]));
  const inbox = new Map((await listInboxFiles(pid)).map((f) => [fileKey(f.sourceId, f.path), f]));
  const deleted = new Set((await getValue<string[]>(pid, DELETED_SOURCE_FILES)) ?? []);
  const blobs = new Map<string, string>();
  for (const m of materials.values()) blobs.set(m.origin!.blob, fileKey(m.origin!.sourceId, m.origin!.path));
  for (const f of inbox.values()) if (!blobs.has(f.blob)) blobs.set(f.blob, fileKey(f.sourceId, f.path));
  const matchesPerRule = Object.fromEntries(rules.map((r) => [r.id, 0]));
  const toInbox = new Set(rules.filter((r) => r.importTo === "inbox").map((r) => r.id));
  const files = found.files.map((file): PreviewFile => {
    const key = fileKey(source.id, file.path);
    matchesPerRule[file.ruleId]++;
    const twin = blobs.get(file.blob);
    const moves = !!twin && splitKey(twin).sourceId === source.id && !found.paths.has(splitKey(twin).path);
    const state: PreviewState = deleted.has(key) ? "deleted"
      : materials.has(key) ? "material"
      : inbox.get(key)?.status === "dismissed" ? "dismissed"
      : inbox.has(key) ? "inbox"
      : twin && twin !== key ? (moves ? "moved" : "duplicate")
      : toInbox.has(file.ruleId) ? "new-inbox" : "new";
    if (!twin) blobs.set(file.blob, key);
    return { path: file.path, ruleId: file.ruleId, fields: file.fields, dateFrom: file.dateFrom, state };
  });
  log(`${files.length} file(s) match.`);
  return { total: files.length, files: files.slice(0, PREVIEW_LIMIT), matchesPerRule, errors: found.errors };
}
