import type { StoryRequest } from "../shared/types.js";
import { videoOutput } from "./outputs/index.js";
import { outputsWithSegment } from "../shared/outputs.js";
import { sourceUsage, listProjects, loadProjects, getProject, createProject, saveProject, deleteProject, resumeDeletion, checkSource, listConnections, getConnection, saveConnection, deleteConnection, publicConnection } from "./projects.js";
import type { ProjectSettings, YouTubeConnection } from "../shared/projects.js";
import { projectId, inContext } from "./context.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer as createVite } from "vite";
import { config, saveConfig, loadConfig, globalConfig, saveGlobal, publicConfig, elevenLabsKey, OUTPUT_DIR, CACHE_DIR, ROOT, type AgentKind } from "./config.js";
import { migrate } from "./db.js";
import {
  deleteNote,
  getMaterials,
  getSuggestions,
  getSnapshot,
  insertNote,
  insertSuggestion,
  listPosts,
  listMaterials,
  listNotes,
  listSuggestions,
  loadPost,
  newId,
  saveMaterial,
  saveScript,
  today,
  updatePost,
  updateSuggestions,
} from "./store.js";
import { getJob, listJobs, startJob, cancelJob } from "./jobs.js";
import {
  askQuestions,
  backfilledWeeks,
  resolveProposedEdit,
  runSessionReview,
  feedInfo, runFeedProposals, sessionReviewInfo,
  capturePost,
  createPost,
  episodeMaterials,
  mergeSuggestions,
  renderPost,
  setPresentation,
  checkCoHostLines,
  writeArticle,
  writeSocialText,
  runBackfill,
  runDiscovery,
  revertPost,
  previousTake,
  useSceneViewPose,
  writeScript,
  acceptStoryDraft,
  discardStoryDraft,
  draftStory,
  listStoryDrafts,
  uploadToYouTube,
  publishMoment,
} from "./pipeline.js";
import { authUrl, disconnect, handleCallback as youtubeCallback } from "./youtube.js";
import { getUpload } from "./egress/youtube.js";
import { postsOverview } from "./egress/overview.js";
import { latestSnapshotTime, commitCounts, commitDetails, firstCommitDate, listCommitsOn } from "./discovery.js";
import { buildTimeline } from "./timeline.js";
import { themePreview } from "./themePreview.js";
import { billableCharacters, getVoice, listVoices, subscription } from "./tts.js";
import { evidenceSnapshot, setFlagAccepted, verificationState } from "./verification.js";
import { approvePublication, cancelPublication, createPublication, deleteEgressConnection, deletePublication, egressConnectors, getEgressConnection, listEgressConnections, postPublications, publicEgressConnection, publishLateNow, startPublishJob, saveEgressConnection, schedulePublishing, updatePublication, withdrawPublication } from "./egress/publish.js";
import { postImageChoices } from "./egress/article.js";
import { linkedinAuthUrl, linkedinExchange } from "./egress/linkedin.js";
import type { ArticleDraft } from "../shared/outputs.js";
import { addSessionImage, importingSources, importSessionImages, listSessionImages, setSessionImageStatus } from "./sessionImages.js";
import { activityView, discoverSources, saveForgeToken, setManualLink, setVisibility, summarizeRecord, syncActivity } from "./ingress/sync.js";
import { captureOperation } from "./capture/provider.js";

import { handleUpload, removeMaterial } from "./materials.js";
import { listFolders } from "./folders.js";
import { serveObject } from "./storage.js";
import { startStatsRefresh, scheduleStats, statsReport } from "./stats.js";
import { checkPostLinks, pageChecks } from "./capture/browser/checks.js";
import { generateSegmentImages } from "./imagegen.js";
import { armIntake, DEFAULT_INTAKE, intakeInfo, isIntakeTime, scheduleIntake, startIntake } from "./intake.js";
import { importBumperAudio, removeBumperAudio } from "./bumperAudio.js";
import { isThemeFileKind, storeThemeFile } from "./themeFiles.js";
import { loadExtensions } from "./extensions.js";
import { applyThemePreset } from "./themePresets.js";
import type { BumperPlacement } from "../shared/bumpers.js";
import { receiveSingleFile } from "./materials.js";
import { FORMATS, normalizeGroup, type Format, type Material, type Script, type Suggestion } from "../shared/types.js";

for (const dir of [OUTPUT_DIR, CACHE_DIR]) fs.mkdirSync(dir, { recursive: true });
await migrate();
await loadExtensions();
await loadConfig();
await loadProjects();
for (const p of listProjects()) if (p.deletion) await resumeDeletion(p.id).catch((e) => console.error(`Project deletion: ${e.message}`));
scheduleStats();

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

