import type { Format, Script } from "../../shared/types.js";
import { VIDEO_STAGES } from "../../shared/outputs.js";
import { scriptSchema } from "../agent.js";
import { getProject } from "../projects.js";
import { scriptPrompt } from "../prompts.js";
import { normalizeScript, capturePost, narratePost, renderVideoPost, approveRender, revokeApproval, uploadToYouTube } from "../pipeline.js";
import type { OutputDefinition } from "./provider.js";

/** Each format retains its complete video workflow behind the output definition. */
export function videoOutput(format: Format): OutputDefinition<Script> & {
  capture: typeof capturePost;
  narrate: typeof narratePost;
  preview: typeof renderVideoPost;
  approve: typeof approveRender;
  revokeApproval: typeof revokeApproval;
  upload: typeof uploadToYouTube;
} {
  return {
    id: format, label: format === "portrait" ? "Portrait video" : "Landscape video", available: true, stages: VIDEO_STAGES,
    writer: {
      prompt: (ctx) => scriptPrompt(ctx.post, ctx.suggestions, format, ctx.materials, ctx.knownObjects, ctx.coHostDiscloses),
      schema: (ctx) => scriptSchema(getProject().settings.captureTargets, ctx.post.presentation?.[format] === "coHost"),
      normalize: (raw, ctx) => normalizeScript(raw as Parameters<typeof normalizeScript>[0], format, ctx.materialIds),
    },
    async export(post, _draft, log) {
      return { files: await renderVideoPost(post.id, format, "final", log) };
    },
    capture: capturePost, narrate: narratePost, preview: renderVideoPost, approve: approveRender, revokeApproval, upload: uploadToYouTube,
  };
}
