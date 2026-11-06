import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { query, tx } from "../db.js";
import { inContext, projectId } from "../context.js";
import { cacheYoutubeConnection, deleteConnection, listProjects, getProject } from "../projects.js";
import { loadPost, newId } from "../store.js";
import { startJob } from "../jobs.js";
import { assertCoHostVerified } from "../verification.js";
import { CONNECTOR_LABEL, fillPlaceholders, isYoutubePublicationId, TEXT_LIMIT, youtubePublicationId, type EgressConnection, type EgressConnectorId, type Publication, type PublicationContent, type PublicationDependency, type PublicationState, type PublicEgressConnection } from "../../shared/publications.js";
import type { Format, Post, StatItem } from "../../shared/types.js";
import { askYoutubeIsPublic, setUpload, uploadIsPublic, youtubeConnector, type YoutubeIsPublic } from "./youtube.js";
import { blueskyConnector, newRecordKey } from "./bluesky.js";
import { linkedinConnector } from "./linkedin.js";
import { folderConnector, gitSiteConnector, plannedArticleUrl } from "./article.js";
import type { EgressConnector } from "./provider.js";

const run = promisify(execFile);
export const egressConnectors: Record<EgressConnectorId, EgressConnector> = { youtube: youtubeConnector, bluesky: blueskyConnector, linkedin: linkedinConnector, folder: folderConnector, "git-site": gitSiteConnector };
/** A missed publish time up to this old still goes out after a restart; anything older asks first. */
export const DEFAULT_LATENESS_HOURS = 24;
const refuse = (status: number, message: string) => Object.assign(new Error(message), { status });

// ---------- connections ----------

export const listEgressConnections = async () => (await query<{ data: EgressConnection }>("SELECT data FROM egress_connections ORDER BY data->>'name'")).map((r) => r.data);
export async function getEgressConnection(id: string) {
  const c = (await query<{ data: EgressConnection }>("SELECT data FROM egress_connections WHERE id = $1", [id]))[0]?.data;
  if (!c) throw refuse(404, "This publishing connection no longer exists.");
  return c;
}
export const publicEgressConnection = ({ secrets, ...c }: EgressConnection): PublicEgressConnection => ({ ...c, secretsSet: Object.entries(secrets ?? {}).filter(([, v]) => !!v).map(([k]) => k), expiresAt: secrets?.expiresAt });
/** Saves a connection. An empty secret keeps the stored one, so secrets never need to travel back to the client. */
export async function saveEgressConnection(input: Omit<EgressConnection, "id" | "secrets"> & { id?: string; secrets?: Record<string, string | undefined>; copyClientFrom?: string }) {
  if (!egressConnectors[input.connector]) throw refuse(400, "Choose a publishing platform.");
  if (!input.name?.trim()) throw refuse(400, "Name this connection.");
  const previous = input.id ? await getEgressConnection(input.id) : undefined;
  const secrets = { ...previous?.secrets };
  for (const [k, v] of Object.entries(input.secrets ?? {})) if (v) secrets[k] = v;
  const config = { ...input.config };
  // Sign-in fills these in, and a client saving its form can't change them.
  if (input.connector === "youtube" || input.connector === "linkedin") for (const key of ["channelId", "channelTitle", "personUrn", "accountName"]) { if (previous?.config[key] !== undefined) config[key] = previous.config[key]; else delete config[key]; }
  if (input.copyClientFrom) {
    const source = await getEgressConnection(input.copyClientFrom);
    if (source.connector !== input.connector) throw refuse(400, "Copy from a connection of the same platform.");
    config.clientId = source.config.clientId;
    secrets.clientSecret = source.secrets?.clientSecret;
  }
  const c: EgressConnection = { id: input.id ?? newId(input.connector), connector: input.connector, name: input.name.trim(), config, secrets };
  await query("INSERT INTO egress_connections (id, connector, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3", [c.id, c.connector, c]);
  if (c.connector === "youtube") cacheYoutubeConnection(c);
  return c;
}
export async function deleteEgressConnection(id: string) {
  if ((await getEgressConnection(id)).connector === "youtube") return deleteConnection(id);
  const used = await query("SELECT 1 FROM publications WHERE data->>'connectionId' = $1 AND data->>'state' NOT IN ('published', 'cancelled') LIMIT 1", [id]);
  if (used.length) throw refuse(409, "A publication that hasn't gone out uses this connection.");
  await query("DELETE FROM egress_connections WHERE id = $1", [id]);
}

