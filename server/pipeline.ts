import { outputStage, setOutputStage } from "../shared/outputs.js";
import { videoOutput } from "./outputs/video.js";
import { outputFolder } from "./outputs/folders.js";
import { getProject } from "./projects.js";
import { normalizeCommitReferences } from "./commit-references.js";
import { projectId, inContext } from "./context.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, CACHE_DIR, type AgentKind } from "./config.js";
import { activeSources, commitRef, latestSnapshotTime, collectCommitsBetween, collectEvidence, commitsByHash, type Evidence } from "./discovery.js";
import { runAgent, SESSION_REVIEW_SCHEMA, STORY_DRAFT_SCHEMA, ARTICLE_REVIEW_SCHEMA, ARTICLE_SCHEMA, SOCIAL_TEXT_SCHEMA, QUESTIONS_SCHEMA, REVIEW_SCHEMA, SUGGESTIONS_SCHEMA, TURN_EDITS_SCHEMA, VERIFY_SCHEMA } from "./agent.js";
import { articlePrompt, articleReviewPrompt, socialTextPrompt, backfillPrompt, sessionReviewPrompt, dialogueReviewPrompt, discoveryPrompt, feedPrompt, fixClaimsPrompt, questionsPrompt, reviewPrompt, storyDraftPrompt, verifyPrompt } from "./prompts.js";
import { answersOf, assertCoHostVerified, evidenceSnapshot, scriptFingerprint, verificationFingerprint, verificationResult, type VerifiedClaim } from "./verification.js";
import { activityContext, listRecords } from "./ingress/sync.js";
import { feedContext, type FeedDetail } from "./ingress/feeds.js";
import type { ActivityRecord } from "../shared/activity.js";
import type { SessionDigest } from "../shared/activity.js";
import { coHostDisclosure } from "../shared/cohost.js";
import { articleImageChoices, imageRefs, slugOf } from "./egress/article.js";
import { deletePostPublications, listPublications, updatePublication } from "./egress/publish.js";
import { getUpload, listUploads, setUpload } from "./egress/youtube.js";
import { CONNECTOR_LABEL, isYoutubePublicationId, PLACEHOLDER_LENGTH, TEXT_LIMIT } from "../shared/publications.js";
import {
  getMaterials,
  getSnapshot,
  getSuggestions,
  getValue,
  insertSuggestion,
  listMaterials,
  listNotes,
  listPosts,
  listSuggestions,
  loadPost,
  deletePost,
  newId,
  savePost,
  saveRun,
  setSnapshot,
  setValue,
  today,
  updatePost,
  updateSuggestions,
} from "./store.js";
import { renderCapture, captureOperation, createCaptureSession } from "./capture/provider.js";

import { narrate } from "./tts.js";
import { buildTimeline, chapters, estimatedSpeechMs, toSrt } from "./timeline.js";
import { renderVideo } from "./render.js";
import { deleteKey, deletePrefix, putFile } from "./storage.js";
import { CancelledError, currentJobSignal, listJobs, throwIfCancelled } from "./jobs.js";
import { uploadCaptions, uploadVideo } from "./youtube.js";
import { materialsForAgent } from "./materials.js";
import {
  type Post,
  type Format,
  type ProposedEdit,
  type StoryDraft,
  type StoryRequest,
  type Material,
  type PublishPackage,
  type Script,
  type Segment,
  type ShotAngle,
  type ShotDistance,
  type Suggestion,
  type Speaker,
  type Visual,
  newPageShot,
  MAX_TAKES,
} from "../shared/types.js";
import type { Presentation } from "../shared/types.js";

const run = promisify(execFile);
type Log = (line: string) => void;

const logCost = (log: Log, costUsd?: number) => {
  if (costUsd) log(`API-equivalent cost $${costUsd.toFixed(2)} (counts against the CLI subscription, not billed separately)`);
};

// ---------- discovery and backfill ----------

interface RawSuggestion {
  title: string;
  hook: string;
  summary: string;
  whyItMatters: string;
  kind: Suggestion["kind"];
  appeal: number;
  recommendedFormat: Suggestion["recommendedFormat"];
  workDate: string;
  commits: string[];
  files: string[];
  notes: string[];
  materials: string[];
  suggestedShots: string[];
  duplicateOf?: string;
}

function writeEvidence(runId: string, evidence: unknown): string {
  const dir = path.join(CACHE_DIR, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "evidence.json");
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  return file;
}

/** Stores agent suggestions and returns their ids. */
async function storeSuggestions(raw: RawSuggestion[], knownMaterials: Set<string>, clampDate?: { from: string; to: string }, extra: (r: RawSuggestion) => Partial<Suggestion> = () => ({})): Promise<string[]> {
  const ids: string[] = [];
  for (const r of raw) {
    let workDate = /^\d{4}-\d{2}-\d{2}$/.test(r.workDate) ? r.workDate : clampDate?.to ?? today();
    if (clampDate && (workDate < clampDate.from || workDate > clampDate.to)) workDate = clampDate.to;
    const id = newId("sug");
    ids.push(id);
    await insertSuggestion(projectId(), {
      id,
      createdAt: new Date().toISOString(),
      workDate,
      title: r.title,
      hook: r.hook,
      summary: r.summary,
      whyItMatters: r.whyItMatters,
      kind: r.kind,
      appeal: r.appeal,
      recommendedFormat: r.recommendedFormat,
      sources: { commits: r.commits, files: r.files, notes: r.notes },
      materialIds: r.materials.filter((id) => knownMaterials.has(id)),
      suggestedShots: r.suggestedShots,
      highlights: (r as RawSuggestion & { highlights?: string }).highlights ?? "",
      status: "proposed",
      ...extra(r),
    });
  }
  return ids;
}

const openTitles = async () => (await listSuggestions(projectId())).filter((s) => s.status !== "dismissed" && s.status !== "merged").map((s) => s.title);
function normalizeAgentCommits<T extends { commits: string[] }>(suggestions: T[], commits: Evidence["commits"], log: Log): T[] {
  return suggestions.map((suggestion) => {
    const { references, rejected } = normalizeCommitReferences(suggestion.commits, commits);
    if (rejected) log(`Ignored ${rejected} commit citation(s) that do not identify a unique commit in the supplied evidence.`);
    return { ...suggestion, commits: references };
  });
}

export async function runDiscovery(log: Log, agent?: AgentKind, write = runAgent) {
  const previous = await getSnapshot(projectId());
  const since = latestSnapshotTime(previous);
  const notes = (await listNotes(projectId())).filter((n) => !since || n.createdAt > since).map((n) => ({ date: n.date, text: n.text }));
  const materials = await listMaterials(projectId(), { createdAfter: since });
  log(`Collecting evidence since ${since ?? `${config().discovery.initialDays} days ago`}…`);
  const agentMaterials = await materialsForAgent(materials);
  const { evidence, snapshot } = await collectEvidence(previous, notes, agentMaterials.lines);
  // Beyond Git: what connected sources add. Evidence of a Git-only project stays as it is.
  const related = (await listRecords(projectId(), { from: (since ?? evidence.range.since).slice(0, 10) })).filter((r) => (r.connector === "github" || r.connector === "forgejo") && r.visibility !== "excluded");
  if (related.length) Object.assign(evidence, { related: related.map((r) => ({ date: r.date, kind: r.kind, title: r.title, summary: r.summary, commits: r.refs.commits, private: r.visibility === "private" })) });
  const relatedRule = related.length ? "\nThe evidence's related list holds pull requests, issues and releases. Those marked private are background: use them to understand the work, and don't quote them." : "";
  log(`${evidence.commits.length} commits, ${evidence.workingChanges.length} changed content files, ${notes.length} notes, ${materials.length} materials.`);

  const runId = newId("run");
  let added = 0;
  if (evidence.commits.length || evidence.workingChanges.length || notes.length || materials.length) {
    const { output, costUsd } = await write<{ suggestions: RawSuggestion[] }>({
      prompt: discoveryPrompt(writeEvidence(runId, evidence), await openTitles()) + relatedRule,
      schema: SUGGESTIONS_SCHEMA,
      images: agentMaterials.images,
      agent,
      log,
    });
    await saveRun(projectId(), runId, "discover", evidence, output);
    logCost(log, costUsd);
    added = (await storeSuggestions(normalizeAgentCommits(output.suggestions, evidence.commits, log), new Set(materials.map((m) => m.id)))).length;
  }
  // The snapshot advances only after a successful run, so a failed run is retried with the same range.
  await setSnapshot(projectId(), snapshot);
  log(`${added} new suggestion(s).`);
}

