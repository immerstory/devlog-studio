/**
 * Writes co-hosted scripts for real posts with the real agent and stores nothing: the co-host exists only in this
 * process, and the database, posts and project stay as they are. Each script lands in <outDir> as JSON and text.
 *
 *   tsx scripts/cohost-dry-run.ts <projectId> <format> <outDir> <postId> [<postId> ...]
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { Format } from "../shared/types.js";

const [projectId, format, outDir, ...postIds] = process.argv.slice(2);
if (!projectId || !format || !outDir || !postIds.length) throw new Error("Usage: cohost-dry-run.ts <projectId> <format> <outDir> <postId> [<postId> ...]");

dotenv.config({ quiet: true });
const { loadConfig } = await import("../server/config.js");
const { loadProjects, getProject } = await import("../server/projects.js");
const { loadPost } = await import("../server/store.js");
const { inContext } = await import("../server/context.js");
const { generateScript } = await import("../server/pipeline.js");
const { newCoHost } = await import("../shared/cohost.js");
const { spokenTurns } = await import("../shared/turns.js");

await loadConfig();
await loadProjects();
getProject(projectId).settings.coHost = { ...newCoHost(), name: "Robin", voiceId: "dry-run" };
fs.mkdirSync(outDir, { recursive: true });

for (const postId of postIds) {
  await inContext({ projectId }, async () => {
    const stored = await loadPost(projectId, postId);
    const post = { ...stored, presentation: { ...stored.presentation, [format]: "coHost" as const } };
    console.log(`\n== ${post.title}`);
    const lines: string[] = [];
    const { script, review } = await generateScript(post, format as Format, (l) => { lines.push(l); console.log(l); });
    const turns = script.segments.flatMap(spokenTurns);
    const words = (speaker: string) => turns.filter((t) => t.speaker === speaker).reduce((n, t) => n + t.text.trim().split(/\s+/).length, 0);
    const text = [
      post.title,
      `Words: developer ${words("developer")}, co-host ${words("coHost")}`,
      `Flags: ${JSON.stringify(script.verification?.flags ?? "not verified")}`,
      "",
      ...script.segments.flatMap((s, i) => [`[${i}] ${s.visual.type}`, ...spokenTurns(s).map((t) => `  ${t.speaker === "coHost" ? "CO-HOST  " : "DEVELOPER"} ${t.text}`)]),
    ].join("\n");
    fs.writeFileSync(path.join(outDir, `${postId}.txt`), text);
    fs.writeFileSync(path.join(outDir, `${postId}.json`), JSON.stringify({ script, review, log: lines }, null, 1));
    console.log(text);
  });
}
process.exit(0);