// ---------- publications ----------

export const listPublications = async (pid: string, postId?: string) =>
  (await query<{ data: Publication }>(`SELECT data FROM publications WHERE project_id = $1${postId ? " AND post_id = $2" : ""} ORDER BY data->>'createdAt'`, postId ? [pid, postId] : [pid])).map((r) => r.data);
async function savePublication(pid: string, p: Publication) {
  await query("INSERT INTO publications (id, project_id, post_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET data = $4", [p.id, pid, p.postId, p]);
  return p;
}
const getPublication = async (pid: string, id: string) => {
  const p = (await query<{ data: Publication }>("SELECT data FROM publications WHERE project_id = $1 AND id = $2", [pid, id]))[0]?.data;
  if (!p) throw refuse(404, "This publication no longer exists.");
  return p;
};
export const contentHash = (c: PublicationContent) => crypto.createHash("sha256").update(JSON.stringify([c.text, c.title, c.description, c.videoFormat, c.article])).digest("hex").slice(0, 24);

/** Refuses a dependency graph with a cycle or a dependency that doesn't exist. */
export function assertAcyclic(all: Array<Pick<Publication, "id" | "dependsOn">>) {
  const byId = new Map(all.map((p) => [p.id, p]));
  const visit = (id: string, path: string[]) => {
    if (path.includes(id)) throw refuse(400, "These publications wait for each other, so none could ever go out.");
    for (const d of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(d.publicationId)) throw refuse(400, "A publication waits for one that no longer exists.");
      visit(d.publicationId, [...path, id]);
    }
  };
  for (const p of all) visit(p.id, []);
}

/** The post's video uploads exist as publications from the moment another publication waits for one. */
async function ensureUploadPublications(pid: string, post: Post, dependsOn: PublicationDependency[]) {
  for (const format of ["portrait", "landscape"] as const) {
    const id = youtubePublicationId(post.id, format);
    if (!dependsOn.some((d) => d.publicationId === id)) continue;
    if (!post.outputs.includes(format)) throw refuse(400, "This post has no such video.");
    const connectionId = post.renders[format]?.connectionId ?? getProject(pid).settings.publishing.connectionId ?? "";
    await query("INSERT INTO publications (id, project_id, post_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING", [id, pid, post.id, { id, postId: post.id, connector: "youtube", connectionId, content: { videoFormat: format }, dependsOn: [], state: "draft", createdAt: new Date().toISOString() } satisfies Publication]);
  }
}

/** A video's published title lives with its render. Read for showing, and not stored here. */
function addVideoTitles(post: Post, publications: Publication[]) {
  for (const p of publications) if (p.connector === "youtube" && p.result?.upload?.videoId) p.result = { ...p.result, title: post.renders[p.content.videoFormat!]?.package?.title ?? post.title };
}

/** What a post's Publish step lists: its publications, with a draft row for each video that has no upload yet. */
export async function postPublications(postId: string): Promise<Publication[]> {
  const pid = projectId();
  const post = await loadPost(pid, postId);
  const stored = await listPublications(pid, postId);
  addVideoTitles(post, stored);
  const missing = post.outputs.filter((o): o is Format => o !== "article").filter((f) => !stored.some((p) => p.id === youtubePublicationId(postId, f))).map((f): Publication => ({ id: youtubePublicationId(postId, f), postId, connector: "youtube", connectionId: "", content: { videoFormat: f }, dependsOn: [], state: "draft", createdAt: post.createdAt }));
  return [...missing, ...stored];
}
export const deletePostPublications = (pid: string, postId: string) => query("DELETE FROM publications WHERE project_id = $1 AND post_id = $2", [pid, postId]);