/** Monday-to-Sunday weeks covering [from, to]. */
export function weeksBetween(from: string, to: string): Array<{ from: string; to: string }> {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(`${from}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(`${to}T00:00:00Z`);
  const weeks: Array<{ from: string; to: string }> = [];
  for (const d = start; d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    const last = new Date(d);
    last.setUTCDate(last.getUTCDate() + 6);
    weeks.push({ from: iso(d) < from ? from : iso(d), to: iso(last) > to ? to : iso(last) });
  }
  return weeks;
}

const BACKFILLED = "backfilledWeeks";
export type BackfillCoverage = Record<string, string[]>;
export function pendingSourceIds(coverage: BackfillCoverage, sources: Array<{ id: string }>, week: string, rerun = false) {
  return sources.filter((s) => rerun || !coverage[s.id]?.includes(week)).map((s) => s.id);
}
export const backfilledWeeks = async () => {
  const coverage = (await getValue<BackfillCoverage>(projectId(), BACKFILLED)) ?? {};
  const sources = activeSources();
  return [...new Set(Object.values(coverage).flat())].filter((week) => sources.length > 0 && pendingSourceIds(coverage, sources, week).length === 0).sort();
};
export async function runBackfill(from: string, to: string, rerun: boolean, log: Log, agent?: AgentKind, write = runAgent) {
  const coverage = (await getValue<BackfillCoverage>(projectId(), BACKFILLED)) ?? {};
  const notes = await listNotes(projectId());
  const sources = activeSources();
  const weeks = weeksBetween(from, to);
  log(`Backfill ${from} … ${to}: ${weeks.length} week(s).`);
  let total = 0;
  for (const week of weeks) {
    throwIfCancelled();
    const pending = pendingSourceIds(coverage, sources, week.from, rerun);
    if (!pending.length) { log(`${week.from}: already processed, skipped.`); continue; }
    const commits = (await Promise.all(pending.map((sourceId) => inContext({ sourceId }, () => collectCommitsBetween(week.from, week.to))))).flat().sort((a, b) => a.date.localeCompare(b.date));
    const existing = (await listSuggestions(projectId())).filter((s) => s.status !== "merged" && s.status !== "dismissed");
    const partial = pending.length < sources.length;
    const weekNotes = partial ? [] : notes.filter((n) => n.date >= week.from && n.date <= week.to).map((n) => ({ date: n.date, text: n.text }));
    const materials = partial ? [] : await listMaterials(projectId(), { from: week.from, to: week.to });
    if (commits.length || weekNotes.length || materials.length) {
      const agentMaterials = await materialsForAgent(materials);
      const evidence = { range: { since: week.from, toCommit: week.to }, sources: sources.filter((s) => pending.includes(s.id)), commits, workingChanges: [], notes: weekNotes, materials: agentMaterials.lines, existingSuggestions: existing.map(({ id, title, summary }) => ({ id, title, summary })) };
      const runId = newId("run");
      const { output, costUsd } = await write<{ suggestions: RawSuggestion[] }>({
        prompt: backfillPrompt(writeEvidence(runId, evidence), week.from, week.to, existing.map((s) => s.title)) + "\nExisting suggestions from the whole project are included with IDs, titles and summaries. Do not create a new suggestion for tracked work, even when it spans multiple weeks. To attach new evidence to a tracked topic, return its ID in duplicateOf; otherwise use an empty string. Its commit references will be attached to the existing suggestion without replacing it.",
        schema: SUGGESTIONS_SCHEMA, images: agentMaterials.images, agent, log,
      });
      await saveRun(projectId(), runId, "backfill", evidence, output); logCost(log, costUsd);
      for (const raw of normalizeAgentCommits(output.suggestions, commits, log)) {
        const match = existing.find((e) => e.id === raw.duplicateOf || e.title.trim().toLowerCase() === raw.title.trim().toLowerCase());
        if (match) {
          await updateSuggestions(projectId(), [match.id], (items) => { items[0].sources.commits = [...new Set([...items[0].sources.commits, ...raw.commits])]; });
        } else total += (await storeSuggestions([raw], new Set(materials.map((m) => m.id)), week)).length;
      }
    } else log(`${week.from}: no activity.`);
    for (const sourceId of pending) coverage[sourceId] = [...new Set([...(coverage[sourceId] ?? []), week.from])].sort();
    await setValue(projectId(), BACKFILLED, coverage);
  }
  log(`Backfill finished: ${total} new suggestion(s).`);
}

// ---------- session review ----------

const SESSION_REVIEWED = "sessionReviewedWeeks";
const SESSION_FILES = 40;
const LIVE_FIRST: Record<Suggestion["status"], number> = { proposed: 0, approved: 0, used: 0, dismissed: 1, merged: 2 };
const sameCommit = (a: string, b: string) => { const x = a.split(":").pop()!, y = b.split(":").pop()!; return x.startsWith(y) || y.startsWith(x); };
const canEdit = (s: Suggestion) => (s.status === "proposed" || s.status === "approved") && !s.postId;

const liveFirst = (existing: Suggestion[]) => [...existing].sort((a, b) => LIVE_FIRST[a.status] - LIVE_FIRST[b.status]);

/** The existing suggestion with this topic's exact title. */
export function sameTitleSuggestion(topic: { title: string }, existing: Suggestion[]): Suggestion | undefined {
  const title = topic.title.trim().toLowerCase();
  return liveFirst(existing).find((s) => s.title.trim().toLowerCase() === title);
}

/** The existing suggestion where each side shares at least half of its own commits. This only hints at a repeat. */
export function sharedCommitsSuggestion(topic: { commits: string[] }, existing: Suggestion[]): Suggestion | undefined {
  const shared = (s: Suggestion) => topic.commits.filter((c) => s.sources.commits.some((o) => sameCommit(c, o))).length;
  const close = liveFirst(existing).filter((s) => shared(s) > 0 && shared(s) * 2 >= Math.max(topic.commits.length, s.sources.commits.length));
  return close.reduce<Suggestion | undefined>((top, s) => (!top || shared(s) > shared(top) ? s : top), undefined);
}

const FEEDS_PROPOSED = "feedEntriesProposed";
/** Feed entries older than this are left for the developer, so turning a feed on doesn't start a run per archived entry. */
const FEED_DAYS = 7;

export const feedInfo = async () => {
  const proposed = new Set((await getValue<string[]>(projectId(), FEEDS_PROPOSED)) ?? []);
  const entries = (await listRecords(projectId(), { from: daysAgo(FEED_DAYS) })).filter((r) => r.kind === "feed" && r.visibility !== "excluded");
  return { feeds: activeSources().some((s) => s.feedGlobs?.length), waiting: entries.filter((r) => !proposed.has(r.id)).length };
};
const daysAgo = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return localDate(d); };

/** One agent run per feed entry of the last week that has no topics yet. An entry is proposed from once, even when its file changes later. */
export async function runFeedProposals(log: Log, agent?: AgentKind, write = runAgent) {
  const pid = projectId();
  const proposed = new Set((await getValue<string[]>(pid, FEEDS_PROPOSED)) ?? []);
  const entries = (await listRecords(pid, { from: daysAgo(FEED_DAYS) })).filter((r) => r.kind === "feed" && r.visibility !== "excluded" && !proposed.has(r.id));
  log(`${entries.length} feed entr${entries.length === 1 ? "y" : "ies"} without topics.`);
  let added = 0;
  for (const entry of entries) {
    throwIfCancelled();
    const existing = await listSuggestions(pid);
    const evidence = { entry: { id: entry.id, date: entry.date, ...(entry.detail as FeedDetail) }, existingSuggestions: existing.filter((s) => s.kind === "news").map(({ id, title, status, workDate }) => ({ id, title, status, workDate })) };
    const runId = newId("run");
    const { output, costUsd } = await write<{ suggestions: RawSuggestion[] }>({
      prompt: feedPrompt(writeEvidence(runId, evidence), entry.date, existing.filter((s) => s.status !== "dismissed" && s.status !== "merged").map((s) => s.title)),
      schema: SUGGESTIONS_SCHEMA, agent, log,
    });
    await saveRun(pid, runId, "feed", evidence, output); logCost(log, costUsd);
    const fresh = output.suggestions.filter((s) => {
      const match = sameTitleSuggestion(s, existing);
      if (match) log(`"${s.title}" repeats "${match.title}" (${match.status}).`);
      return !match;
    });
    const ids = await storeSuggestions(fresh, new Set(), { from: entry.date, to: entry.date }, () => ({ kind: "news", sources: { commits: [], files: [], notes: [], feeds: [entry.id] } }));
    log(`${entry.date}: ${ids.length} new topic(s).`);
    added += ids.length;
    proposed.add(entry.id);
    await setValue(pid, FEEDS_PROPOSED, [...proposed].sort());
  }
  log(`${added} new suggestion(s).`);
}

export const sessionReviewInfo = async () => {
  const sessions = (await listRecords(projectId())).filter((r) => r.kind === "session" && r.visibility !== "excluded");
  return { firstSession: sessions[0]?.date, processedWeeks: (await getValue<string[]>(projectId(), SESSION_REVIEWED)) ?? [] };
};

function sessionFacts(r: ActivityRecord) {
  const d = r.detail as SessionDigest;
  return { id: r.id, date: r.date, title: r.title, activeMinutes: d.activeMinutes.length, prompts: d.prompts, files: d.files.slice(0, SESSION_FILES), commits: d.commits, failedChecks: d.checks.filter((c) => !c.ok) };
}

/** One agent run per week with sessions. It adds topics and evidence, and it changes a suggestion's text only through a proposed edit. */
export async function runSessionReview(from: string, to: string, rerun: boolean, log: Log, agent?: AgentKind, write = runAgent) {
  const pid = projectId();
  const reviewed = new Set((await getValue<string[]>(pid, SESSION_REVIEWED)) ?? []);
  const notes = await listNotes(pid);
  const weeks = weeksBetween(from, to);
  log(`Session review ${from} … ${to}: ${weeks.length} week(s).`);
  const totals = { added: 0, edits: 0, covered: 0, repeats: 0 };
  for (const week of weeks) {
    throwIfCancelled();
    if (reviewed.has(week.from) && !rerun) { log(`${week.from}: already reviewed, skipped.`); continue; }
    const sessions = (await listRecords(pid, week)).filter((r) => r.kind === "session" && r.visibility !== "excluded");
    if (!sessions.length) { log(`${week.from}: no sessions.`); continue; }
    const commits = (await Promise.all(activeSources().map((s) => inContext({ sourceId: s.id }, () => collectCommitsBetween(week.from, week.to))))).flat().sort((a, b) => a.date.localeCompare(b.date));
    const materials = await listMaterials(pid, { from: week.from, to: week.to });
    const agentMaterials = await materialsForAgent(materials);
    const existing = await listSuggestions(pid);
    const evidence = {
      range: { since: week.from, toCommit: week.to },
      commits,
      workingChanges: [],
      notes: notes.filter((n) => n.date >= week.from && n.date <= week.to).map((n) => ({ date: n.date, text: n.text })),
      materials: agentMaterials.lines,
      sessions: sessions.map(sessionFacts),
      existingSuggestions: existing.map(({ id, title, summary, status, workDate }) => ({ id, title, summary, status, workDate })),
    };
    const runId = newId("run");
    const { output, costUsd } = await write<{ covered: Array<{ suggestionId: string; commits: string[]; sessions: string[] }>; edits: Array<Omit<ProposedEdit, "createdAt"> & { suggestionId: string; commits: string[]; sessions: string[] }>; suggestions: Array<RawSuggestion & { sessions: string[] }> }>({
      prompt: sessionReviewPrompt(writeEvidence(runId, evidence), week.from, week.to, existing.map((s) => s.title)),
      schema: SESSION_REVIEW_SCHEMA, images: agentMaterials.images, agent, log,
    });
    await saveRun(pid, runId, "sessionReview", evidence, output); logCost(log, costUsd);
    const known = new Set(sessions.map((r) => r.id));
    const ownSessions = (ids: string[]) => ids.filter((id) => known.has(id));
    const byId = new Map(existing.map((s) => [s.id, s]));
    const addEvidence = (id: string, newCommits: string[], newSessions: string[]) => updateSuggestions(pid, [id], (items) => {
      items[0].sources.commits = [...new Set([...items[0].sources.commits, ...newCommits])];
      items[0].sources.sessions = [...new Set([...(items[0].sources.sessions ?? []), ...ownSessions(newSessions)])];
    });
    const isLive = (s: Suggestion) => s.status !== "dismissed" && s.status !== "merged";
    let added = 0, edits = 0, covered = 0, repeats = 0;
    for (const item of normalizeAgentCommits(output.covered, commits, log)) {
      const target = byId.get(item.suggestionId);
      if (!target) { log(`Ignored a finding about an unknown suggestion: ${item.suggestionId}`); continue; }
      if (isLive(target)) { await addEvidence(target.id, item.commits, item.sessions); covered++; }
    }
    for (const item of normalizeAgentCommits(output.edits, commits, log)) {
      const target = byId.get(item.suggestionId);
      if (!target) { log(`Ignored an edit of an unknown suggestion: ${item.suggestionId}`); continue; }
      if (!isLive(target)) continue;
      await addEvidence(target.id, item.commits, item.sessions);
      if (!canEdit(target)) { covered++; continue; }
      const { hook, summary, whyItMatters, reason } = item;
      await updateSuggestions(pid, [target.id], (items) => { items[0].proposedEdit = { hook, summary, whyItMatters, reason, createdAt: new Date().toISOString() }; });
      edits++;
    }
    const knownMaterials = new Set(materials.map((m) => m.id));
    const tracked = [...existing];
    for (const raw of normalizeAgentCommits(output.suggestions, commits, log)) {
      const match = sameTitleSuggestion(raw, tracked);
      if (match) {
        repeats++;
        log(`"${raw.title}" repeats "${match.title}" (${match.status}).`);
        if (isLive(match)) await addEvidence(match.id, raw.commits, raw.sessions);
        continue;
      }
      const [id] = await storeSuggestions([raw], knownMaterials, week, () => ({ fromSessionReview: true, possibleRepeatOf: sharedCommitsSuggestion(raw, tracked)?.title, sources: { commits: raw.commits, files: raw.files, notes: raw.notes, sessions: ownSessions(raw.sessions) } }));
      const stored = (await getSuggestions(pid, [id]))[0];
      if (stored) tracked.push(stored);
      added++;
    }
    log(`${week.from}: ${added} new, ${edits} update(s) proposed, ${covered} already covered, ${repeats} repeat(s) dropped.`);
    totals.added += added; totals.edits += edits; totals.covered += covered; totals.repeats += repeats;
    reviewed.add(week.from);
    await setValue(pid, SESSION_REVIEWED, [...reviewed].sort());
  }
  log(`Session review finished: ${totals.added} new suggestion(s), ${totals.edits} update(s) proposed, ${totals.covered} already covered, ${totals.repeats} repeat(s) dropped.`);
}

/** Applies or discards a proposed edit. A suggestion that has since gone into a post or out of the list keeps its text. */
export async function resolveProposedEdit(id: string, accept: boolean) {
  const [updated] = await updateSuggestions(projectId(), [id], (items) => {
    const [s] = items;
    if (accept && s.proposedEdit && canEdit(s)) Object.assign(s, { hook: s.proposedEdit.hook, summary: s.proposedEdit.summary, whyItMatters: s.proposedEdit.whyItMatters });
    delete s.proposedEdit;
  });
  return updated;
}

// ---------- story drafts ----------

const STORY_DRAFTS = "storyDrafts";
export const listStoryDrafts = async () => (await getValue<StoryDraft[]>(projectId(), STORY_DRAFTS)) ?? [];
const saveStoryDrafts = (drafts: StoryDraft[]) => setValue(projectId(), STORY_DRAFTS, drafts);

interface RawStoryDraft {
  suggestion: Omit<RawSuggestion, "suggestedShots"> & { sessions: string[] };
  absorbs: Array<{ suggestionId: string; reason: string }>;
  related: Array<{ title: string; reason: string }>;
  leftOut: Array<{ item: string; reason: string }>;
  unsupported: string[];
  shots: Array<{ description: string; materialId: string }>;
}

/** Writes one suggestion from the developer's description and the activity around it, and keeps it as a draft for review. */
export async function draftStory(request: StoryRequest, log: Log, agent?: AgentKind, write = runAgent): Promise<string> {
  const pid = projectId();
  const { description, from, to, retellId } = request;
  const existing = await listSuggestions(pid);
  const retell = retellId ? existing.find((s) => s.id === retellId) : undefined;
  if (retellId && !retell) throw Object.assign(new Error("That suggestion no longer exists"), { status: 404 });

  const namedCommits = [...new Set([...request.commits, ...(retell?.sources.commits ?? [])])];
  const named = (await Promise.all(namedCommits.map((ref) => commitsByHash([ref]).catch(() => [])))).flat();
  const around = (await Promise.all(activeSources().map((s) => inContext({ sourceId: s.id }, () => collectCommitsBetween(from, to))))).flat();
  const commits = [...new Map([...around, ...named].map((c) => [commitRef(c), c])).values()].sort((a, b) => a.date.localeCompare(b.date));

  // The agent sees the images of the ticked and retold materials first, then those nearest the middle of the period.
  const middle = (Date.parse(from) + Date.parse(to)) / 2;
  const distance = (m: Material) => Math.abs(Date.parse(m.date) - middle);
  const namedMaterials = await getMaterials(pid, [...new Set([...request.materialIds, ...(retell?.materialIds ?? [])])]);
  const nearby = (await listMaterials(pid, { from, to })).sort((a, b) => distance(a) - distance(b));
  const materials = [...new Map([...namedMaterials, ...nearby].map((m) => [m.id, m])).values()];
  const agentMaterials = await materialsForAgent(materials);

  const records = (await listRecords(pid)).filter((r) => r.visibility !== "excluded");
  const inPeriod = (r: ActivityRecord) => r.date >= from && r.date <= to;
  const sessions = records.filter((r) => r.kind === "session" && (inPeriod(r) || retell?.sources.sessions?.includes(r.id)));
  const related = records.filter((r) => (r.connector === "github" || r.connector === "forgejo") && inPeriod(r));
  const posts = await listPosts(pid);
  const titleOf = new Map(existing.map((s) => [s.id, s.title]));
  const evidence = {
    range: { since: from, toCommit: to },
    description,
    required: { commits: request.commits, notes: request.notes, materials: request.materialIds },
    retell: retell ? { id: retell.id, title: retell.title, hook: retell.hook, summary: retell.summary, whyItMatters: retell.whyItMatters, highlights: retell.highlights, materials: retell.materialIds, suggestedShots: retell.suggestedShots } : undefined,
    commits,
    workingChanges: [],
    notes: (await listNotes(pid)).filter((n) => n.date >= from && n.date <= to).map((n) => ({ date: n.date, text: n.text })),
    materials: agentMaterials.lines,
    sessions: sessions.map(sessionFacts),
    related: related.map((r) => ({ date: r.date, kind: r.kind, title: r.title, summary: r.summary, commits: r.refs.commits, private: r.visibility === "private" })),
    existingSuggestions: existing.map(({ id, title, hook, summary, highlights, status, workDate, publishDate, postId }) => ({ id, title, hook, summary, highlights, status, workDate, publishDate, inPost: !!postId })),
    posts: posts.map((p) => ({ id: p.id, title: p.title, stage: p.stage, publishDate: p.publishDate, topics: p.suggestionIds.map((id) => titleOf.get(id)).filter(Boolean) })),
  };
  log(`${commits.length} commits, ${sessions.length} sessions, ${materials.length} materials, ${existing.length} suggestions and ${posts.length} posts from ${from} to ${to}.`);

  const runId = newId("run");
  const { output, costUsd } = await write<RawStoryDraft>({
    prompt: storyDraftPrompt(writeEvidence(runId, evidence), from, to, description, !!retell),
    schema: STORY_DRAFT_SCHEMA, images: agentMaterials.images, agent, log,
  });
  await saveRun(pid, runId, "storyDraft", evidence, output);
  logCost(log, costUsd);

  const [raw] = normalizeAgentCommits([output.suggestion], commits, log);
  const knownMaterials = new Set(materials.map((m) => m.id));
  const knownSessions = new Set(sessions.map((r) => r.id));
  const shots = output.shots.map(({ description: shot, materialId }) => (knownMaterials.has(materialId) ? { description: shot, materialId } : { description: shot }));
  const byId = new Map(existing.map((s) => [s.id, s]));
  const proposedAbsorbs = output.absorbs.flatMap((a) => { const s = byId.get(a.suggestionId); return s && s.id !== retell?.id ? [{ s, reason: a.reason }] : []; });
  const absorbs = proposedAbsorbs.filter(({ s }) => canEdit(s)).map(({ s, reason }) => ({ suggestionId: s.id, title: s.title, reason }));
  if (retell && canEdit(retell)) absorbs.unshift({ suggestionId: retell.id, title: retell.title, reason: "You asked to tell this one differently." });
  const stuck = proposedAbsorbs.filter(({ s }) => !canEdit(s) && s.postId).map(({ s, reason }) => ({ title: s.title, reason }));
  let workDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.workDate) ? raw.workDate : retell?.workDate ?? to;
  if (workDate < from || workDate > to) workDate = retell?.workDate ?? to;

  const draft: StoryDraft = {
    id: newId("story"),
    createdAt: new Date().toISOString(),
    request,
    suggestion: {
      workDate,
      title: raw.title,
      hook: raw.hook,
      summary: raw.summary,
      whyItMatters: raw.whyItMatters,
      kind: raw.kind,
      appeal: raw.appeal,
      recommendedFormat: raw.recommendedFormat,
      sources: {
        commits: [...new Set([...request.commits, ...raw.commits])],
        files: raw.files,
        notes: [...new Set([...request.notes, ...raw.notes])],
        sessions: raw.sessions.filter((id) => knownSessions.has(id)),
      },
      materialIds: [...new Set([...request.materialIds, ...raw.materials.filter((id) => knownMaterials.has(id)), ...shots.flatMap((s) => s.materialId ?? [])])],
      suggestedShots: shots.map((s) => s.description),
      highlights: description,
    },
    absorbs,
    related: [...output.related, ...stuck],
    leftOut: output.leftOut,
    unsupported: output.unsupported,
    shots,
  };
  await saveStoryDrafts([...(await listStoryDrafts()), draft]);
  log(`Draft ready: "${raw.title}".`);
  return draft.id;
}

export async function discardStoryDraft(id: string) {
  await saveStoryDrafts((await listStoryDrafts()).filter((d) => d.id !== id));
}

/** Adds the draft as a suggestion and marks the chosen suggestions as merged. One that has since gone into a post or out of the list stays as it is, and a material deleted since the draft is dropped. */
export async function acceptStoryDraft(id: string, absorb: string[]): Promise<Suggestion> {
  const drafts = await listStoryDrafts();
  const draft = drafts.find((d) => d.id === id);
  if (!draft) throw Object.assign(new Error("That draft no longer exists"), { status: 404 });
  const stored = new Set((await listSuggestions(projectId())).map((s) => s.id));
  const offered = draft.absorbs.map((a) => a.suggestionId).filter((a) => absorb.includes(a) && stored.has(a));
  const present = new Set((await listMaterials(projectId())).map((m) => m.id));
  const materialIds = draft.suggestion.materialIds.filter((id) => present.has(id));
  let created!: Suggestion;
  await updateSuggestions(projectId(), offered, (found) => {
    const parts = found.filter(canEdit);
    created = {
      ...draft.suggestion,
      materialIds,
      id: newId("sug"),
      createdAt: new Date().toISOString(),
      publishDate: parts.find((p) => p.publishDate)?.publishDate,
      status: "proposed",
      ...(parts.length ? { mergedFrom: parts.map((p) => p.id) } : {}),
    };
    for (const p of parts) p.status = "merged";
    return [created];
  });
  await saveStoryDrafts(drafts.filter((d) => d.id !== id));
  return created;
}

export async function mergeSuggestions(ids: string[]): Promise<Suggestion> {
  let merged!: Suggestion;
  await updateSuggestions(projectId(), ids, (found) => {
    const parts = ids.map((id) => found.find((x) => x.id === id)).filter((x): x is Suggestion => !!x);
    if (parts.length < 2) throw Object.assign(new Error("Select at least two suggestions to merge"), { status: 400 });
    const uniq = (xs: string[]) => [...new Set(xs)];
    merged = {
      id: newId("sug"),
      createdAt: new Date().toISOString(),
      workDate: parts.map((p) => p.workDate).sort().at(-1)!,
      publishDate: parts.find((p) => p.publishDate)?.publishDate,
      title: parts.map((p) => p.title).join(" + "),
      hook: parts[0].hook,
      summary: parts.map((p) => p.summary).join("\n\n"),
      whyItMatters: parts.map((p) => p.whyItMatters).join(" "),
      kind: parts[0].kind,
      appeal: Math.max(...parts.map((p) => p.appeal)),
      recommendedFormat: parts.length > 2 ? "long" : "either",
      sources: {
        commits: uniq(parts.flatMap((p) => p.sources.commits)),
        files: uniq(parts.flatMap((p) => p.sources.files)),
        notes: uniq(parts.flatMap((p) => p.sources.notes)),
        sessions: uniq(parts.flatMap((p) => p.sources.sessions ?? [])),
      },
      materialIds: uniq(parts.flatMap((p) => p.materialIds)),
      suggestedShots: uniq(parts.flatMap((p) => p.suggestedShots)),
      highlights: parts.map((p) => p.highlights).filter(Boolean).join("\n"),
      status: "proposed",
      mergedFrom: parts.map((p) => p.id),
    };
    for (const p of parts) p.status = "merged";
    return [merged];
  });
  return merged;
}

// ---------- episodes ----------

/**
 * Turns a post back into its suggestions: the post with its questions, scripts, captures and renders
 * is deleted, and the suggestions return to the approved list. Final videos in output/ stay.
 * Refused while a job runs for the post or a video of it is on YouTube.
 */
export async function revertPost(id: string, removeFiles = deletePrefix): Promise<{ suggestionIds: string[] }> {
  const pid = projectId();
  const post = await loadPost(pid, id);
  if ((await listUploads(pid, id)).some((u) => u.upload.videoId)) throw Object.assign(new Error("A video of this post is on YouTube, so the post stays."), { status: 409 });
  if ((await listPublications(pid, id)).some((p) => p.state === "published" || p.state === "publishing")) throw Object.assign(new Error("This post has already been published somewhere, so it stays."), { status: 409 });
  if (listJobs().some((j) => j.status === "running" && j.subject === `${pid}:${id}`)) throw Object.assign(new Error("Wait for the post's running job to finish."), { status: 409 });
  const suggestionIds = await deletePost(pid, id);
  await deletePostPublications(pid, id);
  await removeFiles(`episodes/${id}/`).catch(() => {});
  return { suggestionIds };
}

export async function createPost(suggestionIds: string[], outputs: Format[] | undefined, title?: string): Promise<Post> {
  if (outputs && (!outputs.length || outputs.some((o) => o !== "portrait" && o !== "landscape"))) throw new Error("Choose at least one available video output");
  const sugs = await getSuggestions(projectId(), suggestionIds);
  if (!sugs.length) throw Object.assign(new Error("No suggestions selected"), { status: 400 });
  const ep: Post = {
    outputDirs: [],
    id: newId("ep"),
    title: title || sugs.map((s) => s.title).join(" + "),
    createdAt: new Date().toISOString(),
    publishDate: sugs.find((s) => s.publishDate)?.publishDate,
    suggestionIds: sugs.map((s) => s.id),
    materialIds: [],
    outputs: outputs?.length ? outputs : getProject().settings.outputs.enabled,
    ...(getProject().settings.coHost?.enabled && getProject().settings.coHost?.defaultOn ? { presentation: Object.fromEntries((outputs?.length ? outputs : getProject().settings.outputs.enabled).map((f) => [f, "coHost" as const])) } : {}),
    outputStages: {},
    brief: "",
    questions: [],
    scripts: {},
    narration: {},
    renders: {},
    stage: "questions",
  };
  await savePost(projectId(), ep);
  await updateSuggestions(projectId(), ep.suggestionIds, (items) => {
    for (const s of items) {
      s.status = "used";
      s.postId = ep.id;
    }
  });
  return ep;
}

/** Materials of the episode's suggestions plus those attached to the episode, each with its whole group. */
export async function episodeMaterials(ep: Post): Promise<Material[]> {
  const sugs = await getSuggestions(projectId(), ep.suggestionIds);
  return getMaterials(projectId(), [...new Set([...sugs.flatMap((s) => s.materialIds), ...ep.materialIds])]);
}

/** Adds the feed entries behind a post's topics to a prompt that doesn't take the activity context. */
async function withFeeds(prompt: string, ep: Pick<Post, "suggestionIds">) {
  const feeds = await feedContext(projectId(), await getSuggestions(projectId(), ep.suggestionIds));
  return feeds ? `${prompt}\n\n${feeds}` : prompt;
}

export async function askQuestions(epId: string, log: Log, agent?: AgentKind) {
  const ep = await loadPost(projectId(), epId);
  const mats = await materialsForAgent(await episodeMaterials(ep));
  const { output, costUsd } = await runAgent<{ questions: Array<{ question: string; why: string }> }>({
    prompt: await withFeeds(questionsPrompt(ep, await getSuggestions(projectId(), ep.suggestionIds), mats.lines), ep),
    schema: QUESTIONS_SCHEMA,
    images: mats.images,
    agent,
    log,
  });
  logCost(log, costUsd);
  await saveRun(projectId(), newId("run"), "questions", { postId: epId }, output);
  await updatePost(projectId(), epId, (e) => {
    const answered = e.questions.filter((q) => q.answer.trim());
    e.questions = [...answered, ...output.questions.map((q) => ({ id: newId("q"), question: q.question, why: q.why, answer: "" }))];
  });
  log(`${output.questions.length} question(s).`);
}

/** Scene object paths for names that appear in the topics' commits and files; empty when Unity is not reachable. */
async function knownObjects(sugs: Suggestion[], log: Log): Promise<string[]> {
  // Object paths come from a Unity target: the default one, or else the first.
  const settings = getProject().settings;
  const unityTargets = settings.captureTargets.filter((t) => t.kind === "unity-mcp");
  const unity = unityTargets.find((t) => t.id === settings.defaultCaptureTargetId) ?? unityTargets[0];
  if (!unity) return [];
  try {
    const v = await captureOperation(unity.id, "status");
    if (!v.ok) {
      log(`Unity MCP is connected to ${v.detail}, not this project; skipping object lookup.`);
      return [];
    }
  } catch {
    log("Unity MCP not reachable; the script will use object names without paths.");
    return [];
  }
  const names = new Set<string>();
  for (const s of sugs) {
    for (const f of s.sources.files) if (/\.prefab$/i.test(f)) names.add(path.basename(f, ".prefab"));
    for (const c of s.sources.commits.slice(0, 8)) {
      const [sourceId, hash] = c.split(":");
      const source = getProject().settings.sources.find((s) => s.id === sourceId);
      if (!source) continue;
      const { stdout } = await run("git", ["show", "-U0", "--format=", hash, "--", "*.unity", "*.prefab"], { cwd: source.path, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).catch(() => ({ stdout: "" }));
      for (const m of stdout.matchAll(/^\+\s+m_Name:\s*(.+)$/gm)) names.add(m[1].trim());
    }
  }
  // Proper nouns in the topics ("North Gate", "Alex Kim") usually name scene objects.
  const text = sugs.map((s) => [s.title, s.summary, s.highlights, ...s.suggestedShots].join(" ")).join(" ");
  for (const m of text.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b/g)) names.add(m[0]);
  const paths = new Set<string>();
  for (const n of [...names].filter((n) => n.length > 3).slice(0, 40)) {
    for (const o of await captureOperation(unity.id, "objects", n, 6).catch(() => [])) if (o.active) paths.add(o.path);
    if (paths.size >= 80) break;
  }
  return [...paths].slice(0, 80);
}

interface RawSegment {
  /** Solo scripts. */
  narration?: string;
  /** Co-hosted scripts. */
  turns?: Array<{ speaker: Speaker; text: string }>;
  onScreen: string;
  visual: {
    type: "capture" | "material" | "slide";
    description: string;
    target: string;
    targetId?: string;
    /** "page" for a browser target's webpage shot; "scene" or "" otherwise. */
    shotModel?: string;
    url?: string;
    device?: string;
    scrollTo?: string;
    credit?: string;
    expectText?: string;
    highlightText?: string;
    motion: "still" | "orbit" | "push" | "pan" | "turn" | "rise";
    angle: ShotAngle;
    distance: ShotDistance;
    materialId: string;
    layout: "title" | "bullets" | "image" | "compare" | "stack" | "outro" | "none";
    entrance: "drop" | "slide";
    heading: string;
    bullets: string[];
    imageFrom: string[];
  };
}

export function normalizeScript(raw: { title: string; segments: RawSegment[]; metadata: Script["metadata"] }, format: Format, materialIds: string[]): Script {
  const known = new Set(materialIds);
  const segments: Segment[] = raw.segments.map((r) => ({ id: newId("seg"), narration: r.narration?.trim() ?? "", turns: r.turns?.map((t) => ({ id: newId("turn"), speaker: t.speaker, text: t.text.trim() })), onScreen: r.onScreen.trim() || undefined, visual: { type: "slide", layout: "title", heading: "" } as Visual }));
  raw.segments.forEach((r, i) => {
    const v = r.visual;
    if (v.type === "capture" && v.shotModel === "page") {
      const scrollTo = v.scrollTo?.trim() ?? "";
      const device = v.device === "phone" || v.device === "desktop" ? v.device : undefined;
      segments[i].visual = { type: "capture", targetId: v.targetId || undefined, description: v.description, shot: { ...newPageShot(v.url?.trim() ?? ""), device, scrollTo: /^\d+(\.\d+)?$/.test(scrollTo) ? Number(scrollTo) : scrollTo || 0, ...(v.credit?.trim() ? { credit: v.credit.trim() } : {}), ...(v.expectText?.trim() ? { expect: v.expectText.trim() } : {}), ...(v.highlightText?.trim() ? { highlight: v.highlightText.trim() } : {}) } };
    } else if (v.type === "capture") {
      segments[i].visual = { type: "capture", targetId: v.targetId || undefined, description: v.description, shot: { model: "scene", target: v.target || undefined, angle: v.angle, distance: v.distance, motion: { type: v.motion || "still" } } };
    } else if (v.type === "material") {
      segments[i].visual = { type: "material", description: v.description, materialId: known.has(v.materialId) ? v.materialId : undefined };
    } else {
      const imageFrom = v.imageFrom
        .map((ref) => {
          const m = /^seg:(\d+)$/.exec(ref.trim());
          if (m) {
            const n = Number(m[1]);
            return n < i && raw.segments[n].visual.type !== "slide" ? segments[n].id : undefined;
          }
          return known.has(ref.trim()) ? ref.trim() : undefined;
        })
        .filter((x): x is string => !!x);
      segments[i].visual = {
        type: "slide",
        layout: v.layout === "none" ? "title" : v.layout,
        heading: v.heading,
        bullets: v.bullets.length ? v.bullets : undefined,
        imageFrom: imageFrom.length ? imageFrom : undefined,
        entrance: v.layout === "stack" ? v.entrance ?? "drop" : undefined,
        ...(v.credit?.trim() ? { credit: v.credit.trim() } : {}),
      };
    }
  });
  return { format, title: raw.title, segments, metadata: raw.metadata };
}

type WriteAgent = typeof runAgent;

/** Writes the post's article: a first draft, then a read-through. Questions and answers are shared with the post's videos. */
export async function writeArticle(epId: string, log: Log, agent?: AgentKind, write: WriteAgent = runAgent) {
  const ep = await loadPost(projectId(), epId);
  const sugs = await getSuggestions(projectId(), ep.suggestionIds);
  const materials = await episodeMaterials(ep);
  const mats = await materialsForAgent(materials);
  const choices = await articleImageChoices(ep, materials.map((m) => m.id));
  const { output, costUsd } = await write<{ title: string; summary: string; tags: string[]; body: string; images: Array<{ id: string; alt: string }>; coverId: string }>({
    prompt: articlePrompt(ep, sugs, mats.lines, choices.map((c) => ({ id: c.id, title: c.title })), await activityContext(projectId(), ep)),
    schema: ARTICLE_SCHEMA, images: mats.images, agent, log,
  });
  logCost(log, costUsd);
  let body = output.body.trim();
  const known = new Set(choices.map((c) => c.id));
  for (const id of imageRefs(body)) if (!known.has(id)) { body = body.replaceAll(`{{image:${id}}}`, "").trim(); log(`Removed a reference to an unknown picture: ${id}`); }
  if (config().agent.scriptReview) {
    try {
      log("Reading the article through as a first-time reader…");
      const review = await write<{ body: string; changes: string[] }>({ prompt: articleReviewPrompt(output.title, body), schema: ARTICLE_REVIEW_SCHEMA, agent, log });
      logCost(log, review.costUsd);
      // A read-through that loses a picture isn't used, because it was asked to keep them all.
      if (review.output.body.trim() && imageRefs(body).every((id) => review.output.body.includes(`{{image:${id}}}`))) {
        body = review.output.body.trim();
        for (const change of review.output.changes) log(`  ${change}`);
      }
    } catch (err) {
      log(`Read-through skipped: ${(err as Error).message}`);
    }
  }
  await updatePost(projectId(), epId, (e) => {
    e.article = {
      ...e.article, stage: "images",
      draft: { title: output.title.trim(), summary: output.summary.trim(), tags: output.tags, body, agentBody: body, coverId: known.has(output.coverId) ? output.coverId : undefined, slug: slugOf(output.title), images: Object.fromEntries(output.images.filter((i) => known.has(i.id)).map((i) => [i.id, { alt: i.alt.trim() }])) },
    };
    if (!e.outputs.includes("article")) e.outputs = [...e.outputs, "article"];
  });
  log(`Article: ${body.split(/\s+/).length} words.`);
}

/** Writes a publication's short text. The link stays a placeholder that only the server fills in. */
export async function writeSocialText(publicationId: string, log: Log, agent?: AgentKind, write: WriteAgent = runAgent) {
  const pid = projectId();
  const publication = (await listPublications(pid)).find((p) => p.id === publicationId);
  if (!publication) throw Object.assign(new Error("This publication no longer exists."), { status: 404 });
  const ep = await loadPost(pid, publication.postId);
  const all = await listPublications(pid, ep.id);
  const dep = publication.dependsOn[0]?.publicationId;
  const toYoutube = !!dep && isYoutubePublicationId(dep);
  const toArticle = dep && !toYoutube && ["folder", "git-site"].includes(all.find((p) => p.id === dep)?.connector ?? "");
  const placeholder = toYoutube ? " {{youtube.url}}" : toArticle ? " {{article.url}}" : "";
  const limit = (TEXT_LIMIT[publication.connector] ?? 300) - (placeholder ? PLACEHOLDER_LENGTH + 1 : 0);
  const sugs = await getSuggestions(pid, ep.suggestionIds);
  const { output, costUsd } = await write<{ text: string }>({ prompt: await withFeeds(socialTextPrompt(ep, sugs, CONNECTOR_LABEL[publication.connector], limit, toYoutube ? "video" : toArticle ? "article" : undefined), ep), schema: SOCIAL_TEXT_SCHEMA, agent, log });
  logCost(log, costUsd);
  await updatePublication(publicationId, { content: { text: `${output.text.trim()}${placeholder}`, title: publication.content.title ?? ep.title } });
  log("Text written.");
}

/** Writes a script without storing it: first draft, read-through and, for a co-hosted format, verification. */
export async function generateScript(ep: Post, format: Format, log: Log, agent?: AgentKind, write: WriteAgent = runAgent) {
  const coHosted = ep.presentation?.[format] === "coHost";
  const sugs = await getSuggestions(projectId(), ep.suggestionIds);
  const materials = await episodeMaterials(ep);
  const mats = await materialsForAgent(materials);
  const objects = await knownObjects(sugs, log);
  log(`${objects.length} scene object path(s) resolved for framing; ${materials.length} material(s).`);
  const definition = videoOutput(format);
  const settings = getProject().settings.coHost;
  const earlierCoHosted = coHosted && !settings?.alwaysDisclose && (await listPosts(projectId())).some((p) => p.id !== ep.id && Object.values(p.presentation ?? {}).includes("coHost") && Object.values(p.renders).some((r) => r?.final));
  const ctx = { post: ep, suggestions: sugs, materials: mats.lines, materialIds: materials.map((m) => m.id), knownObjects: objects, coHostDiscloses: coHosted && !earlierCoHosted };
  const activity = await activityContext(projectId(), ep);
  const prompt = [definition.writer.prompt(ctx), activity].filter(Boolean).join("\n\n");
  const { output, costUsd } = await write<{ title: string; segments: RawSegment[]; metadata: Script["metadata"] }>({
    prompt,
    schema: definition.writer.schema(ctx),
    images: mats.images,
    agent,
    log,
  });
  logCost(log, costUsd);
  const raw = structuredClone(output);
  const edits = !config().agent.scriptReview ? [] : coHosted ? await reviewDialogue(output, format, log, agent, write) : await reviewScript(output, format, log, agent, write);
  const script = definition.writer.normalize(output, ctx);
  if (coHosted) await verifyAndFix(ep, script, mats.images, log, agent, write);
  for (const seg of script.segments) {
    seg.agentNarration = seg.narration;
    for (const turn of seg.turns ?? []) turn.agentText = turn.text;
  }
  return { script, prompt, raw, review: edits, final: output };
}

export async function writeScript(epId: string, format: Format, log: Log, agent?: AgentKind, write: WriteAgent = runAgent) {
  const ep = await loadPost(projectId(), epId);
  const { script, prompt, raw, review, final } = await generateScript(ep, format, log, agent, write);
  const runId = newId("run");
  await saveRun(projectId(), runId, "script", { postId: epId, format, prompt }, { raw, review, final, verification: script.verification });
  await updatePost(projectId(), epId, (e) => {
    script.runId = runId;
    e.scripts[format] = script;
    delete e.narration[format];
    setOutputStage(e, format, "script");
  });
  log(`Script: ${script.segments.length} segments.`);
}

/** One read-only check of a script's co-host lines. The fingerprint is taken first, so an edit during the run shows as out of date. */
async function verifyLines(ep: Post, script: Script, images: string[], accepted: string[], log: Log, agent: AgentKind | undefined, write: WriteAgent) {
  const evidence = await evidenceSnapshot(projectId(), ep);
  const fingerprint = verificationFingerprint(script, ep, evidence);
  const { output, costUsd } = await write<{ claims: VerifiedClaim[] }>({ prompt: verifyPrompt(script, answersOf(ep), evidence), schema: VERIFY_SCHEMA, images, agent, log });
  logCost(log, costUsd);
  return verificationResult(script, ep, evidence, fingerprint, output.claims, accepted);
}

/** Verifies a new script and rewrites unsupported co-host lines once; what remains becomes flags. A failed check leaves the script unverified. */
async function verifyAndFix(ep: Post, script: Script, images: string[], log: Log, agent: AgentKind | undefined, write: WriteAgent) {
  try {
    log("Checking the co-host's lines against their sources…");
    let verification = await verifyLines(ep, script, images, [], log, agent, write);
    if (verification.flags.length) {
      log(`${verification.flags.length} unsupported claim(s); rewriting those lines once.`);
      const { output, costUsd } = await write<{ edits: TurnEdit[] }>({ prompt: fixClaimsPrompt(script, verification.flags), schema: TURN_EDITS_SCHEMA, agent, log });
      logCost(log, costUsd);
      const flagged = new Set(verification.flags.map((f) => f.turnId));
      for (const e of output.edits) {
        const turn = script.segments[e.segment]?.turns?.[e.turn];
        if (turn && flagged.has(turn.id) && e.text.trim()) turn.text = e.text.trim();
      }
      verification = await verifyLines(ep, script, images, [], log, agent, write);
    }
    script.verification = verification;
    log(verification.flags.length ? `Check: ${verification.flags.length} flag(s) for you to resolve.` : "Check: every co-host claim has a source.");
  } catch (err) {
    log(`Check of the co-host's lines failed: ${(err as Error).message}`);
  }
}