app.post("/api/projects/check-source", async (req, res, next) => { try { res.json(await checkSource(String(req.body.path))); } catch (e) { next(e); } });
const projectApi = express.Router({ mergeParams: true });
app.use("/api/projects/:pid", (req, _res, next) => {
  try {
    const p = getProject(String(req.params.pid));
    if (p.deletion && req.method !== "GET" && !(req.method === "DELETE" && req.path === "/")) throw Object.assign(new Error("Project is being deleted"), { status: 409 });
    inContext({ projectId: p.id }, next);
  } catch (e) { next(e); }
}, projectApi);

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    next(err);
  }
};
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
const fmt = (req: Request): Format => {
  const f = req.params.format as Format;
  if (!FORMATS.includes(f)) throw bad(`Unknown format ${f}`);
  return f;
};
const agentOf = (req: Request): AgentKind | undefined => (req.body?.agent === "codex" || req.body?.agent === "claude" ? req.body.agent : undefined);
const param = (req: Request, name: string) => String(req.params[name]);
const MAX_STORY_PERIOD_DAYS = 184;
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---------- state, notes, suggestions ----------

projectApi.get(
  "/state",
  h(async () => {
    const episodes = await listPosts(projectId());
    return {
      snapshot: await getSnapshot(projectId()),
      suggestions: await listSuggestions(projectId()),
      notes: await listNotes(projectId()),
      materials: await listMaterials(projectId()),
      posts: episodes.map((e) => ({ id: e.id, title: e.title, stage: e.stage, publishDate: e.publishDate, outputs: e.outputs, createdAt: e.createdAt, suggestionIds: e.suggestionIds })),
      settings: { agent: config().agent.default, voiceSet: !!config().elevenlabs.voiceId, elevenLabsKey: !!elevenLabsKey(), gameTitle: config().gameTitle, outputs: getProject().settings.outputs.enabled },
    };
  }),
);

projectApi.post("/discover", h((req) => startJob("discover", "global", (log) => runDiscovery(log, agentOf(req)))));

projectApi.get("/feeds", h(() => feedInfo()));
projectApi.post("/feeds/propose", h((req) => startJob("feeds", "global", (log) => runFeedProposals(log, agentOf(req)))));
projectApi.get("/session-review", h(() => sessionReviewInfo()));
projectApi.post(
  "/session-review",
  h((req) => {
    const { from, to } = req.body ?? {};
    if (!isDate(from) || !isDate(to) || from > to) throw bad("Choose a valid date range");
    return startJob("sessionReview", "global", (log) => runSessionReview(from, to, req.body.rerun === true, log, agentOf(req)));
  }),
);
projectApi.post("/suggestions/:id/proposed-edit", h((req) => resolveProposedEdit(param(req, "id"), req.body?.accept === true)));

projectApi.get(
  "/backfill",
  h(async () => ({ firstCommit: await firstCommitDate(), processedWeeks: await backfilledWeeks(), lastCheck: latestSnapshotTime(await getSnapshot(projectId())) })),
);
projectApi.post(
  "/backfill",
  h((req) => {
    const { from, to } = req.body ?? {};
    if (!isDate(from) || !isDate(to) || from > to) throw bad("Choose a valid date range");
    return startJob("backfill", "global", (log) => runBackfill(from, to, req.body.rerun === true, log, agentOf(req)));
  }),
);

projectApi.get(
  "/git/counts",
  h((req) => {
    if (!isDate(req.query.from) || !isDate(req.query.to)) throw bad("from and to are required");
    return commitCounts(req.query.from, req.query.to);
  }),
);
projectApi.post(
  "/git/commits",
  h((req) => {
    const refs = req.body.refs;
    if (!Array.isArray(refs) || refs.length > 1000 || !refs.every((r) => typeof r === "string")) throw bad("refs must be a list of commit references");
    return commitDetails(refs);
  }),
);
projectApi.get(
  "/git/day",
  h((req) => {
    if (!isDate(req.query.date)) throw bad("date is required");
    return listCommitsOn(req.query.date);
  }),
);
projectApi.get("/suggestions/story-drafts", h(() => listStoryDrafts()));
projectApi.post(
  "/suggestions/story-drafts",
  h((req) => {
    const b = req.body ?? {};
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);
    const request: StoryRequest = { description: String(b.description ?? "").trim(), from: b.from, to: b.to, commits: list(b.commits), notes: list(b.notes), materialIds: list(b.materialIds), ...(typeof b.retellId === "string" ? { retellId: b.retellId } : {}) };
    if (!isDate(request.from) || !isDate(request.to) || request.from > request.to) throw bad("Choose a valid date range");
    if (Date.parse(request.to) - Date.parse(request.from) > MAX_STORY_PERIOD_DAYS * 86_400_000) throw bad(`Choose a period of at most ${MAX_STORY_PERIOD_DAYS} days`);
    if (!request.commits.every((x) => /^[a-zA-Z0-9-]+:[0-9a-f]{7,40}$/i.test(x))) throw bad("Invalid commit hash");
    if (!request.description && !request.retellId && !request.commits.length && !request.notes.length && !request.materialIds.length) throw bad("Describe the post, or tick notes, commits or materials");
    return startJob("storyDraft", "global", (log) => draftStory(request, log, agentOf(req)));
  }),
);
projectApi.post("/suggestions/story-drafts/:id/accept", h((req) => acceptStoryDraft(param(req, "id"), Array.isArray(req.body?.absorb) ? req.body.absorb : [])));
projectApi.delete("/suggestions/story-drafts/:id", h((req) => discardStoryDraft(param(req, "id"))));
projectApi.post(
  "/notes",
  h(async (req) => {
    const note = { id: newId("note"), date: isDate(req.body.date) ? req.body.date : today(), text: String(req.body.text || "").trim(), createdAt: new Date().toISOString() };
    if (!note.text) throw bad("Note text is empty");
    await insertNote(projectId(), note);
    return note;
  }),
);
projectApi.delete("/notes/:id", h((req) => deleteNote(projectId(), param(req, "id"))));