export async function createPublication(postId: string, input: { connector: EgressConnectorId; connectionId: string; content?: PublicationContent; dependsOn?: PublicationDependency[]; publishAt?: string }) {
  const pid = projectId();
  const connector = egressConnectors[input.connector];
  if (!connector) throw refuse(400, "Choose a publishing platform.");
  if (input.connector === "youtube") throw refuse(400, "Upload a video from the post's Final step.");
  const connection = await getEgressConnection(input.connectionId);
  if (connection.connector !== input.connector) throw refuse(400, "This connection belongs to another platform.");
  const post = await loadPost(pid, postId);
  await ensureUploadPublications(pid, post, input.dependsOn ?? []);
  const publication: Publication = {
    id: newId("pub"), postId, connector: input.connector, connectionId: input.connectionId,
    content: { ...input.content, recordKey: input.connector === "bluesky" ? newRecordKey() : undefined, article: connector.accepts.includes("article") ? true : input.content?.article },
    dependsOn: input.dependsOn ?? [], publishAt: input.publishAt, state: "draft", createdAt: new Date().toISOString(),
  };
  assertAcyclic([...await listPublications(pid, postId), publication]);
  return savePublication(pid, publication);
}

/** Editing the content clears only this publication's approval. A publication that went out stays as it was. */
export async function updatePublication(id: string, patch: { content?: PublicationContent; dependsOn?: PublicationDependency[]; publishAt?: string | null }) {
  const pid = projectId();
  const p = await getPublication(pid, id);
  if (p.state === "published" || p.state === "publishing") throw refuse(409, "This publication has already gone out.");
  if (patch.dependsOn) await ensureUploadPublications(pid, await loadPost(pid, p.postId), patch.dependsOn);
  const next: Publication = { ...p, content: patch.content ? { ...p.content, ...patch.content, recordKey: p.content.recordKey } : p.content, dependsOn: patch.dependsOn ?? p.dependsOn, publishAt: patch.publishAt === null ? undefined : patch.publishAt ?? p.publishAt };
  assertAcyclic((await listPublications(pid, p.postId)).map((x) => (x.id === id ? next : x)));
  if (p.approvedHash && p.approvedHash !== contentHash(next.content)) { next.approvedHash = undefined; next.state = "draft"; }
  return savePublication(pid, next);
}

export async function approvePublication(id: string) {
  const pid = projectId();
  const p = await getPublication(pid, id);
  if (p.state === "published" || p.state === "publishing") throw refuse(409, "This publication has already gone out.");
  if (p.connector === "youtube") throw refuse(409, "Approve this video in the post's Final step.");
  const post = await loadPost(pid, p.postId);
  const problems = egressConnectors[p.connector].validate(p.content, post);
  if (problems.length) throw refuse(400, problems.join(" "));
  return savePublication(pid, { ...p, approvedHash: contentHash(p.content), state: "approved", result: p.state === "failed" ? { ...p.result, error: undefined } : p.result });
}
export async function withdrawPublication(id: string) {
  const pid = projectId();
  const p = await getPublication(pid, id);
  if (p.state === "published" || p.state === "publishing") throw refuse(409, "This publication has already gone out.");
  return savePublication(pid, { ...p, approvedHash: undefined, state: "draft" });
}
export async function cancelPublication(id: string) {
  const pid = projectId();
  const p = await getPublication(pid, id);
  if (p.state === "published" || p.state === "publishing") throw refuse(409, "This publication has already gone out.");
  return savePublication(pid, { ...p, approvedHash: undefined, state: "cancelled" });
}
/** Answers the question about a late publication: send it now. */
export async function publishLateNow(id: string) {
  const pid = projectId();
  const p = await getPublication(pid, id);
  if (p.state !== "late") throw refuse(409, "This publication isn't waiting for that decision.");
  return savePublication(pid, { ...p, publishAt: undefined, state: "approved" });
}
export async function deletePublication(id: string) {
  const pid = projectId();
  const p = await getPublication(pid, id);
  if (p.state === "published" || p.state === "publishing") throw refuse(409, "This publication has already gone out.");
  if ((await listPublications(pid, p.postId)).some((x) => x.dependsOn.some((d) => d.publicationId === id))) throw refuse(409, "Another publication waits for this one.");
  await query("DELETE FROM publications WHERE id = $1 AND project_id = $2", [id, pid]);
}

