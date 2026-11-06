import crypto from "node:crypto";
import { query, tx } from "../db.js";
import { projectId } from "../context.js";
import { getProject } from "../projects.js";
import { runAgent } from "../agent.js";
import { config } from "../config.js";
import { getValue, listMaterials, listNotes, listSuggestions, setValue } from "../store.js";
import { activeSources, collectCommitsBetween, type CommitEvidence } from "../discovery.js";
import { inContext } from "../context.js";
import { looksLikeOtherWork, sessionTitleOf, type ActivityLink, type ActivityRecord, type ActivityThread, type ActivityVisibility, type SessionDigest, type SessionSummary } from "../../shared/activity.js";
import type { Post } from "../../shared/types.js";
import { correlate, threadsOf } from "./correlate.js";
import { forgejoCall, forgejoConnector, forgeTokenKey, githubConnector } from "./forge.js";
import type { DateRange, IngressConnector, SourceCandidate } from "./provider.js";
import { localDate } from "./provider.js";
import { digestHash, mergeDigests, sessionConnector } from "./sessions.js";
import { shorten } from "./redact.js";

export function commitRecord(c: CommitEvidence): ActivityRecord {
  return {
    id: `git:${c.sourceId}:${c.hash}`, connector: "git", sourceId: c.sourceId, kind: "commit", startedAt: c.date, endedAt: c.date, date: localDate(c.date),
    title: c.subject, summary: shorten(c.body, 600), refs: { commits: [c.hash], files: c.files.map((f) => f.path), urls: [], issues: [] }, visibility: "public", contentHash: "", detail: { added: c.files.reduce((n, f) => n + f.added, 0), removed: c.files.reduce((n, f) => n + f.removed, 0), addedObjects: c.addedObjects },
  };
}

/** The first connector: every commit of the project's sources. Discovery keeps its own snapshot for what is new. */
export const gitConnector: IngressConnector = {
  id: "git",
  label: "Git",
  discover: async (project) => [{ connector: "git", label: "Git", detail: `${project.sources.filter((s) => !s.archived).length} working cop${project.sources.length === 1 ? "y" : "ies"}`, found: project.sources.length }],
  async *collect(_project, _source, _cursor, range: DateRange) {
    const to = range.to ?? localDate(new Date());
    for (const s of activeSources()) {
      const commits = await inContext({ sourceId: s.id }, () => collectCommitsBetween(range.from, to));
      for (const c of commits) yield { record: commitRecord(c) };
    }
  },
};

const connectors: Record<string, IngressConnector> = { git: gitConnector, github: githubConnector, forgejo: forgejoConnector, "claude-sessions": sessionConnector("claude-sessions"), "codex-sessions": sessionConnector("codex-sessions") };

const contentHash = (r: ActivityRecord) => crypto.createHash("sha256").update(JSON.stringify([r.title, r.summary, r.refs, r.kind === "session" ? digestHash(r.detail as SessionDigest) : r.detail])).digest("hex").slice(0, 24);

/**
 * Stores a record. A session's later lines merge into its day, and the developer's visibility choice and summary stay.
 * `replace` is for a log read from its start: what's stored is then rebuilt, not added to.
 */
export async function saveRecord(pid: string, incoming: ActivityRecord, replace = false) {
  const existing = (await query<{ data: ActivityRecord }>("SELECT data FROM activity WHERE project_id = $1 AND id = $2", [pid, incoming.id]))[0]?.data;
  let record = incoming;
  if (existing) {
    record = { ...incoming, visibility: existing.visibility, visibilityChosen: existing.visibilityChosen };
    if (incoming.kind === "session") {
      const merged = replace ? (incoming.detail as SessionDigest) : mergeDigests(existing.detail as SessionDigest, incoming.detail as SessionDigest);
      record = { ...record, startedAt: existing.startedAt < incoming.startedAt ? existing.startedAt : incoming.startedAt, endedAt: existing.endedAt > incoming.endedAt ? existing.endedAt : incoming.endedAt, title: incoming.title, detail: { ...merged, aiSummary: (existing.detail as SessionDigest).aiSummary }, refs: { ...incoming.refs, commits: merged.commits, files: merged.files, repo: incoming.refs.repo ?? existing.refs.repo, branch: incoming.refs.branch ?? existing.refs.branch } };
    }
  }
  if (record.kind === "session") {
    const digest = record.detail as SessionDigest;
    record.title = shorten(sessionTitleOf(digest), 90);
    // The digest can change this until the developer has decided.
    if (!record.visibilityChosen) record.visibility = looksLikeOtherWork(digest) ? "excluded" : "private";
  }
  record.contentHash = contentHash(record);
  await query(
    "INSERT INTO activity (project_id, id, date, data) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, id) DO UPDATE SET date = $3, data = $4",
    [pid, record.id, record.date, record],
  );
}