/** Runs **Check co-host lines**: it flags and never rewrites. */
export async function checkCoHostLines(epId: string, format: Format, log: Log, agent?: AgentKind, write: WriteAgent = runAgent) {
  const ep = await loadPost(projectId(), epId);
  const script = ep.scripts[format];
  if (!script || ep.presentation?.[format] !== "coHost") throw Object.assign(new Error("This video has no co-hosted script."), { status: 400 });
  const { images } = await materialsForAgent(await episodeMaterials(ep));
  const verification = await verifyLines(ep, script, images, script.verification?.accepted ?? [], log, agent, write);
  await updatePost(projectId(), epId, (e) => {
    const current = e.scripts[format];
    if (current) current.verification = verification;
  });
  log(verification.flags.length ? `Check: ${verification.flags.length} flag(s).` : "Check: every co-host claim has a source.");
}

interface TurnEdit {
  segment: number;
  turn: number;
  text: string;
  reason: string;
}

/** Read-through pass of a conversation: applies the agent's line fixes in place and returns them. */
async function reviewDialogue(script: { title: string; segments: RawSegment[] }, format: Format, log: Log, agent: AgentKind | undefined, write: WriteAgent): Promise<TurnEdit[]> {
  log("Reading the conversation through as a viewer…");
  try {
    const segments = script.segments.map((s, i) => ({ id: String(i), narration: "", turns: (s.turns ?? []).map((t, k) => ({ id: `${i}-${k}`, ...t })), visual: { type: "slide", layout: "title", heading: s.visual.heading || s.visual.description } as Visual }));
    const { output, costUsd } = await write<{ edits: TurnEdit[] }>({ prompt: dialogueReviewPrompt(format, { title: script.title, segments }), schema: TURN_EDITS_SCHEMA, agent, log });
    logCost(log, costUsd);
    const applied = output.edits.filter((e) => script.segments[e.segment]?.turns?.[e.turn] && e.text.trim());
    for (const e of applied) {
      const turn = script.segments[e.segment].turns![e.turn];
      log(`  ${turn.speaker}: "${turn.text}" → "${e.text.trim()}" (${e.reason})`);
      turn.text = e.text.trim();
    }
    log(applied.length ? `Read-through changed ${applied.length} line(s).` : "Read-through: no changes needed.");
    return applied;
  } catch (err) {
    // The first draft stays usable when the review pass fails.
    log(`Read-through skipped: ${(err as Error).message}`);
    return [];
  }
}