projectApi.post(
  "/suggestions",
  h(async (req) => {
    const b = req.body as Partial<Suggestion>;
    const sug: Suggestion = {
      id: newId("sug"),
      createdAt: new Date().toISOString(),
      workDate: isDate(b.workDate) ? b.workDate : today(),
      publishDate: b.publishDate,
      title: b.title || "Untitled",
      hook: b.hook || "",
      summary: b.summary || "",
      whyItMatters: b.whyItMatters || "",
      kind: b.kind || "other",
      appeal: typeof b.appeal === "number" ? Math.min(5, Math.max(1, b.appeal)) : 3,
      recommendedFormat: b.recommendedFormat || "either",
      sources: { commits: b.sources?.commits ?? [], files: b.sources?.files ?? [], notes: b.sources?.notes ?? [] },
      materialIds: b.materialIds ?? [],
      suggestedShots: b.suggestedShots ?? [],
      highlights: b.highlights || "",
      status: "proposed",
    };
    await insertSuggestion(projectId(), sug);
    return sug;
  }),
);

const EDITABLE: Array<keyof Suggestion> = ["title", "hook", "summary", "whyItMatters", "highlights", "publishDate", "workDate", "status", "recommendedFormat", "suggestedShots", "materialIds", "kind", "appeal"];
function applyPatch(s: Suggestion, patch: Record<string, unknown>) {
  for (const k of EDITABLE) if (k in patch) (s as unknown as Record<string, unknown>)[k] = patch[k] === "" && k === "publishDate" ? undefined : patch[k];
}
projectApi.patch(
  "/suggestions/:id",
  h(async (req) => (await updateSuggestions(projectId(), [param(req, "id")], (items) => applyPatch(items[0], req.body)))[0]),
);
projectApi.post(
  "/suggestions/bulk",
  h(async (req) => {
    const ids = req.body.ids as string[];
    if (!Array.isArray(ids) || !ids.length) throw bad("No suggestions selected");
    return updateSuggestions(projectId(), ids, (items) => items.forEach((s) => applyPatch(s, req.body.patch ?? {})));
  }),
);
projectApi.post("/suggestions/merge", h((req) => mergeSuggestions(req.body.ids as string[])));

// ---------- materials ----------

projectApi.get("/materials", h((req) => listMaterials(projectId(), { from: isDate(req.query.from) ? req.query.from : undefined, to: isDate(req.query.to) ? req.query.to : undefined })));
projectApi.post(
  "/materials",
  h(async (req) => {
    const attachmentSuggestion = typeof req.query.suggestionId === "string" ? req.query.suggestionId : undefined;
    const attachmentPost = typeof req.query.postId === "string" ? req.query.postId : undefined;
    if (attachmentSuggestion) await getSuggestions(projectId(), [attachmentSuggestion]);
    if (attachmentPost) await loadPost(projectId(), attachmentPost);
    const created = await handleUpload(req);
    const ids = created.map((m) => m.id);
    const suggestionId = typeof req.query.suggestionId === "string" ? req.query.suggestionId : undefined;
    const postId = typeof req.query.postId === "string" ? req.query.postId : undefined;
    if (suggestionId) await updateSuggestions(projectId(), [suggestionId], (items) => void (items[0].materialIds = [...new Set([...items[0].materialIds, ...ids])]));
    if (postId) await updatePost(projectId(), postId, (e) => void (e.materialIds = [...new Set([...e.materialIds, ...ids])]));
    return created;
  }),
);
/** Sets or clears (empty name) the group of several materials at once. */
projectApi.post(
  "/materials/group",
  h(async (req) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((x: unknown): x is string => typeof x === "string");
    if (!ids.length) throw bad("Select materials to group");
    const group = normalizeGroup(req.body.group);
    const items = await getMaterials(projectId(), ids);
    for (const m of items) await saveMaterial(projectId(), { ...m, group });
    return items.length;
  }),
);
projectApi.patch(
  "/materials/:id",
  h(async (req) => {
    const [m] = await getMaterials(projectId(), [param(req, "id")]);
    if (!m) throw Object.assign(new Error("Material not found"), { status: 404 });
    const b = req.body as Partial<Material>;
    const next: Material = {
      ...m,
      date: isDate(b.date) ? b.date : m.date,
      title: typeof b.title === "string" ? b.title : m.title,
      annotation: typeof b.annotation === "string" ? b.annotation : m.annotation,
      tags: Array.isArray(b.tags) ? b.tags : m.tags,
      group: "group" in b ? normalizeGroup(b.group) : m.group,
    };
    await saveMaterial(projectId(), next);
    return next;
  }),
);
projectApi.delete(
  "/materials/:id",
  h(async (req) => {
    const id = param(req, "id");
    return removeMaterial(id);
  }),
);

