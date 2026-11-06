import { listProjects } from "./projects.js";
import { startJob } from "./jobs.js";
import { globalConfig } from "./config.js";
import { projectId, inContext } from "./context.js";
import { query } from "./db.js";
import { config } from "./config.js";
import { listPosts } from "./store.js";
import { getUpload, listUploads, setUpload } from "./egress/youtube.js";
import { publicationStats, refreshPublicationMetrics } from "./egress/publish.js";
import { videoDetails } from "./youtube.js";
import type { Format, StatItem } from "../shared/types.js";

/** YouTube statistics: periodic snapshots of every uploaded video, kept as a time series in Postgres. */

interface UploadedVideo {
  videoId: string;
  connectionId?: string;
  postId: string;
  title: string;
  format: Format;
  url?: string;
}

async function uploadedVideos(): Promise<UploadedVideo[]> {
  const out: UploadedVideo[] = [];
  const posts = new Map((await listPosts(projectId())).map((p) => [p.id, p]));
  for (const { postId, format, upload } of await listUploads(projectId())) {
    const post = posts.get(postId);
    if (post && upload.videoId) out.push({ connectionId: upload.connectionId, videoId: upload.videoId, postId, title: post.renders[format]?.package?.title ?? post.title, format, url: upload.url });
  }
  return out;
}

const lastRuns = new Map<string, { at: string; videos: number; error?: string }>();
export const lastStatsRun = () => lastRuns.get(projectId()) ?? null;

/** Fetches current statistics for all uploaded videos and stores one snapshot each. */
export async function refreshStats(log: (l: string) => void = () => {}) {
  await refreshPublicationMetrics(log);
  const videos = await uploadedVideos();
  if (!videos.length) {
    lastRuns.set(projectId(), { at: new Date().toISOString(), videos: 0 });
    return;
  }
  try {
    const details: Awaited<ReturnType<typeof videoDetails>> = [];
    const connectionIds = [...new Set(videos.map((v) => v.connectionId))];
    for (const connectionId of connectionIds) {
      if (!connectionId) continue;
      try { details.push(...await inContext({ connectionId }, () => videoDetails(videos.filter((v) => v.connectionId === connectionId).map((v) => v.videoId)))); }
      catch (e) { log(`YouTube connection ${connectionId}: ${(e as Error).message}`); }
    }
    const now = new Date().toISOString();
    for (const d of details) {
      await query("INSERT INTO video_stats (video_id, fetched_at, views, likes, comments) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [d.id, now, d.views, d.likes, d.comments]);
      const v = videos.find((x) => x.videoId === d.id)!;
      // A scheduled video that went public is published now; record when.
      const y = await getUpload(projectId(), v.postId, v.format);
      if (y) await setUpload(projectId(), v.postId, v.format, { ...y, ...(d.privacy === "public" && y.status === "scheduled" ? { status: "uploaded" as const, privacy: "public" as const } : {}), ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}) });
    }
    log(`Statistics for ${details.length} video(s) updated.`);
    lastRuns.set(projectId(), { at: now, videos: details.length });
  } catch (err) {
    lastRuns.set(projectId(), { at: new Date().toISOString(), videos: 0, error: (err as Error).message });
    throw err;
  }
}

/** Every uploaded video with its snapshots, oldest first. */
export async function statsReport() {
  const videos = await uploadedVideos();
  const rows = await query<{ video_id: string; fetched_at: Date; views: string; likes: string; comments: string }>(
    "SELECT video_id, fetched_at, views, likes, comments FROM video_stats WHERE video_id = ANY($1) ORDER BY fetched_at",
    [videos.map((v) => v.videoId)],
  );
  const uploads = await listUploads(projectId());
  const latest = rows.at(-1)?.fetched_at;
  const videoItems = videos.map((v): StatItem => {
    const y = uploads.find((u) => u.postId === v.postId && u.format === v.format)?.upload;
    return {
      id: v.videoId, postId: v.postId, title: v.title, connector: "youtube", platform: v.format === "portrait" ? "YouTube Short" : "YouTube video", url: v.url,
      publishedAt: y?.publishedAt ?? y?.publishAt ?? y?.uploadedAt, status: y?.status,
      series: rows.filter((r) => r.video_id === v.videoId).map((r) => ({ t: r.fetched_at.toISOString(), views: Number(r.views), likes: Number(r.likes), comments: Number(r.comments) })),
    };
  });
  return {
    // A refresh's run is only remembered until a restart, and its stored snapshots say when it last worked.
    lastRun: lastStatsRun() ?? (latest ? { at: latest.toISOString(), videos: videos.length } : null),
    intervalHours: config().youtube.statsIntervalHours,
    items: [...videoItems, ...await publicationStats()].sort((x, y) => (y.publishedAt ?? "").localeCompare(x.publishedAt ?? "")),
  };
}

let timer: NodeJS.Timeout | null = null;

export const startStatsRefresh = (refresh = refreshStats) => startJob("stats", "project", (log) => refresh(log));

const MIN_DELAY_MS = 60_000;
const intervalMs = () => Math.max(0.25, globalConfig().statsIntervalHours || 3) * 3600_000;
/** Time until the next refresh. It counts from the last stored one, so a restart doesn't cause an extra fetch. */
export function nextStatsDelay(lastFetchedAt: number | undefined, interval: number, now = Date.now()) {
  return lastFetchedAt === undefined ? MIN_DELAY_MS : Math.max(MIN_DELAY_MS, lastFetchedAt + interval - now);
}

/** Refreshes every statsIntervalHours while the app runs, and catches up shortly after start when one is due. */
export async function scheduleStats() {
  if (timer) clearTimeout(timer);
  // Without an answer, the refresh counts as due: it reports its own errors.
  const last = (await query<{ last: Date | null }>("SELECT max(fetched_at) AS last FROM video_stats").catch(() => []))[0]?.last;
  const tick = async () => {
    for (const p of listProjects()) if (!p.deletion) await inContext({ projectId: p.id }, () => startStatsRefresh()).catch((err) => console.warn(`YouTube statistics: ${(err as Error).message}`));
    timer = setTimeout(tick, intervalMs());
  };
  timer = setTimeout(tick, nextStatsDelay(last?.getTime(), intervalMs()));
}