interface ReviewEdit {
  index: number;
  narration: string;
  reason: string;
}

/** Read-through pass: applies the agent's narration fixes in place and returns them. Visuals never change. */
async function reviewScript(script: { title: string; segments: RawSegment[] }, format: Format, log: Log, agent: AgentKind | undefined, write: WriteAgent): Promise<ReviewEdit[]> {
  log("Reading the script through as a viewer…");
  try {
    const { output, costUsd } = await write<{ edits: ReviewEdit[] }>({ prompt: reviewPrompt(format, script as Parameters<typeof reviewPrompt>[1]), schema: REVIEW_SCHEMA, agent, log });
    logCost(log, costUsd);
    const applied = output.edits.filter((e) => Number.isInteger(e.index) && e.index >= 0 && e.index < script.segments.length && e.narration.trim());
    for (const e of applied) {
      log(`  Line ${e.index + 1}: "${script.segments[e.index].narration}" → "${e.narration.trim()}" (${e.reason})`);
      script.segments[e.index].narration = e.narration.trim();
    }
    log(applied.length ? `Read-through changed ${applied.length} line(s).` : "Read-through: no changes needed.");
    return applied;
  } catch (err) {
    // The first draft stays usable when the review pass fails.
    log(`Read-through skipped: ${(err as Error).message}`);
    return [];
  }
}

