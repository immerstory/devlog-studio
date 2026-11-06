import { query } from "../db.js";
import { inContext } from "../context.js";
import { videoDetails } from "../youtube.js";
import { youtubePublicationId, type EgressConnection, type Publication, type PublicationState } from "../../shared/publications.js";
import type { Format, YouTubeUpload } from "../../shared/types.js";
import type { EgressConnector } from "./provider.js";

export const stateOfUpload = (upload: YouTubeUpload): PublicationState => (upload.status === "uploading" ? "publishing" : upload.status === "failed" ? "failed" : "published");

/** A publication's record of its upload, in the shape stored for it. */
export function uploadPublication(pid: string, postId: string, format: Format, upload: YouTubeUpload, connectionId: string, createdAt: string): Publication {
  return {
    id: youtubePublicationId(postId, format), postId, connector: "youtube", connectionId, content: { videoFormat: format }, dependsOn: [], state: stateOfUpload(upload), createdAt,
    result: { platformId: upload.videoId, url: upload.url, publishedAt: upload.publishedAt ?? upload.uploadedAt, error: upload.error, upload },
  };
}

const rowsOf = async (pid: string, postId?: string) => (await query<{ data: Publication }>(`SELECT data FROM publications WHERE project_id = $1 AND data->>'connector' = 'youtube'${postId ? " AND post_id = $2" : ""}`, postId ? [pid, postId] : [pid])).map((r) => r.data);

export interface VideoUpload { postId: string; format: Format; upload: YouTubeUpload }
/** Every upload of a project, or of one post. */
export async function listUploads(pid: string, postId?: string): Promise<VideoUpload[]> {
  return (await rowsOf(pid, postId)).flatMap((p) => (p.result?.upload ? [{ postId: p.postId, format: p.content.videoFormat!, upload: p.result.upload }] : []));
}
export async function getUpload(pid: string, postId: string, format: Format): Promise<YouTubeUpload | undefined> {
  return (await query<{ data: Publication }>("SELECT data FROM publications WHERE project_id = $1 AND id = $2", [pid, youtubePublicationId(postId, format)]))[0]?.data.result?.upload;
}
/** Records an upload's state. Don't call this inside a post's transaction: that transaction locks the project row, which this insert needs to read. */
export async function setUpload(pid: string, postId: string, format: Format, upload: YouTubeUpload) {
  const id = youtubePublicationId(postId, format);
  const existing = (await query<{ data: Publication }>("SELECT data FROM publications WHERE project_id = $1 AND id = $2", [pid, id]))[0]?.data;
  const next = uploadPublication(pid, postId, format, upload, upload.connectionId ?? existing?.connectionId ?? "", existing?.createdAt ?? new Date().toISOString());
  await query("INSERT INTO publications (id, project_id, post_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET data = $4", [id, pid, postId, next]);
}

export type YoutubeIsPublic = (videoId: string, connectionId: string | undefined) => Promise<boolean>;
export const askYoutubeIsPublic: YoutubeIsPublic = async (videoId, connectionId) => {
  const details = await inContext({ connectionId }, () => videoDetails([videoId]));
  return details[0]?.privacy === "public";
};

/** Whether an upload can be seen by the public. It stays private until its publish time, and the platform has the last word. */
export async function uploadIsPublic(upload: YouTubeUpload | undefined, ask: YoutubeIsPublic = askYoutubeIsPublic): Promise<boolean> {
  if (!upload?.videoId) return false;
  if (upload.status === "uploaded" && upload.privacy === "public") return true;
  if (upload.publishAt && new Date(upload.publishAt).getTime() > Date.now()) return false;
  return ask(upload.videoId, upload.connectionId).catch(() => false);
}

/**
 * Publishes through a post's Final step, because an upload needs a long job with progress, cancelling and a final OK
 * of the render. This connector gives it the same place as the others: its record, its dependents and its connection.
 */
export const youtubeConnector: EgressConnector = {
  id: "youtube",
  label: "YouTube",
  accepts: ["video"],
  capabilities: { schedules: true, idempotent: false, metrics: false },
  validate: () => [],
  publish: async () => { throw Object.assign(new Error("Upload this video from the post's Final step."), { status: 409 }); },
  isPublic: (result, _connection: EgressConnection) => uploadIsPublic(result.upload),
};