// ---------- images from sessions ----------

projectApi.get("/session-images", h(() => listSessionImages(projectId())));
projectApi.get("/intake", h(() => intakeInfo()));
projectApi.post("/intake/run", h(() => startIntake({ ...DEFAULT_INTAKE, ...getProject(projectId()).settings.intake })));
projectApi.post("/session-images/scan", h(() => startJob("sessionImages", "project", (log) => importSessionImages(log))));
projectApi.patch("/session-images/:id", h((req) => {
  const status = req.body?.status;
  if (status !== "inbox" && status !== "dismissed") throw bad("Use the status inbox or dismissed");
  return setSessionImageStatus(param(req, "id"), status);
}));
projectApi.post("/session-images/:id/material", h((req) => {
  const b = req.body as Partial<Material>;
  return addSessionImage(param(req, "id"), {
    ...(isDate(b.date) ? { date: b.date } : {}),
    ...(typeof b.title === "string" ? { title: b.title } : {}),
    ...(typeof b.annotation === "string" ? { annotation: b.annotation } : {}),
    ...(Array.isArray(b.tags) ? { tags: b.tags.filter((t) => typeof t === "string") } : {}),
    ...("group" in b ? { group: normalizeGroup(b.group) } : {}),
  });
}));

// ---------- episodes ----------

projectApi.get("/posts", h(() => postsOverview()));
projectApi.post("/posts", h((req) => createPost(req.body.suggestionIds, req.body.outputs, req.body.title)));
projectApi.get("/posts/:id", h((req) => loadPost(projectId(), param(req, "id"))));
/** Back to suggestions: deletes the post and returns its suggestions to the approved list. */
projectApi.delete("/posts/:id", h((req) => revertPost(param(req, "id"))));
projectApi.get("/posts/:id/materials", h(async (req) => episodeMaterials(await loadPost(projectId(), param(req, "id")))));
projectApi.patch(
  "/posts/:id",
  h((req) =>
    updatePost(projectId(), param(req, "id"), (ep) => {
      for (const k of ["title", "brief", "publishDate", "publishTime", "outputs", "questions", "materialIds"] as const) if (k in req.body) (ep as unknown as Record<string, unknown>)[k] = req.body[k];
    }),
  ),
);
projectApi.put(
  "/posts/:id/script/:format",
  h((req) => {
    const format = fmt(req);
    const { baseCaptureTargets, ...next } = req.body as Script & { baseCaptureTargets?: import("../shared/references.js").CaptureTargetBase };
    return saveScript(projectId(), param(req, "id"), format, next, baseCaptureTargets);
  }),
);

const epJob = (kind: string, work: (req: Request, log: (l: string) => void) => Promise<unknown>) => h(async (req) => {
  await loadPost(projectId(), param(req, "id"));
  return startJob(kind, param(req, "id"), (log) => work(req, log));
});

