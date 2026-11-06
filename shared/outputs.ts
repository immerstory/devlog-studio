import type { Format, Post, PostStage } from "./types.js";

export type OutputId = Format | "article";
export interface ArticleDraft {
  title: string;
  summary: string;
  tags: string[];
  /** Markdown; pictures are written as {{image:<material or segment ID>}}. */
  body: string;
  /** Alt text per picture. Export needs it for every picture it uses. */
  images?: Record<string, { alt: string }>;
  coverId?: string;
  /** Absent means one derived from the title. */
  slug?: string;
  /** Body as the agent wrote it, for the restore action. */
  agentBody?: string;
}
export const VIDEO_STAGES: PostStage[] = ["questions", "script", "capture", "preview", "narrated", "final"];
/** The video outputs whose script has this segment. An output without a script has none. */
export function outputsWithSegment(post: Post, segmentId: string): Format[] {
  return post.outputs.filter((o): o is Format => o !== "article" && !!post.scripts[o]?.segments.some((s) => s.id === segmentId));
}

export function outputStage(post: Post, output: Format): PostStage {
  return post.outputStages?.[output] ?? "questions";
}
export function setOutputStage(post: Post, output: Format, stage: PostStage) {
  post.outputStages ??= {};
  post.outputStages[output] = stage;
  const stages = post.outputs.filter((o): o is Format => o !== "article").map((o) => outputStage(post, o));
  post.stage = VIDEO_STAGES[Math.min(...stages.map((s) => VIDEO_STAGES.indexOf(s)), VIDEO_STAGES.length - 1)];
}
