import { currentContext, inContext } from "./context.js";
import { commitUrl } from "./ingress/forge.js";
import type { CommitInfo } from "../shared/types.js";
import { getProject } from "./projects.js";
import type { Source } from "../shared/projects.js";
export const activeSources = () => getProject().settings.sources.filter((s) => !s.archived);
export function currentSource(): Source {
  const p = getProject().settings;
  const source = p.sources.find((s) => s.id === (currentContext().sourceId ?? p.primarySourceId));
  if (!source) throw new Error("Source not found");
  return source;
}
export const commitRef = (c: { sourceId: string; hash: string }) => `${c.sourceId}:${c.hash}`;
export const latestSnapshotTime = (snapshots?: Record<string, Snapshot>) => Object.values(snapshots ?? {}).map((s) => s.takenAt).sort().at(-1);
export function mergeCommits(lists: CommitEvidence[][]): CommitEvidence[] {
  return lists.flat().sort((a, b) => a.date.localeCompare(b.date) || a.sourceId.localeCompare(b.sourceId) || a.hash.localeCompare(b.hash));
}
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

async function git(args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  const { stdout } = await run("git", args, { cwd: currentSource().path, maxBuffer, windowsHide: true });
  return stdout;
}

/** Runs git with data on stdin; avoids Windows command-line length limits for long path lists. */
function gitStdin(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: currentSource().path, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} failed: ${err}`))));
    child.stdin.end(input);
  });
}

export interface CommitEvidence {
  sourceId: string;
  sourceLabel: string;
  hash: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ path: string; added: number; removed: number }>;
  /** GameObject names added in scene/prefab files. */
  addedObjects: string[];
}

export interface WorkingChange {
  sourceId: string;
  sourceLabel: string;
  path: string;
  status: string;
  blob: string;
  addedObjects: string[];
}

export interface Evidence {
  range: { since: string; fromCommit?: string; toCommit: string };
  sources?: Array<{ id: string; label: string; path: string }>;
  commits: CommitEvidence[];
  /** Uncommitted content changes that differ from the previous check. */
  workingChanges: WorkingChange[];
  notes: Array<{ date: string; text: string }>;
  /** Prompt lines describing uploaded materials. */
  materials: string[];
}

export interface Snapshot {
  commit: string;
  takenAt: string;
  /** path -> blob hash of uncommitted files at the time of the check. */
  dirty: Record<string, string>;
}

const SCENE_FILE = /\.(unity|prefab)$/i;

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

/** True when the path matches one of the globs. A glob without a slash matches the file name in any folder. */
export const matchesGlob = (path: string, globs: string[]) => globs.some((g) => globToRegex(g).test(path));

/** A commit that changes only feed files is the feed's delivery, not work on the project. */
export const isFeedCommit = (files: Array<{ path: string }>, feedGlobs: string[] = []) => feedGlobs.length > 0 && files.length > 0 && files.every((f) => matchesGlob(f.path, feedGlobs));

function isContent(path: string): boolean {
  return currentSource().contentGlobs.some((g) => globToRegex(g).test(path));
}

/** Names of GameObjects added in a unified diff of Unity YAML. */
function addedNames(diff: string, cap = 40): string[] {
  const names = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^\+\s+m_Name:\s*(.+)$/.exec(line);
    if (m && m[1].trim()) names.add(m[1].trim());
    if (names.size >= cap) break;
  }
  return [...names];
}

async function commitAddedObjects(hash: string, files: string[]): Promise<string[]> {
  const scenes = files.filter((f) => SCENE_FILE.test(f)).slice(0, 6);
  if (!scenes.length) return [];
  const diff = await git(["show", "-U0", "--format=", hash, "--", ...scenes]).catch(() => "");
  return addedNames(diff);
}

/** Commits for git log range arguments, with changed files and GameObjects added to scenes/prefabs. */
export async function collectCommits(rangeArgs: string[], withObjects = true): Promise<CommitEvidence[]> {
  if (!currentContext().sourceId) return mergeCommits(await Promise.all(activeSources().map((source) => inContext({ sourceId: source.id }, () => collectCommits(rangeArgs, withObjects)))));
  const SEP = "\u001e";
  const log = await git(["log", ...rangeArgs, "--no-merges", "--date=iso-strict", `--format=${SEP}%H%x1f%ad%x1f%s%x1f%b%x1f`, "--numstat"]);
  const commits: CommitEvidence[] = [];
  for (const chunk of log.split(SEP).filter((c) => c.trim())) {
    const [hash, date, subject, body, rest] = chunk.split("\u001f");
    const files = (rest ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [a, r, ...p] = l.split("\t");
        return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 };
      });
    if (isFeedCommit(files, currentSource().feedGlobs)) continue;
    commits.push({ sourceId: currentSource().id, sourceLabel: currentSource().label, hash, date, subject, body: body.trim().slice(0, 2000), files: files.slice(0, 80), addedObjects: [] });
  }
  if (withObjects) for (const c of commits.slice(0, 60)) c.addedObjects = await commitAddedObjects(c.hash, c.files.map((f) => f.path));

  return commits;
}

/** Commits whose author date lies within [from, to] (YYYY-MM-DD, inclusive). */
/** Commits of one day for display: no scene-diff analysis, so it stays fast. */
export async function listCommitsOn(date: string) {
  return mergeCommits(await Promise.all(getProject().settings.sources.map((source) =>
    inContext({ sourceId: source.id }, async () => {
      try {
        const commits = await collectCommits([`--since=${date}T00:00:00`, `--until=${date}T23:59:59`], false);
        return commits.map((c) => ({ ...c, sourceLabel: source.label + (source.archived ? " (archived)" : "") }));
      } catch (error) { if (source.archived) return []; throw error; }
    }))));
}

/** Specific commits with full evidence, for writing a suggestion from them. */
export async function commitsByHash(refs: string[]) {
  const results: CommitEvidence[][] = [];
  for (const ref of refs) {
    const [sourceId, hash] = ref.split(":");
    if (!getProject().settings.sources.some((s) => s.id === sourceId) || !/^[a-f0-9]{7,40}$/i.test(hash ?? "")) throw new Error("Invalid source or commit reference");
    results.push(await inContext({ sourceId }, () => collectCommits(["--no-walk=sorted", hash])));
  }
  return mergeCommits(results);
}

const COMMIT_REF = /^(?:([a-zA-Z0-9-]+):)?([0-9a-f]{7,40})$/i;

/** Subjects, messages and web links for commit references. A bare hash is looked up in every source; references that match nothing keep what they can. */
export async function commitDetails(refs: string[]): Promise<CommitInfo[]> {
  const wanted = refs.flatMap((ref) => {
    const match = COMMIT_REF.exec(ref);
    return match ? [{ ref, sourceId: match[1], hash: match[2].toLowerCase() }] : [];
  });
  const details = new Map<string, CommitInfo>(wanted.map((w) => [w.ref, { ref: w.ref, hash: w.hash }]));
  for (const source of getProject().settings.sources) {
    const here = wanted.filter((w) => !w.sourceId || w.sourceId === source.id);
    if (!here.length) continue;
    await inContext({ sourceId: source.id }, async () => {
      const remote = await git(["remote", "get-url", "origin"]).catch(() => "");
      const log = await gitStdin(["log", "--no-walk=unsorted", "--ignore-missing", "--stdin", "--format=%H%x1f%s%x1f%b%x1e"], `${[...new Set(here.map((w) => w.hash))].join("\n")}\n`).catch(() => "");
      const commits = log.split("\x1e").map((entry) => entry.trim().split("\x1f")).filter(([hash]) => hash);
      for (const w of here) {
        const commit = commits.find(([hash]) => hash.startsWith(w.hash));
        if (commit) {
          const [hash, subject, body] = commit;
          details.set(w.ref, { ref: w.ref, hash, subject, message: body?.trim() ? `${subject}\n\n${body.trim()}` : subject, url: commitUrl(remote, hash) });
        } else if (w.sourceId) {
          details.set(w.ref, { ref: w.ref, hash: w.hash, url: commitUrl(remote, w.hash) });
        }
      }
    });
  }
  return [...details.values()];
}

/** Number of commits per day (YYYY-MM-DD) within [from, to]. */
export async function commitCounts(from: string, to: string): Promise<Record<string, number>> {
  if (!currentContext().sourceId) {
    const counts: Record<string, number> = {};
    for (const source of activeSources()) for (const [date, count] of Object.entries(await inContext({ sourceId: source.id }, () => commitCounts(from, to)))) counts[date] = (counts[date] ?? 0) + count;
    return counts;
  }
  const counts: Record<string, number> = {};
  // Feed commits don't count, and only the full log shows which commits change nothing else.
  const days = currentSource().feedGlobs?.length
    ? (await collectCommits([`--since=${from}T00:00:00`, `--until=${to}T23:59:59`], false)).map((c) => c.date.slice(0, 10))
    : (await git(["log", "--no-merges", `--since=${from}T00:00:00`, `--until=${to}T23:59:59`, "--format=%ad", "--date=short"])).split("\n").filter(Boolean);
  for (const d of days) counts[d] = (counts[d] ?? 0) + 1;
  return counts;
}

export function collectCommitsBetween(from: string, to: string) {
  return collectCommits([`--since=${from}T00:00:00`, `--until=${to}T23:59:59`]);
}

/** Date of the first commit (YYYY-MM-DD). */
export async function firstCommitDate(): Promise<string> {
  if (!currentContext().sourceId) return (await Promise.all(activeSources().map((s) => inContext({ sourceId: s.id }, firstCommitDate)))).filter(Boolean).sort()[0] ?? "";
  const out = await git(["log", "--reverse", "--format=%ad", "--date=short"]);
  return out.trim().split("\n")[0];
}

export async function headCommit(): Promise<string> {
  return (await git(["rev-parse", "HEAD"])).trim();
}

async function collectSourceEvidence(previous: Snapshot | undefined, notes: Evidence["notes"], materials: string[]): Promise<{ evidence: Evidence; snapshot: Snapshot }> {
  const head = await headCommit();
  const since = previous?.takenAt ?? new Date(Date.now() - config().discovery.initialDays * 86400_000).toISOString();

  // Commits: since the previous check's commit when it is still an ancestor, otherwise by date.
  let rangeArgs: string[] = [`--since=${since}`];
  if (previous?.commit) {
    const isAncestor = await run("git", ["merge-base", "--is-ancestor", previous.commit, head], { cwd: currentSource().path })
      .then(() => true)
      .catch(() => false);
    if (isAncestor) rangeArgs = [`${previous.commit}..${head}`];
  }

  const commits = await collectCommits(rangeArgs);

  // Uncommitted content work: compare blob hashes with the previous snapshot.
  // -z: unquoted paths separated by NUL; a rename entry is followed by its original path.
  const entries = (await git(["status", "--porcelain=v1", "-z", "-uall"])).split("\0");
  const dirty: Record<string, string> = {};
  const candidates: Array<{ path: string; status: string }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const st = entry.slice(0, 2).trim();
    const path = entry.slice(3);
    if (st.startsWith("R") || st.startsWith("C")) i++;
    if (st.includes("D") || !isContent(path)) continue;
    candidates.push({ path, status: st });
  }
  const hashes = candidates.length ? (await gitStdin(["hash-object", "--stdin-paths"], candidates.map((c) => c.path).join("\n") + "\n")).trim().split("\n") : [];
  const workingChanges: WorkingChange[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const { path, status: st } = candidates[i];
    dirty[path] = hashes[i];
    if (previous?.dirty[path] === hashes[i]) continue;
    let objects: string[] = [];
    if (SCENE_FILE.test(path) && st !== "??") objects = addedNames(await git(["diff", "-U0", "HEAD", "--", path]).catch(() => ""));
    workingChanges.push({ sourceId: currentSource().id, sourceLabel: currentSource().label, path, status: st, blob: hashes[i], addedObjects: objects });
  }

  return {
    evidence: { range: { since, fromCommit: previous?.commit, toCommit: head }, commits, workingChanges: workingChanges.slice(0, 200), notes, materials },
    snapshot: { commit: head, takenAt: new Date().toISOString(), dirty },
  };
}

export async function collectEvidence(previous: Record<string, Snapshot> | undefined, notes: Evidence["notes"], materials: string[]) {
  const sources = activeSources();
  const collected = await Promise.all(sources.map((s) => inContext({ sourceId: s.id }, () => collectSourceEvidence(previous?.[s.id], [], []))));
  const snapshot = { ...previous };
  collected.forEach((result, i) => { snapshot[sources[i].id] = result.snapshot; });
  const evidence: Evidence = {
    range: { since: collected.map((c) => c.evidence.range.since).sort()[0] ?? new Date().toISOString(), toCommit: "per-source" },
    sources: sources.map(({ id, label, path }) => ({ id, label, path })),
    commits: mergeCommits(collected.map((c) => c.evidence.commits)),
    workingChanges: collected.flatMap((c) => c.evidence.workingChanges), notes, materials,
  };
  return { evidence, snapshot };
}