projectApi.get("/posts/:id/links/:format", h(async (req) => pageChecks(await loadPost(projectId(), param(req, "id")), fmt(req))));
projectApi.post("/posts/:id/links/:format", epJob("links", async (req, log) => checkPostLinks(await loadPost(projectId(), param(req, "id")), fmt(req), log)));
projectApi.post("/posts/:id/images/:format", epJob("imagegen", (req, log) => generateSegmentImages(param(req, "id"), fmt(req), log, typeof req.body?.segmentId === "string" ? req.body.segmentId : undefined)));
projectApi.post("/posts/:id/questions", epJob("questions", (req, log) => askQuestions(param(req, "id"), log, agentOf(req))));
projectApi.post("/posts/:id/script/:format", epJob("script", (req, log) => writeScript(param(req, "id"), fmt(req), log, agentOf(req))));
/** Back to the previous capture of a segment, with the settings that produced it. */
projectApi.post("/posts/:id/segments/:seg/previous-take/:format", h((req) => previousTake(param(req, "id"), param(req, "seg"), fmt(req))));
projectApi.post("/posts/:id/capture/:format", epJob("capture", (req, log) => videoOutput(fmt(req)).capture(param(req, "id"), fmt(req), log, req.body?.segmentId)));
projectApi.post(
  "/posts/:id/segments/:seg/scene-view",
  epJob("capture", async (req, log) => {
    const id = param(req, "id");
    const seg = param(req, "seg");
    await useSceneViewPose(id, seg);
    log("Pose taken from the Scene view.");
    for (const f of outputsWithSegment(await loadPost(projectId(), id), seg)) await capturePost(id, f, log, seg);
  }),
);
projectApi.get("/posts/:id/timeline/:format", h(async (req) => buildTimeline(await loadPost(projectId(), param(req, "id")), fmt(req), req.query.narrated === "1")));
projectApi.get(
  "/posts/:id/tts-estimate/:format",
  h(async (req) => {
    const ep = await loadPost(projectId(), param(req, "id"));
    const script = ep.scripts[fmt(req)];
    const billable = script ? await billableCharacters(script.segments) : { total: 0, bySpeaker: { developer: 0, coHost: 0 } };
    const sub = elevenLabsKey() ? await subscription().catch(() => undefined) : undefined;
    return { characters: billable.total, bySpeaker: billable.bySpeaker, subscription: sub };
  }),
);
projectApi.post(
  "/posts/:id/narrate/:format",
  epJob("narrate", async (req, log) => {
    if (req.body?.confirm !== true) throw new Error("Narration costs ElevenLabs credits; confirm first.");
    const force = Array.isArray(req.body.force) ? (req.body.force as unknown[]).filter((x): x is string => typeof x === "string") : [];
    await videoOutput(fmt(req)).narrate(param(req, "id"), fmt(req), log, force);
  }),
);
/** What the editor needs for one format: the project's co-host and the state of the format's check. */
projectApi.get(
  "/posts/:id/co-host/:format",
  h(async (req) => {
    const post = await loadPost(projectId(), param(req, "id"));
    const coHost = getProject(projectId()).settings.coHost;
    const script = post.scripts[fmt(req)];
    const coHosted = post.presentation?.[fmt(req)] === "coHost";
    return {
      coHost: coHost ? { enabled: coHost.enabled, name: coHost.name, captionColor: coHost.captionColor, share: coHost.share } : null,
      verification: coHosted && script ? { state: verificationState(script, post, await evidenceSnapshot(projectId(), post)), checkedAt: script.verification?.checkedAt, flags: script.verification?.flags ?? [], accepted: script.verification?.accepted ?? [] } : null,
    };
  }),
);
// ---------- article and publishing ----------
projectApi.post("/posts/:id/article/write", epJob("article", (req, log) => writeArticle(param(req, "id"), log, agentOf(req))));
projectApi.put("/posts/:id/article", h(async (req) => updatePost(projectId(), param(req, "id"), (p) => {
  const { agentBody: _kept, ...draft } = req.body as ArticleDraft;
  p.article = { ...p.article, stage: p.article?.stage ?? "draft", draft: { ...draft, agentBody: p.article?.draft?.agentBody } };
})));
projectApi.get("/posts/:id/article/images", h(async (req) => {
  return postImageChoices(await loadPost(projectId(), param(req, "id")));
}));
projectApi.get("/posts/:id/publications", h(async (req) => {
  const pid = projectId();
  const post = await loadPost(pid, param(req, "id"));
  const publications = await postPublications(post.id);
  return publications.map((p) => ({ ...p, problems: egressConnectors[p.connector].validate(p.content, post) }));
}));
projectApi.get("/posts/:id/upload/:format", h(async (req) => (await getUpload(projectId(), param(req, "id"), fmt(req))) ?? null));
projectApi.post("/posts/:id/publications", h((req) => createPublication(param(req, "id"), req.body)));
projectApi.patch("/publications/:pubId", h((req) => updatePublication(param(req, "pubId"), req.body)));
projectApi.delete("/publications/:pubId", h((req) => deletePublication(param(req, "pubId"))));
projectApi.post("/publications/:pubId/write", h((req) => startJob("social", "project", (log) => writeSocialText(param(req, "pubId"), log, agentOf(req)))));
projectApi.post("/publications/:pubId/approve", h(async (req) => startPublishJob(await approvePublication(param(req, "pubId")))));
projectApi.post("/publications/:pubId/withdraw", h((req) => withdrawPublication(param(req, "pubId"))));
projectApi.post("/publications/:pubId/cancel", h((req) => cancelPublication(param(req, "pubId"))));
projectApi.post("/publications/:pubId/publish-late", h(async (req) => startPublishJob(await publishLateNow(param(req, "pubId")))));