// ---------- capture ----------

function segmentSeconds(seg: Segment) {
  return Math.min(12, Math.max(4, estimatedSpeechMs(seg) / 1000 + 1.5));
}

/** Deletes a take's media and its poster frame. */
async function removeTakeFiles(media: string) {
  await deleteKey(media).catch(() => {});
  if (/\.mp4$/.test(media)) await deleteKey(media.replace(/\.mp4$/, ".jpg")).catch(() => {});
}

/**
 * Goes back to a segment's previous take for one format: its media and the visual settings that produced
 * it. The current take is deleted.
 */
export async function previousTake(epId: string, segmentId: string, format: Format) {
  let discarded: string | undefined;
  const post = await updatePost(projectId(), epId, (ep) => {
    const seg = ep.scripts[format]?.segments.find((s) => s.id === segmentId);
    const takes = seg?.takes?.[format];
    if (!seg || !takes || takes.length < 2) throw Object.assign(new Error("This shot has no earlier take."), { status: 400 });
    discarded = takes.pop()!.media;
    const back = takes.at(-1)!;
    seg.media = { ...seg.media, [format]: back.media };
    seg.mediaSeconds = { ...seg.mediaSeconds, [format]: back.mediaSeconds };
    seg.capturedAt = back.capturedAt;
    seg.captureError = undefined;
    if (back.visual) seg.visual = back.visual;
  });
  if (discarded) await removeTakeFiles(discarded);
  return post;
}

