/**
 * Explicit smoke test: renders the takes of a listening test as a co-hosted final video, without any ElevenLabs
 * request. It uses a disposable schema and creates and deletes its own Garage objects. Word timings are estimates
 * stretched to each take's real length. The video and its subtitles land next to the dialogue file.
 *
 *   tsx scripts/test-cohost-render.ts <dialogue.json>
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { newCoHost } from "../shared/cohost.js";
import type { Script, Turn } from "../shared/types.js";

const file = process.argv[2];
if (!file) throw new Error("Usage: test-cohost-render.ts <dialogue.json>");
const dir = path.dirname(path.resolve(file));
const { turns } = JSON.parse(fs.readFileSync(file, "utf8")) as { turns: Turn[] };
const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) as { takes: Record<string, { durationMs: number }> };

dotenv.config({ quiet: true });
const original = process.env.DATABASE_URL!;
const admin = new pg.Pool({ connectionString: original });
const schema = `codex_cohost_${crypto.randomBytes(8).toString("hex")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const url = new URL(original);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const { migrate, db } = await import("../server/db.js");
const { loadConfig } = await import("../server/config.js");
const { loadProjects, createProject, saveProject, getProject, deleteProject } = await import("../server/projects.js");
const { savePost, saveScript, loadPost, newId } = await import("../server/store.js");
const { inContext } = await import("../server/context.js");
const { putBuffer, deleteKey } = await import("../server/storage.js");
const { projectVoices, takeHash } = await import("../server/takes.js");
const { estimateWords } = await import("../server/timeline.js");

let pid: string | undefined;
let projectFolder: string | undefined;
const seeded: string[] = [];
try {
  await migrate(); await (await import("../server/extensions.js")).loadExtensions(); await loadConfig(); await loadProjects();
  const project = await createProject({ name: "Co-host render smoke test", sourcePath: process.cwd() });
  pid = project.id;
  await saveProject(pid, {
    ...project.settings,
    // Voice IDs that exist nowhere: a cache miss fails instead of billing.
    narration: { ...project.settings.narration, voiceId: "smoke-narrator" },
    coHost: { ...newCoHost(), name: "Robin", voiceId: "smoke-cohost" },
  });
  const id = newId("codex-test-cohost");
  const render = inContext({ projectId: pid }, async () => {
    const voices = projectVoices();
    for (const turn of turns) {
      const hash = takeHash(voices(turn.speaker)!, turn.text);
      const { durationMs } = report.takes[turn.id];
      const estimate = estimateWords(turn.text);
      const scale = durationMs / estimate.at(-1)!.endMs;
      const words = estimate.map((w) => ({ text: w.text, startMs: Math.round(w.startMs * scale), endMs: Math.round(w.endMs * scale) }));
      await putBuffer(`tts/${hash}.mp3`, fs.readFileSync(path.join(dir, `${turn.id}.mp3`)));
      await putBuffer(`tts/${hash}.json`, JSON.stringify({ words, durationMs, generatedAt: 1 }));
      seeded.push(`tts/${hash}.mp3`, `tts/${hash}.json`);
    }
    const { setPresentation, narratePost, renderPost } = await import("../server/pipeline.js");
    await savePost(pid!, { id, title: "Co-host render check", createdAt: new Date().toISOString(), outputDirs: [], suggestionIds: [], materialIds: [], outputs: ["portrait"], outputStages: {}, brief: "", questions: [], narration: {}, renders: {}, scripts: {}, stage: "questions" });
    await setPresentation(id, "portrait", "coHost", false);
    const segments: Script["segments"] = [];
    for (let i = 0; i < turns.length; i += 3) segments.push({ id: `seg-${i}`, narration: "", turns: turns.slice(i, i + 3), visual: { type: "slide", layout: "title", heading: `Part ${i / 3 + 1}` } });
    await saveScript(pid!, id, "portrait", { format: "portrait", title: "Co-host render check", metadata: { title: "Co-host render check", description: "", tags: [] }, segments });
    await narratePost(id, "portrait", console.log);
    await renderPost(id, "portrait", "final", console.log);
  });
  await render;
  const { final, srt } = (await loadPost(pid, id)).renders.portrait!;
  projectFolder = path.dirname(path.dirname(final!));
  fs.copyFileSync(final!, path.join(dir, "dialogue-render.mp4"));
  fs.copyFileSync(srt!, path.join(dir, "dialogue-render.srt"));
  console.log(`Project co-host: ${getProject(pid).settings.coHost?.name}. Video: ${path.join(dir, "dialogue-render.mp4")}`);
} finally {
  try { if (pid) await deleteProject(pid, true); }
  finally {
    for (const key of seeded) await deleteKey(key).catch(() => {});
    if (projectFolder) fs.rmdirSync(projectFolder);
    await db().end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    process.env.DATABASE_URL = original;
  }
}
process.exit(0);