// ---------- activity ----------
projectApi.get("/activity", h((req) => activityView({ from: isDate(req.query.from) ? req.query.from : undefined, to: isDate(req.query.to) ? req.query.to : undefined })));
projectApi.get("/activity/sources", h(() => discoverSources()));
projectApi.post("/activity/sync", h((req) => {
  const from = isDate(req.body?.from) ? req.body.from : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  return startJob("activity", "project", (log) => syncActivity({ from }, log));
}));
projectApi.put("/activity/sources/:sourceId/token", h((req) => saveForgeToken(param(req, "sourceId"), String(req.body?.baseUrl ?? ""), String(req.body?.repo ?? ""), String(req.body?.token ?? ""))));
projectApi.put("/activity/links", h((req) => setManualLink(String(req.body.a), String(req.body.b), req.body.split === true)));
projectApi.patch("/activity/records/:id", h((req) => {
  const visibility = req.body?.visibility;
  if (visibility !== "public" && visibility !== "private" && visibility !== "excluded") throw bad("Choose a visibility");
  return setVisibility(param(req, "id"), visibility);
}));
projectApi.post("/activity/records/:id/summarize", h((req) => startJob("summarize", "project", (log) => summarizeRecord(param(req, "id"), log, undefined, agentOf(req)))));
projectApi.post("/posts/:id/verify/:format", epJob("verify", (req, log) => checkCoHostLines(param(req, "id"), fmt(req), log, agentOf(req))));
projectApi.put("/posts/:id/verification/:format/flags/:key", h((req) => setFlagAccepted(param(req, "id"), fmt(req), param(req, "key"), req.body?.keep === true)));
projectApi.put("/posts/:id/presentation/:format", h((req) => setPresentation(param(req, "id"), fmt(req), req.body?.presentation, req.body?.confirm === true)));
projectApi.post("/posts/:id/render/:format", epJob("render", (req, log) => renderPost(param(req, "id"), fmt(req), req.body?.quality === "final" ? "final" : "draft", log)));
/** Final OK; with upload: true and YouTube connected, the upload job starts right away. */
projectApi.post(
  "/posts/:id/approve/:format",
  h(async (req) => {
    const id = param(req, "id");
    const format = fmt(req);
    if (req.body.connectionId) {
      getConnection(req.body.connectionId);
      await updatePost(projectId(), id, (p) => { p.renders[format] = { ...p.renders[format], connectionId: req.body.connectionId }; });
    }
    await videoOutput(format).approve(id, format);
    if (req.body?.upload === true) return startJob("upload", id, (log) => uploadToYouTube(id, format, log));
    return { approved: true };
  }),
);
projectApi.delete("/posts/:id/approve/:format", h((req) => videoOutput(fmt(req)).revokeApproval(param(req, "id"), fmt(req))));
/** Uploads an approved video; a connectionId chosen after the approval becomes the video's connection first. */
projectApi.post(
  "/posts/:id/upload/:format",
  h(async (req) => {
    const id = param(req, "id");
    const format = fmt(req);
    await loadPost(projectId(), id);
    if (req.body?.connectionId) {
      getConnection(req.body.connectionId);
      await updatePost(projectId(), id, (p) => { p.renders[format] = { ...p.renders[format], connectionId: req.body.connectionId }; });
    }
    return startJob("upload", id, (log) => videoOutput(format).upload(id, format, log));
  }),
);
projectApi.get("/posts/:id/publish-moment", h(async (req) => ({ publishAt: publishMoment(await loadPost(projectId(), param(req, "id"))) ?? null })));

// ---------- jobs, unity, settings ----------