async function captureSegment(ep: Post, seg: Segment, format: Format, log: Log, capture = renderCapture): Promise<string | undefined> {
  if (seg.visual.type !== "capture") return;
  const fps = config().render.fps;
  const result = await capture(seg.visual, { dir: path.join(CACHE_DIR, "captures", ep.id, `${seg.id}-${format}`), format, frames: Math.round(segmentSeconds(seg) * fps), fps }, log);
  // Every capture gets its own key, so earlier takes stay available.
  const capturedAt = Date.now();
  const keyBase = `episodes/${ep.id}/captures/${seg.id}-${format}-${capturedAt.toString(36)}`;
  const key = keyBase + path.extname(result.file);
  await putFile(key, result.file);
  if (result.poster) { await putFile(`${keyBase}.jpg`, result.poster); fs.rmSync(result.poster, { force: true }); }
  fs.rmSync(result.file, { force: true });
  const current = seg.media?.[format];
  const takes = seg.takes?.[format] ?? (current ? [{ media: current, mediaSeconds: seg.mediaSeconds?.[format], capturedAt: seg.capturedAt ?? 0 }] : []);
  takes.push({ media: key, mediaSeconds: result.durationSeconds, capturedAt, visual: structuredClone(seg.visual) });
  for (const dropped of takes.splice(0, Math.max(0, takes.length - MAX_TAKES))) await removeTakeFiles(dropped.media);
  seg.takes = { ...seg.takes, [format]: takes };
  seg.media = { ...seg.media, [format]: key };
  seg.mediaSeconds = { ...seg.mediaSeconds, [format]: result.durationSeconds };
  return result.warning;
}

