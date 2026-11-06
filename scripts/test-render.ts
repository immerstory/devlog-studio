/** Explicit smoke test: renders a draft and creates/deletes its own Garage objects. */
import pg from "pg";
import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config({ quiet: true });
const original = process.env.DATABASE_URL!;
const admin = new pg.Pool({ connectionString: original });
const schema = `devlog_render_${crypto.randomBytes(8).toString("hex")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const url = new URL(original);
url.searchParams.set("options", `-c search_path=${schema}`);
process.env.DATABASE_URL = url.toString();
const { migrate, db } = await import("../server/db.js");
const { loadConfig } = await import("../server/config.js");
const { loadProjects, createProject, deleteProject } = await import("../server/projects.js");
const { savePost, loadPost, newId } = await import("../server/store.js");
const { inContext } = await import("../server/context.js");
let pid: string | undefined;
try {
  await migrate(); await (await import("../server/extensions.js")).loadExtensions(); await loadConfig(); await loadProjects();
  const project = await createProject({ name: "Render smoke test", sourcePath: process.cwd() });
  pid = project.id;
  const id = newId("codex-test-render");
  await savePost(pid, {
    id, title: "Render check", createdAt: new Date().toISOString(), outputDirs: [], suggestionIds: [], materialIds: [], outputs: ["portrait"], outputStages: {}, brief: "", questions: [], narration: {}, renders: {}, stage: "script",
    scripts: { portrait: { format: "portrait", title: "Render check", metadata: { title: "Render check", description: "", tags: [] }, segments: [{ id: "title", narration: "", visual: { type: "slide", layout: "title", heading: "Project output check" } }] } },
  });
  const { renderPost } = await import("../server/pipeline.js");
  await inContext({ projectId: pid }, () => renderPost(id, "portrait", "draft", console.log));
  const result = await loadPost(pid, id);
  const { exists } = await import("../server/storage.js");
  if (!result.renders.portrait?.draft || !await exists(result.renders.portrait.draft)) throw new Error("Draft was not stored");
  console.log("Draft render verified.");
} finally {
  try { if (pid) await deleteProject(pid, true); }
  finally {
    await db().end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    process.env.DATABASE_URL = original;
  }
}
