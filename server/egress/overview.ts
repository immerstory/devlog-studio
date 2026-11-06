import { projectId } from "../context.js";
import { listPosts } from "../store.js";
import { evidenceSnapshot, verificationState } from "../verification.js";
import { CONNECTOR_LABEL, youtubePublicationId, type EgressConnectorId, type Publication } from "../../shared/publications.js";
import type { Format, Post, PostOverview } from "../../shared/types.js";
import { listPublications } from "./publish.js";

const FORMAT_LABEL: Record<Format, string> = { portrait: "Short", landscape: "video" };
const videoFormats = (post: Post) => post.outputs.filter((o): o is Format => o !== "article");
const STATE_LABEL: Partial<Record<Publication["state"], string>> = { draft: "Draft", approved: "Approved", waiting: "Waiting", scheduled: "Scheduled", late: "Missed its time", publishing: "Publishing", published: "Published", failed: "Failed", cancelled: "Cancelled" };

function destinationOf(p: Publication) {
  const youtube = p.connector === "youtube";
  const upload = p.result?.upload;
  const state = youtube
    ? upload?.status === "scheduled" ? "Scheduled" : upload?.status === "uploading" ? "Uploading" : upload?.status === "failed" ? "Failed" : upload?.videoId ? "Published" : "Not uploaded"
    : STATE_LABEL[p.state] ?? p.state;
  const name = youtube ? `YouTube ${FORMAT_LABEL[p.content.videoFormat!]}` : CONNECTOR_LABEL[p.connector as EgressConnectorId];
  return { id: p.id, connector: p.connector, name, state, url: p.result?.url };
}

function publicationProblem(p: Publication, name: string): string | undefined {
  if (p.state === "failed") return `${name} failed`;
  if (p.state === "late") return `${name} missed its publish time`;
  // A cancelled dependency moves its dependents back to draft with a note, and they need a new decision.
  if (p.state === "draft" && p.result?.error) return `${name} needs a new decision`;
  return undefined;
}

/** Why a post needs the developer. Only checks a co-hosted format's lines where it has a script, because reading evidence costs queries. */
async function attentionOf(pid: string, post: Post, publications: Publication[]): Promise<string[]> {
  const reasons = publications.flatMap((p) => publicationProblem(p, destinationOf(p).name) ?? []);
  let evidence: string | undefined;
  for (const format of videoFormats(post)) {
    const script = post.scripts[format];
    if (post.presentation?.[format] !== "coHost" || !script) continue;
    evidence ??= await evidenceSnapshot(pid, post);
    const state = verificationState(script, post, evidence);
    if (state === "flagged") reasons.push(`Flagged co-host lines in the ${FORMAT_LABEL[format]}`);
    if (state === "outOfDate") reasons.push(`Co-host lines in the ${FORMAT_LABEL[format]} need a check`);
  }
  return reasons;
}

/** Every post of the project with its status: what it produces, where it goes, and whether it needs the developer. */
export async function postsOverview(): Promise<PostOverview[]> {
  const pid = projectId();
  const posts = await listPosts(pid);
  const all = await listPublications(pid);
  return Promise.all(posts.map(async (post) => {
    const own = all.filter((p) => p.postId === post.id);
    // A video goes to YouTube, so it counts as a destination before it has been uploaded.
    const notUploaded = videoFormats(post).filter((f) => !own.some((p) => p.id === youtubePublicationId(post.id, f))).map((f): Publication => ({ id: youtubePublicationId(post.id, f), postId: post.id, connector: "youtube", connectionId: "", content: { videoFormat: f }, dependsOn: [], state: "draft", createdAt: post.createdAt }));
    return {
      id: post.id, title: post.title, stage: post.stage, outputs: post.outputs, publishDate: post.publishDate, createdAt: post.createdAt, topics: post.suggestionIds.length,
      destinations: [...notUploaded, ...own].map(destinationOf),
      attention: await attentionOf(pid, post, own),
    };
  }));
}