export async function capturePost(epId: string, format: Format, log: Log, onlySegment?: string) {
  const session = createCaptureSession();
  const ep = await loadPost(projectId(), epId);
  const script = ep.scripts[format];
  if (!script) throw new Error(`No ${format} script`);
  let ok = 0;
  let failed = 0;
  let cancelled = false;
  for (const seg of script.segments) {
    if (onlySegment && seg.id !== onlySegment) continue;
    if (seg.visual.type === "material") {
      seg.captureError = seg.visual.materialId ? undefined : "Record this footage, upload it as a material and choose it here.";
      continue;
    }
    if (seg.visual.type !== "capture") { seg.captureError = undefined; continue; }
    if (currentJobSignal()?.aborted) { cancelled = true; break; }
    log(`Capturing ${seg.visual.description.slice(0, 70)}…`);
    try {
      seg.captureError = await captureSegment(ep, seg, format, log, session.render);
      if (seg.captureError) log(`  warning: ${seg.captureError}`);
      seg.capturedAt = Date.now();
      ok++;
    } catch (err) {
      // A cancelled shot keeps its previous take.
      if (err instanceof CancelledError) { cancelled = true; break; }
      seg.captureError = (err as Error).message;
      failed++;
      log(`  failed: ${seg.captureError}`);
    }
  }
  // Merge capture results into the latest saved episode so concurrent edits survive.
  await updatePost(projectId(), epId, (fresh) => {
    for (const seg of fresh.scripts[format]?.segments ?? []) {
      const done = script.segments.find((s) => s.id === seg.id);
      if (!done) continue;
      seg.media = done.media;
      seg.mediaSeconds = done.mediaSeconds;
      seg.takes = done.takes;
      seg.captureError = done.captureError;
      seg.capturedAt = done.capturedAt;
    }
    if (outputStage(fresh, format) === "script") setOutputStage(fresh, format, "capture");
  });
  log(`Captured ${ok}, failed ${failed}.`);
  // Shots captured before the cancel are saved above; the job still ends as cancelled.
  if (cancelled) throw new CancelledError();
}

/** Stores the current Scene view camera as the segment's pose (used by all formats). */
export async function useSceneViewPose(epId: string, segmentId: string) {
  const post = await loadPost(projectId(), epId);
  const visual = Object.values(post.scripts).flatMap((s) => s?.segments ?? []).find((s) => s.id === segmentId)?.visual;
  if (visual?.type !== "capture") throw new Error("Choose a capture shot");
  const pose = await captureOperation(visual.targetId, "view");
  await updatePost(projectId(), epId, (ep) => {
    for (const format of ep.outputs.filter((f): f is Format => f !== "article")) {
      const seg = ep.scripts[format]?.segments.find((s) => s.id === segmentId);
      if (seg?.visual.type === "capture" && seg.visual.shot.model === "scene") {
        seg.visual.shot.pose = { position: pose.position, rotation: pose.rotation, fov: pose.fov };
        seg.visual.shot.pivot = pose.pivot;
        seg.visual.shot.pivotObject = pose.pivotObject;
      }
    }
  });
  return pose;
}

// ---------- narration and rendering ----------

/**
 * Sets a format's presentation. A change removes that format's script, takes and render record and returns it
 * to questions; the other format, the answers and rendered files stay. An uploaded format can't change.
 */