app.get("/api/jobs", h((req) => listJobs(req.query.subject as string | undefined)));
app.get("/api/jobs/:id", h((req) => getJob(param(req, "id")) ?? null));
/** Asks a running task to stop at its next checkpoint; the task then ends as cancelled. */
app.post("/api/jobs/:id/cancel", h((req) => cancelJob(param(req, "id")) ?? null));
for (const operation of ["status", "objects", "children", "selection", "view"] as const) {
  projectApi.get(`/capture/:targetId/${operation}`, h((req) => captureOperation(param(req, "targetId"), operation, String(req.query.q ?? req.query.path ?? ""), Math.min(100, Number(req.query.limit) || 40))));
}
// Compatibility for the existing default-target indicator and picker.
projectApi.get("/unity/status", h(async () => { const status = await captureOperation(undefined, "status").catch((e: Error) => ({ ok: false, detail: e.message })); return { ...status, dataPath: status.detail }; }));
for (const operation of ["objects", "children", "selection"] as const) projectApi.get(`/unity/${operation}`, h((req) => captureOperation(undefined, operation, String(req.query.q ?? req.query.path ?? ""), Math.min(100, Number(req.query.limit) || 40))));
projectApi.get("/settings/runtime", h(() => publicConfig()));
projectApi.put("/settings/runtime", h(async (req) => {
  const c = config();
  await saveConfig({ ...c, discovery: { ...c.discovery, initialDays: req.body.discovery?.initialDays ?? c.discovery.initialDays }, theme: req.body.theme ?? c.theme, publishing: req.body.publishing ?? c.publishing, elevenlabs: { ...c.elevenlabs, ...req.body.elevenlabs, apiKey: c.elevenlabs.apiKey }, youtube: { ...c.youtube, ...req.body.youtube } });
  return publicConfig();
}));
projectApi.get("/settings", h(() => getProject()));
projectApi.get("/sources/usage", h(() => sourceUsage(projectId())));
projectApi.put("/settings", h(async (req) => {
  const previous = getProject(projectId()).settings;
  const before = importingSources(previous.activitySources).map((s) => s.id);
  const intake = (req.body.settings as ProjectSettings | undefined)?.intake;
  if (intake && !isIntakeTime(intake.time)) throw bad("Choose a time of day for the daily intake");
  const saved = await saveProject(projectId(), req.body.settings as ProjectSettings, req.body.slug);
  if (saved.settings.intake?.enabled && !previous.intake?.enabled) await armIntake(saved.settings.intake.time);
  // Turning the option on reads the logs that were already read for activity.
  if (importingSources(saved.settings.activitySources).some((s) => !before.includes(s.id))) await startJob("sessionImages", "project", (log) => importSessionImages(log));
  return saved;
}));
app.get("/api/settings", h(() => {
  const { apiKey } = globalConfig().elevenlabs;
  return { ...globalConfig(), elevenlabs: { apiKeySet: !!apiKey, apiKeyFromEnv: !!process.env.ELEVENLABS_API_KEY } };
}));
app.put("/api/settings", h(async (req) => {
  const c = globalConfig(), b = req.body;
  await saveGlobal({ port: b.port ?? c.port, agent: { ...c.agent, ...b.agent }, render: { ...c.render, ...b.render }, statsIntervalHours: b.statsIntervalHours ?? c.statsIntervalHours, elevenlabs: { apiKey: b.elevenlabs?.clearApiKey ? undefined : b.elevenlabs?.apiKey?.trim() || c.elevenlabs.apiKey } });
  scheduleStats();
  const { apiKey, ...el } = globalConfig().elevenlabs;
  return { ...globalConfig(), elevenlabs: { ...el, apiKeySet: !!apiKey, apiKeyFromEnv: !!process.env.ELEVENLABS_API_KEY } };
}));
/**
 * Answers only this app's own pages. The API allows every origin, and a folder listing must not reach other
 * websites open in the browser, directly or through a domain that resolves to this computer.
 */
const ownPagesOnly = (req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  const loopback = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  if (!loopback || (origin && origin !== `http://${host}`)) return void res.status(403).json({ error: "Not available to other sites." });
  next();
};
app.get("/api/folders", ownPagesOnly, h((req) => listFolders(typeof req.query.path === "string" ? req.query.path : undefined, { executables: req.query.executables === "1", hidden: req.query.hidden === "1" })));
app.get("/api/projects", h(() => listProjects()));
app.post("/api/projects", h((req) => createProject(req.body)));
// Deletion bypasses the normal write gate so a failed cleanup can be retried.
projectApi.delete("/", h(async (req) => { await deleteProject(projectId(), req.query.files === "true"); return { deleted: true }; }));
app.get("/api/youtube/connections", h(() => listConnections().map(publicConnection)));
app.post("/api/youtube/connections/:cid/disconnect", h((req) => disconnect(param(req, "cid"))));
app.get("/api/youtube/connections/:cid/auth-url", h((req) => ({ url: authUrl(param(req, "cid")) })));
app.get("/api/voices", h(() => listVoices()));

projectApi.get("/stats", h(() => statsReport()));
projectApi.post("/stats/refresh", h(() => startStatsRefresh()));