// ---------- dependencies ----------

interface DepStatus { met: boolean; cancelled?: boolean; youtubeUrl?: string; youtubeId?: string; articleUrl?: string }
async function dependencyStatus(pid: string, d: PublicationDependency, all: Publication[], youtubeIsPublic: YoutubeIsPublic): Promise<DepStatus> {
  const dep = all.find((p) => p.id === d.publicationId);
  if (!dep) return { met: false };
  if (dep.connector === "youtube") {
    const y = dep.result?.upload;
    if (!y?.videoId) return { met: false, cancelled: dep.state === "cancelled" };
    const values = { youtubeUrl: y.url, youtubeId: y.videoId };
    return { met: d.when === "published" || (await uploadIsPublic(y, youtubeIsPublic)), ...values };
  }
  if (dep.state === "cancelled") return { met: false, cancelled: true };
  if (dep.state !== "published" || !dep.result) return { met: false };
  const values = dep.connector === "folder" || dep.connector === "git-site" ? { articleUrl: dep.result.url } : {};
  if (d.when === "published" || dep.result.publicAt) return { met: true, ...values };
  const connection = await getEgressConnection(dep.connectionId);
  const live = await egressConnectors[dep.connector].isPublic(dep.result, connection).catch(() => false);
  if (live) await savePublication(pid, { ...dep, result: { ...dep.result, publicAt: new Date().toISOString() } });
  return { met: live, ...values };
}