export async function setPresentation(epId: string, format: Format, presentation: Presentation, confirmed: boolean) {
  const refuse = (status: number, message: string) => Object.assign(new Error(message), { status });
  if (presentation !== "solo" && presentation !== "coHost") throw refuse(400, "Choose solo or co-hosted.");
  if (presentation === "coHost" && !getProject().settings.coHost?.enabled) throw refuse(400, "Turn on the co-host in the project settings first.");
  return updatePost(projectId(), epId, async (ep) => {
    if (!ep.outputs.includes(format)) throw refuse(400, "This post has no such video.");
    if ((ep.presentation?.[format] ?? "solo") === presentation) return;
    if ((await getUpload(projectId(), epId, format))?.videoId) throw refuse(409, "This video is on YouTube, so its presentation can't change.");
    if (ep.scripts[format] && !confirmed) throw refuse(409, "Changing the presentation deletes this video's script and narration. Confirm first.");
    ep.presentation = { ...ep.presentation, [format]: presentation };
    delete ep.scripts[format];
    delete ep.narration[format];
    delete ep.renders[format];
    setOutputStage(ep, format, "questions");
  });
}

/** Narrates a script; line IDs in `force` get a fresh take even if their text is cached. */
export async function narratePost(epId: string, format: Format, log: Log, force: string[] = []) {
  const ep = await loadPost(projectId(), epId);
  const script = ep.scripts[format];
  if (!script) throw new Error(`No ${format} script`);
  const takes = await narrate(script.segments, log, new Set(force));
  await updatePost(projectId(), epId, (e) => {
    e.narration[format] = takes;
    setOutputStage(e, format, "narrated");
  });
}

/** Title, description and tags as published: description, chapters, hashtags (shorts) and the standard attribution. */
export function publishPackage(script: Script, format: Format, chapterLines: string[], disclosure?: string): PublishPackage {
  const hashtags = format === "portrait" ? ["#Shorts", ...script.metadata.tags.slice(0, 4).map((t) => `#${t.replace(/[^\p{L}\p{N}]+/gu, "")}`)].join(" ") : "";
  const attribution = config().publishing.attribution.trim();
  const description = [script.metadata.description.trim(), disclosure, chapterLines.join("\n"), hashtags, attribution].filter(Boolean).join("\n\n");
  return { title: script.metadata.title.trim(), description, tags: script.metadata.tags };
}

/**
 * When the video goes public: on the episode's publish date at its time (or the YouTube default time).
 * No date, or a moment already past, publishes on upload.
 */
export function publishMoment(ep: Post): string | undefined {
  if (!ep.publishDate) return undefined;
  const time = /^\d{2}:\d{2}$/.test(ep.publishTime ?? "") ? ep.publishTime! : config().youtube.publishTime || "17:00";
  const at = new Date(`${ep.publishDate}T${time}:00`);
  return at.getTime() > Date.now() + 60_000 ? at.toISOString() : undefined;
}

/** The final OK for a format's final render; with upload, starts the YouTube upload right away. */
export async function approveRender(epId: string, format: Format) {
  await updatePost(projectId(), epId, async (e) => {
    const r = e.renders[format];
    if (!r?.final || !r.package) throw Object.assign(new Error("Render the final video first."), { status: 400 });
    if (!fs.existsSync(r.final)) throw Object.assign(new Error(`The final file is missing: ${r.final}`), { status: 400 });
    await assertCoHostVerified(e, format);
    r.approvedAt = new Date().toISOString();
  });
}

export async function revokeApproval(epId: string, format: Format) {
  await updatePost(projectId(), epId, async (e) => {
    const r = e.renders[format];
    if ((await getUpload(projectId(), epId, format))?.videoId) throw Object.assign(new Error("Already uploaded; manage the video on YouTube."), { status: 400 });
    if (r) r.approvedAt = undefined;
  });
}

/** Uploads an approved final render: scheduled for the publish moment, or published right away. */
export async function uploadToYouTube(epId: string, format: Format, log: Log) {
  const ep = await loadPost(projectId(), epId);
  const connectionId = ep.renders[format]?.connectionId ?? getProject().settings.publishing.connectionId;
  if (!connectionId) throw new Error("Choose a YouTube connection before uploading");
  return inContext({ connectionId }, () => uploadToConnection(epId, format, log, connectionId));
}
async function uploadToConnection(epId: string, format: Format, log: Log, connectionId: string) {
  const ep = await loadPost(projectId(), epId);
  const r = ep.renders[format];
  if (!r?.approvedAt || !r.final || !r.package) throw new Error("Approve the final render first.");
  const existing = await getUpload(projectId(), epId, format);
  if (existing?.videoId) throw new Error(`Already uploaded: ${existing.url}`);
  const publishAt = publishMoment(ep);
  const privacy = config().youtube.privacyWithoutDate;
  // Script edits don't clear an approval, so the co-host check repeats here, in the transaction that starts the upload.
  await updatePost(projectId(), epId, async (e) => {
    await assertCoHostVerified(e, format);
  });
  await setUpload(projectId(), epId, format, { connectionId, status: "uploading" });
  try {
    log(publishAt ? `Scheduling for ${new Date(publishAt).toLocaleString()}.` : `Publishing on upload (${privacy}).`);
    const videoId = await uploadVideo({ file: r.final, title: r.package.title, description: r.package.description, tags: r.package.tags, publishAt, privacy, containsSyntheticMedia: ep.presentation?.[format] === "coHost" ? true : undefined }, log);
    const url = format === "portrait" ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
    log(`Uploaded: ${url}`);
    let captions = false;
    if (config().youtube.uploadCaptions && r.srt && fs.existsSync(r.srt)) {
      try {
        await uploadCaptions(videoId, r.srt);
        captions = true;
        log("Captions added.");
      } catch (err) {
        // The video stays published; captions can be added on YouTube.
        log(`Captions failed: ${(err as Error).message}`);
      }
    }
    await setUpload(projectId(), epId, format, { connectionId, videoId, url, status: publishAt ? "scheduled" : "uploaded", publishAt, privacy: publishAt ? "public" : privacy, uploadedAt: new Date().toISOString(), captions });
    await updatePost(projectId(), epId, (e) => {
      // Published right away: the episode's publish date is today, so the calendar shows it there.
      if (!e.publishDate) e.publishDate = localDate(publishAt ? new Date(publishAt) : new Date());
    });
  } catch (err) {
    await setUpload(projectId(), epId, format, { connectionId, status: "failed", error: (err as Error).message });
    throw err;
  }
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function renderVideoPost(epId: string, format: Format, quality: "draft" | "final", log: Log) {
  const ep = await loadPost(projectId(), epId);
  const timeline = await buildTimeline(ep, format, quality === "final");
  if (quality === "draft") {
    const out = path.join(CACHE_DIR, "renders", ep.id, `${format}-draft.mp4`);
    await renderVideo(timeline, out, "draft", log);
    const key = `episodes/${ep.id}/renders/${format}-draft.mp4`;
    await putFile(key, out);
    fs.rmSync(out, { force: true });
    await updatePost(projectId(), epId, (e) => {
      e.renders[format] = { ...e.renders[format], draft: key };
      if (["script", "capture"].includes(outputStage(e, format))) setOutputStage(e, format, "preview");
    });
    return [out];
  }
  const script = ep.scripts[format]!;
  if (!ep.outputDirs.length) {
    const folder = outputFolder(getProject().slug, ep, today());
    const saved = await updatePost(projectId(), epId, (p) => { if (!p.outputDirs.length) p.outputDirs = [folder]; });
    ep.outputDirs = saved.outputDirs;
  }
  const outDir = ep.outputDirs[0];
  const name = `${format === "portrait" ? "short" : "video"}-${format}`;
  const base = path.join(outDir, name);
  await renderVideo(timeline, `${base}.mp4`, "final", log);
  fs.writeFileSync(`${base}.srt`, toSrt(timeline.captions));
  const coHosted = ep.presentation?.[format] === "coHost";
  const coHost = getProject().settings.coHost;
  const pkg = publishPackage(script, format, format === "landscape" ? chapters(timeline) : [], coHosted ? (coHost ? coHostDisclosure(coHost) : "This video has an AI co-host.") : undefined);
  fs.writeFileSync(`${base}.txt`, [`Title: ${pkg.title}`, "", "Description:", pkg.description, "", `Tags: ${pkg.tags.join(", ")}`].join("\n"));
  log("Archiving the final files in Garage…");
  for (const ext of ["mp4", "srt", "txt"]) await putFile(`episodes/${ep.id}/final/${name}.${ext}`, `${base}.${ext}`);
  await updatePost(projectId(), epId, (e) => {
    // A new final render needs a new OK; an earlier upload stays recorded.
    e.renders[format] = { ...e.renders[format], final: `${base}.mp4`, srt: `${base}.srt`, meta: `${base}.txt`, package: pkg, scriptFingerprint: coHosted ? scriptFingerprint(script) : undefined, approvedAt: undefined };
    setOutputStage(e, format, "final");
  });
  log(`Final video: ${base}.mp4`);
  return ["mp4", "srt", "txt"].map((ext) => `${base}.${ext}`);
}

export async function renderPost(epId: string, format: Format, quality: "draft" | "final", log: Log) {
  const post = await loadPost(projectId(), epId);
  if (quality === "draft") return videoOutput(format).preview(epId, format, "draft", log);
  const draft = post.scripts[format];
  if (!draft) throw new Error(`No ${format} script`);
  return videoOutput(format).export(post, draft, log);
}