/** Google redirects the browser here after consent. */
app.get("/api/youtube/callback", async (req, res) => {
  const page = (title: string, text: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:40px"><h2>${title}</h2><p>${text}</p><p><a href="/#/settings">Back to Devlog Studio settings</a></p>`;
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    await youtubeCallback(String(req.query.code ?? ""), String(req.query.state ?? ""));
    res.send(page("YouTube connected", "You can close this tab."));
  } catch (err) {
    res.status(400).send(page("YouTube connection failed", (err as Error).message.replace(/[<>&]/g, "")));
  }
});
/** Bumper music for the intro or the outro; its leading silence is cut on import. */
const placementOf = (req: Request): BumperPlacement => {
  const p = param(req, "placement");
  if (p !== "intro" && p !== "outro") throw bad("Unknown placement");
  return p;
};
projectApi.post(
  "/settings/bumper-audio/:placement",
  h(async (req) => {
    const placement = placementOf(req);
    const file = await receiveSingleFile(req);
    try {
      return await importBumperAudio(placement, file.path, file.name);
    } finally {
      fs.rmSync(file.path, { force: true });
    }
  }),
);
projectApi.delete("/settings/bumper-audio/:placement", h((req) => removeBumperAudio(placementOf(req))));
/** A font or image for the theme. The theme references it once the theme is saved. */
projectApi.post(
  "/theme/files",
  h(async (req) => {
    const kind = req.query.kind;
    if (!isThemeFileKind(kind)) throw bad("Unknown file kind");
    const file = await receiveSingleFile(req);
    try {
      return await storeThemeFile(projectId(), kind, file.path, file.name);
    } finally {
      fs.rmSync(file.path, { force: true });
    }
  }),
);
/** Applies an extension's theme preset to the project and saves it. */
projectApi.post("/theme/presets/:extensionId/:presetId", h(async (req) => ({ theme: await applyThemePreset(param(req, "extensionId"), param(req, "presetId")) })));
// ---------- publishing connections ----------
app.get("/api/egress/connections", h(async () => (await listEgressConnections()).map(publicEgressConnection)));
app.post("/api/egress/connections", h(async (req) => publicEgressConnection(await saveEgressConnection(req.body))));
app.delete("/api/egress/connections/:cid", h((req) => deleteEgressConnection(param(req, "cid"))));
const linkedinRedirect = () => `http://localhost:${config().port}/api/egress/linkedin/callback`;
app.get("/api/egress/connections/:cid/linkedin-auth-url", h(async (req) => ({ url: linkedinAuthUrl(await getEgressConnection(param(req, "cid")), linkedinRedirect()), redirectUri: linkedinRedirect() })));
app.get("/api/egress/linkedin/callback", async (req, res) => {
  try {
    const connection = await getEgressConnection(String(req.query.state));
    if (typeof req.query.code !== "string") throw new Error(String(req.query.error_description ?? "LinkedIn didn't grant access."));
    const { secrets, personUrn, name } = await linkedinExchange(connection, req.query.code, linkedinRedirect());
    await saveEgressConnection({ ...connection, config: { ...connection.config, personUrn, accountName: name }, secrets });
    res.send("LinkedIn is connected. You can close this tab.");
  } catch (err) {
    res.status(400).send(`LinkedIn connection failed: ${String((err as Error).message).replace(/[<>&]/g, "")}`);
  }
});
app.get("/api/voices/:id", h((req) => getVoice(param(req, "id"))));

/** Shows a final video in the system's file manager. */
projectApi.post(
  "/open",
  h((req) => {
    const target = req.body.file ? path.resolve(String(req.body.file)) : OUTPUT_DIR;
    if (target !== OUTPUT_DIR && !target.startsWith(OUTPUT_DIR + path.sep)) throw bad("Path not allowed");
    const file = !!req.body.file;
    const [program, args] = process.platform === "win32" ? ["explorer.exe", file ? ["/select,", target] : [target]]
      : process.platform === "darwin" ? ["open", file ? ["-R", target] : [target]]
      : ["xdg-open", [file ? path.dirname(target) : target]];
    spawn(program, args, { detached: true, stdio: "ignore" }).unref();
  }),
);

// ---------- media ----------

app.get("/media/*key", (req, res) => {
  const key = ([] as string[]).concat(req.params.key as unknown as string[]).join("/");
  void serveObject(key, req, res);
});
app.use("/output", express.static(OUTPUT_DIR));
projectApi.post("/theme-preview", h((req) => themePreview(req.body.theme ?? {}, req.body.format === "landscape" ? "landscape" : "portrait")));

app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status ?? 500).json({ error: err.message });
});

const vite = await createVite({ root: path.join(ROOT, "web"), configFile: path.join(ROOT, "vite.config.ts"), server: {
    middlewareMode: true,
    // Only the UI sources need watching; media folders must stay unlocked.
    watch: { ignored: ["**/cache/**", "**/output/**", "**/docker/**"] },
  },
  appType: "spa",
});
app.use(vite.middlewares);

const { port } = config();
schedulePublishing();
scheduleIntake();
app.listen(port, "127.0.0.1", () => console.log(`Devlog Studio: http://localhost:${port}`));