/** A still frame of the final render, sized for a link card. */
async function thumbnailOf(post: Post, format: Format): Promise<Buffer | undefined> {
  const file = post.renders[format]?.final;
  if (!file) return undefined;
  const { stdout } = await run("ffmpeg", ["-loglevel", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "5", "-f", "mjpeg", "pipe:1"], { encoding: "buffer", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

export interface TickOptions {
  now?: number;
  youtubeIsPublic?: YoutubeIsPublic;
  log?: (line: string) => void;
  /** Sends each due publication as its own task, so that the task overlay shows what the scheduler does. */
  asJobs?: boolean;
}

async function send(pid: string, p: Publication, post: Post, status: DepStatus[], log: (l: string) => void) {
  const connection = await getEgressConnection(p.connectionId);
  const values = { youtubeUrl: status.find((s) => s.youtubeUrl)?.youtubeUrl, youtubeId: status.find((s) => s.youtubeId)?.youtubeId, articleUrl: status.find((s) => s.articleUrl)?.articleUrl };
  if (p.content.videoFormat) await assertCoHostVerified(post, p.content.videoFormat);
  const text = fillPlaceholders(p.content.text ?? "", values);
  const linkUrl = values.articleUrl ?? values.youtubeUrl;
  const format = (["portrait", "landscape"] as const).find((f) => p.dependsOn.some((d) => d.publicationId === youtubePublicationId(post.id, f)));
  return egressConnectors[p.connector].publish(p, { post, connection, text, log, linkUrl: text.includes(linkUrl ?? "\0") ? linkUrl : undefined, thumbnail: format ? () => thumbnailOf(post, format) : undefined, values });
}

/** Claims a publication in one statement, so two ticks can't send it twice. */
async function claim(pid: string, id: string): Promise<boolean> {
  return tx(async (c) => {
    const row = (await c.query("SELECT data FROM publications WHERE id = $1 AND project_id = $2 FOR UPDATE", [id, pid])).rows[0];
    const state: PublicationState | undefined = row?.data.state;
    if (!state || !["approved", "waiting", "scheduled"].includes(state)) return false;
    row.data.state = "publishing";
    await c.query("UPDATE publications SET data = $3 WHERE id = $1 AND project_id = $2", [id, pid, row.data]);
    return true;
  });
}

/** One scheduler pass for the current project: moves each approved publication on as far as it can go. */
export async function publishDue(options: TickOptions = {}) {
  const pid = projectId();
  const now = options.now ?? Date.now();
  const log = options.log ?? (() => {});
  const lateMs = (getProject(pid).settings.publishing.latenessHours ?? DEFAULT_LATENESS_HOURS) * 3600_000;
  // Several passes, so that a chain moves on within one tick when nothing has to wait.
  for (let pass = 0; pass < 8; pass++) {
    const all = await listPublications(pid);
    let sent = false;
    for (const p of all.filter((x) => ["approved", "waiting", "scheduled"].includes(x.state))) {
      if (p.approvedHash !== contentHash(p.content)) { await savePublication(pid, { ...p, approvedHash: undefined, state: "draft" }); continue; }
      const post = await loadPost(pid, p.postId);
      const status = await Promise.all(p.dependsOn.map((d) => dependencyStatus(pid, d, all, options.youtubeIsPublic ?? askYoutubeIsPublic)));
      if (status.some((s) => s.cancelled)) { await savePublication(pid, { ...p, approvedHash: undefined, state: "draft", result: { ...p.result, error: "A publication this one waits for was cancelled. Decide what to do with this one." } }); continue; }
      if (status.some((s) => !s.met)) {
        if (p.state !== "waiting") {
          await savePublication(pid, { ...p, state: "waiting" });
          log(`${CONNECTOR_LABEL[p.connector]} is waiting until what it depends on is public.`);
        }
        continue;
      }
      const at = p.publishAt ? new Date(p.publishAt).getTime() : 0;
      if (at > now) {
        if (p.state !== "scheduled") {
          await savePublication(pid, { ...p, state: "scheduled" });
          log(`${CONNECTOR_LABEL[p.connector]} is scheduled for ${new Date(at).toLocaleString()}.`);
        }
        continue;
      }
      if (at && now - at > lateMs) {
        await savePublication(pid, { ...p, state: "late" });
        log(`${CONNECTOR_LABEL[p.connector]} missed its time, so it's waiting for your decision.`);
        continue;
      }
      /** Returns the failure message, if any. */
      const sendOne = async (write: (line: string) => void) => {
        if (!(await claim(pid, p.id))) return undefined;
        write(`Publishing to ${CONNECTOR_LABEL[p.connector]}…`);
        try {
          const result = await send(pid, p, post, status, write);
          await savePublication(pid, { ...p, state: "published", result: { ...result, publishedAt: new Date(now).toISOString() } });
          write(`Published${result.url ? `: ${result.url}` : "."}`);
          sent = true;
          return undefined;
        } catch (err) {
          const message = (err as Error).message;
          await savePublication(pid, { ...p, state: "failed", result: { ...p.result, error: message } });
          write(`${CONNECTOR_LABEL[p.connector]} failed: ${message}`);
          return message;
        }
      };
      if (options.asJobs) {
        // A task already running for this post leaves this one approved, for the next pass.
        await startJob("publish", p.postId, async (write) => {
          const failure = await sendOne(write);
          if (failure) throw new Error(failure);
        });
      } else await sendOne(log);
    }
    if (!sent) break;
  }
}

/** Moves an approved publication on as a task, which the task overlay shows and which fails if the publication does. */
export function startPublishJob(publication: Publication) {
  return startJob("publish", publication.postId, async (log) => {
    await publishDue({ log });
    const after = await getPublication(projectId(), publication.id);
    if (after.state === "failed") throw new Error(after.result?.error ?? "Publishing failed.");
  });
}

/**
 * After a crash, a publication can be left in "publishing". A connector that can't post twice goes again. For any
 * other connector, nobody can tell whether the post got through, so the developer decides.
 */
export async function recoverPublishing() {
  const pid = projectId();
  for (const p of await listPublications(pid)) {
    if (p.state !== "publishing") continue;
    if (p.connector === "youtube") {
      const upload = p.result?.upload;
      if (upload) await setUpload(pid, p.postId, p.content.videoFormat!, { ...upload, status: "failed", error: "The app stopped during this upload. Check YouTube before you retry." });
      continue;
    }
    if (egressConnectors[p.connector].capabilities.idempotent) await savePublication(pid, { ...p, state: "approved" });
    else await savePublication(pid, { ...p, state: "failed", result: { ...p.result, error: `The app stopped while posting. Check ${CONNECTOR_LABEL[p.connector]} before you retry, because the post may already be there.` } });
  }
}

let timer: NodeJS.Timeout | undefined;
const TICK_MS = 60_000;
/** Runs while the app runs. A time missed while it's off goes out after the next start, within the lateness limit. */
export function schedulePublishing() {
  if (timer) clearInterval(timer);
  const forEachProject = async (work: () => Promise<void>) => {
    for (const p of listProjects()) if (!p.deletion) await inContext({ projectId: p.id }, work).catch((err) => console.warn(`Publishing: ${(err as Error).message}`));
  };
  void forEachProject(recoverPublishing);
  timer = setInterval(() => void forEachProject(() => publishDue({ asJobs: true })), TICK_MS);
}

/** Adds a snapshot of the numbers of everything that went out. One platform failing leaves the others. */
export async function refreshPublicationMetrics(log: (line: string) => void = () => {}) {
  const pid = projectId();
  const now = new Date().toISOString();
  for (const p of await listPublications(pid)) {
    const connector = egressConnectors[p.connector];
    if (p.state !== "published" || !p.result || !connector.metrics) continue;
    try {
      const metrics = await connector.metrics(p.result, await getEgressConnection(p.connectionId));
      await query("INSERT INTO publication_stats (publication_id, project_id, fetched_at, metrics) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [p.id, pid, now, metrics]);
    } catch (err) {
      log(`${CONNECTOR_LABEL[p.connector]} numbers: ${(err as Error).message}`);
    }
  }
}

const URL_IN_TEXT = /\s*https?:\/\/\S+/g;
/** Published items with numbers from their platform, for the Statistics page. A platform's replies count as comments. */
export async function publicationStats(): Promise<StatItem[]> {
  const pid = projectId();
  const rows = await query<{ publication_id: string; fetched_at: Date; metrics: Record<string, number> }>("SELECT publication_id, fetched_at, metrics FROM publication_stats WHERE project_id = $1 ORDER BY fetched_at", [pid]);
  return (await listPublications(pid)).filter((p) => p.state === "published" && egressConnectors[p.connector].metrics).map((p) => ({
    id: p.id, postId: p.postId, title: (p.result?.sentText ?? p.content.text ?? "").replace(URL_IN_TEXT, "").trim(), connector: p.connector, platform: CONNECTOR_LABEL[p.connector], url: p.result?.url, publishedAt: p.result?.publishedAt,
    series: rows.filter((r) => r.publication_id === p.id).map((r) => ({ t: r.fetched_at.toISOString(), likes: r.metrics.likes, comments: r.metrics.replies, reposts: r.metrics.reposts })),
  }));
}

export { plannedArticleUrl, TEXT_LIMIT };