export const listRecords = async (pid: string, range?: { from?: string; to?: string }) =>
  (await query<{ data: ActivityRecord }>("SELECT data FROM activity WHERE project_id = $1 AND date >= $2 AND date <= $3 ORDER BY date, id", [pid, range?.from ?? "0000", range?.to ?? "9999"])).map((r) => r.data);
export const listLinks = async (pid: string) => (await query<{ data: ActivityLink }>("SELECT data FROM activity_links WHERE project_id = $1", [pid])).map((r) => r.data);

/** Replaces computed links. A developer's joins and splits survive. */
async function refreshLinks(pid: string) {
  const records = await listRecords(pid);
  const manual = (await listLinks(pid)).filter((l) => l.strength === "manual");
  const pairOf = (l: ActivityLink) => (l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`);
  const held = new Set(manual.map(pairOf));
  const links = [...manual, ...correlate(records).filter((l) => !held.has(pairOf(l)))];
  // One statement for all rows, because a project can have thousands of links and this runs on every visibility change.
  await tx(async (c) => {
    await c.query("DELETE FROM activity_links WHERE project_id = $1", [pid]);
    await c.query(
      "INSERT INTO activity_links (project_id, a, b, data) SELECT $1, a, b, d FROM unnest($2::text[], $3::text[], $4::jsonb[]) AS row(a, b, d) ON CONFLICT DO NOTHING",
      [pid, links.map((l) => l.a), links.map((l) => l.b), links.map((l) => JSON.stringify(l))],
    );
  });
  return links.length;
}

export interface SyncResult { records: number; links: number; unsupported: string[]; skippedLines: number; errors: string[] }
/** Raised when digests gain a field, so that logs are read again. */
const CURSOR_VERSION = 6;

/** Reads every enabled source. Cursors advance only after all of a connector's records are stored. */
export async function syncActivity(range: DateRange, log: (l: string) => void = () => {}, only?: Record<string, IngressConnector>): Promise<SyncResult> {
  const pid = projectId();
  const project = getProject(pid).settings;
  const result: SyncResult = { records: 0, links: 0, unsupported: [], skippedLines: 0, errors: [] };
  const enabled: Array<{ connector: IngressConnector; source?: (typeof project.activitySources extends (infer S)[] | undefined ? S : never) }> = [
    { connector: (only ?? connectors).git },
    ...(project.activitySources ?? []).filter((s) => s.enabled).map((source) => ({ connector: (only ?? connectors)[source.connector], source })),
  ].filter((e) => e.connector);
  for (const { connector, source } of enabled) {
    const key = `activityCursor:${source?.id ?? connector.id}`;
    const stored = await getValue<{ from: string; cursor: unknown; version?: number }>(pid, key);
    const saved = stored?.version === CURSOR_VERSION ? stored : undefined;
    // Reading further back than before starts over, so older days aren't skipped.
    const cursor = saved && saved.from <= range.from ? saved.cursor : undefined;
    let count = 0, next: unknown = saved?.cursor;
    // Without a cursor every log is read from its start, and only its first record per day replaces what's stored.
    const replaced = new Set<string>();
    try {
      for await (const event of connector.collect(project, source, cursor, range)) {
        if ("record" in event) {
          await saveRecord(pid, event.record, !cursor && !replaced.has(event.record.id));
          replaced.add(event.record.id);
          count++;
        }
        else if ("cursor" in event) next = event.cursor;
        else if ("unsupported" in event) result.unsupported.push(event.unsupported);
        else result.skippedLines += event.skippedLines;
      }
    } catch (err) {
      // One source failing leaves the others readable; its cursor stays, so the next run repeats it.
      const message = `${connector.label}: ${(err as Error).message}`;
      result.errors.push(message);
      log(message);
      continue;
    }
    await setValue(pid, key, { version: CURSOR_VERSION, from: saved && saved.from < range.from ? saved.from : range.from, cursor: next });
    log(`${connector.label}: ${count} record(s).`);
    result.records += count;
  }
  if (result.unsupported.length) log(`Unsupported log format in ${result.unsupported.length} file(s); they added no data.`);
  result.links = await refreshLinks(pid);
  log(`${result.links} link(s).`);
  return result;
}

export async function discoverSources(): Promise<SourceCandidate[]> {
  const project = getProject().settings;
  return (await Promise.all(Object.values(connectors).map((c) => c.discover(project).catch((e) => [{ connector: c.id as SourceCandidate["connector"], label: c.label, detail: (e as Error).message, found: 0 }])))).flat();
}

/** Notes and materials appear next to stored records, because they are already this project's own data. */
async function ownRecords(pid: string, range: { from?: string; to?: string }): Promise<ActivityRecord[]> {
  const within = (date: string) => (!range.from || date >= range.from) && (!range.to || date <= range.to);
  const refs = { commits: [], files: [], urls: [], issues: [] };
  const notes = (await listNotes(pid)).filter((n) => within(n.date)).map((n): ActivityRecord => ({ id: `note:${n.id}`, connector: "notes", sourceId: "notes", kind: "note", startedAt: n.createdAt, endedAt: n.createdAt, date: n.date, title: shorten(n.text, 90), summary: n.text, refs, visibility: "public", contentHash: "" }));
  const materials = (await listMaterials(pid, { from: range.from, to: range.to })).map((m): ActivityRecord => ({ id: `material:${m.id}`, connector: "materials", sourceId: "materials", kind: "material", startedAt: m.createdAt, endedAt: m.createdAt, date: m.date, title: m.title, summary: m.annotation, refs, visibility: "public", contentHash: "", detail: { thumbKey: m.thumbKey } }));
  return [...notes, ...materials];
}

export async function activityView(range: { from?: string; to?: string }) {
  const pid = projectId();
  const records = [...await listRecords(pid, range), ...await ownRecords(pid, range)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const links = await listLinks(pid);
  const ids = new Set(records.map((r) => r.id));
  const shown = links.filter((l) => ids.has(l.a) && ids.has(l.b));
  return { records, links: shown, threads: threadsOf(records, shown) };
}

export async function setVisibility(id: string, visibility: ActivityVisibility) {
  const pid = projectId();
  const record = (await query<{ data: ActivityRecord }>("SELECT data FROM activity WHERE project_id = $1 AND id = $2", [pid, id]))[0]?.data;
  if (!record) throw Object.assign(new Error("This record no longer exists."), { status: 404 });
  // A session's content comes from a private log, so it can't become quotable.
  if (visibility === "public" && record.kind === "session") throw Object.assign(new Error("Session records stay private or excluded."), { status: 400 });
  await query("UPDATE activity SET data = $3 WHERE project_id = $1 AND id = $2", [pid, id, { ...record, visibility, visibilityChosen: true }]);
  await refreshLinks(pid);
}

/** Stores a forge's token after checking that it works. It stays on the server, apart from the project's settings. */
export async function saveForgeToken(sourceId: string, baseUrl: string, repo: string, token: string) {
  if (!token.trim()) throw Object.assign(new Error("Enter a token."), { status: 400 });
  const info = await forgejoCall(baseUrl, token.trim())(`/repos/${repo}`).catch((err: Error) => { throw Object.assign(err, { status: 400 }); }) as { private?: boolean };
  await setValue(projectId(), forgeTokenKey(sourceId), token.trim());
  return { private: !!info.private };
}

/** A developer's decision to join or split two records; it survives later runs. */
export async function setManualLink(a: string, b: string, split: boolean) {
  const pid = projectId();
  const link: ActivityLink = { a, b, strength: "manual", reason: split ? "Split by you" : "Joined by you", split };
  await query("DELETE FROM activity_links WHERE project_id = $1 AND ((a = $2 AND b = $3) OR (a = $3 AND b = $2))", [pid, a, b]);
  await query("INSERT INTO activity_links (project_id, a, b, data) VALUES ($1, $2, $3, $4)", [pid, a, b, link]);
}

const SUMMARY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["attempted", "failed", "changedCourse", "shipped"],
  properties: { attempted: { type: "string" }, failed: { type: "string" }, changedCourse: { type: "string" }, shipped: { type: "string" } },
};

export function summaryPrompt(record: ActivityRecord) {
  const d = record.detail as SessionDigest;
  return `Summarize one day of a developer's work session for that developer's devlog. The digest below is all you have, and you read nothing else.

Date: ${record.date}. Session: ${record.title}. Files edited: ${d.files.join(", ") || "none"}.
Git commands: ${d.commands.join(" ; ") || "none"}. Commits: ${d.commits.join(", ") || "none"}.
Checks: ${d.checks.map((c) => `${c.ok ? "passed" : "failed"}: ${c.command}${c.error ? ` (${c.error})` : ""}`).join(" ; ") || "none"}.
The developer's requests, shortened:
${d.prompts.map((p) => `- ${p}`).join("\n") || "(none)"}

In plain sentences, state what was attempted, what failed, what changed course and why, and what shipped. Use an empty string where the digest doesn't show something. Say only what the digest supports.`;
}

/** Summarizes a session day on request, and reuses the result while the digest is unchanged. */
export async function summarizeRecord(id: string, log: (l: string) => void, write: typeof runAgent = runAgent, agent = config().agent.default) {
  const pid = projectId();
  const record = (await query<{ data: ActivityRecord }>("SELECT data FROM activity WHERE project_id = $1 AND id = $2", [pid, id]))[0]?.data;
  if (!record || record.kind !== "session") throw Object.assign(new Error("Only session records have summaries."), { status: 400 });
  if (record.visibility === "excluded") throw Object.assign(new Error("This session is excluded."), { status: 400 });
  const digest = record.detail as SessionDigest;
  const hash = digestHash(digest);
  if (digest.aiSummary?.digestHash === hash) { log("The summary is still current."); return digest.aiSummary; }
  const { output } = await write<Omit<SessionSummary, "digestHash" | "createdAt">>({ prompt: summaryPrompt(record), schema: SUMMARY_SCHEMA, agent, log });
  const aiSummary: SessionSummary = { ...output, digestHash: hash, createdAt: new Date().toISOString() };
  await query("UPDATE activity SET data = $3 WHERE project_id = $1 AND id = $2", [pid, id, { ...record, detail: { ...digest, aiSummary } }]);
  return aiSummary;
}

/**
 * Background for a post's agents: the threads around the post's commits. A session contributes only its summary
 * and only as background. Excluded records and unsummarized sessions contribute nothing.
 */
export async function activityContext(pid: string, post: Pick<Post, "suggestionIds">): Promise<string> {
  const stored = await listRecords(pid);
  if (!stored.some((r) => r.connector !== "git")) return "";
  const suggestions = (await listSuggestions(pid)).filter((s) => post.suggestionIds.includes(s.id));
  const wanted = new Set([...suggestions.flatMap((s) => s.sources.commits).map((ref) => `git:${ref}`), ...suggestions.flatMap((s) => s.sources.sessions ?? [])]);
  const threads: ActivityThread[] = threadsOf(stored, await listLinks(pid)).filter((t) => t.recordIds.some((id) => wanted.has(id)));
  const byId = new Map(stored.map((r) => [r.id, r]));
  const pub: string[] = [], priv: string[] = [];
  for (const id of new Set(threads.flatMap((t) => t.recordIds))) {
    const r = byId.get(id)!;
    if (r.visibility === "excluded" || r.kind === "commit") continue;
    if (r.kind === "session") {
      const s = (r.detail as SessionDigest).aiSummary;
      if (s) priv.push(`- ${r.date}: attempted: ${s.attempted} Failed: ${s.failed || "-"} Changed course: ${s.changedCourse || "-"} Shipped: ${s.shipped || "-"}`);
    } else (r.visibility === "public" ? pub : priv).push(`- ${r.date} ${r.kind}: ${r.title}${r.summary ? `. ${r.summary}` : ""}`);
  }
  return [
    pub.length ? `Related public activity:\n${pub.join("\n")}` : "",
    priv.length ? `Private working notes, as background only. Use them to understand the work and what went wrong. Don't quote them, and don't mention anything from them that the developer's answers or the public evidence don't also support:\n${priv.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
