import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { CaptureTarget, Project } from "../../shared/projects.js";

type UnityTarget = Extract<CaptureTarget, { kind: "unity-mcp" }>;
import type { Material, Post, Script } from "../../shared/types.js";
import { inContext } from "../../server/context.js";
import { config, exampleConfig } from "../../server/config.js";
import { query } from "../../server/db.js";
import * as store from "../../server/store.js";
import { createProject, saveProject, getProject, saveConnection, deleteConnection, getConnection, deleteProject, type CleanupIO } from "../../server/projects.js";
import { removeMaterial } from "../../server/materials.js";
import { runDiscovery, runBackfill, backfilledWeeks } from "../../server/pipeline.js";
import type { runAgent } from "../../server/agent.js";
import { captureOperation, createCaptureSession, renderCapture } from "../../server/capture/provider.js";
import { scriptCaptureTargets } from "../../shared/references.js";
import { unityProvider } from "../../server/capture/unity/index.js";
import { startStatsRefresh } from "../../server/stats.js";
import { buildTimeline } from "../../server/timeline.js";

function post(id: string): Post {
  return { id, title: "Reference test", createdAt: new Date().toISOString(), suggestionIds: [], materialIds: [], outputs: ["portrait"], outputDirs: [], outputStages: {}, brief: "", questions: [], scripts: {}, narration: {}, renders: {}, stage: "questions" };
}
function script(): Script {
  return { title: "Reference test", format: "portrait", metadata: { title: "", description: "", tags: [] }, segments: [
    { id: "custom-shot", narration: "", visual: { type: "material", description: "Photo", materialId: "mat-review-photo" } },
    { id: "seg-review-slide", narration: "", visual: { type: "slide", layout: "compare", heading: "Views", imageFrom: ["custom-shot", "mat-review-photo", "mat-review-keep"], captions: { "custom-shot": "Shot", "mat-review-photo": "Photo", "mat-review-keep": "Keep" } } },
  ] };
}
function material(id: string): Material {
  return { id, title: id, createdAt: new Date().toISOString(), date: "2026-11-03", kind: "image", fileName: "image.png", contentType: "image/png", size: 1, key: `materials/${id}/image.png`, thumbKey: `materials/${id}/thumb.png`, previewKey: `materials/${id}/preview.png`, annotation: "", tags: [] };
}
function suggestion(title: string, date: string, commits: string[]) {
  return { title, duplicateOf: "", hook: "", summary: title, whyItMatters: "", kind: "other", appeal: 3, recommendedFormat: "either", workDate: date, commits, files: [], notes: [], materials: [], suggestedShots: [] };
}
function evidenceFrom(prompt: string) {
  return JSON.parse(fs.readFileSync(/JSON file: ([^\r\n]+)/.exec(prompt)![1], "utf8"));
}

export async function runReviewRegressions(t: TestContext, one: Project, two: Project, io: CleanupIO) {
  await t.test("invalid agent citations do not prevent discovery snapshot progress", async () => {
    let calls = 0;
    const logs: string[] = [];
    const writer = (async ({ prompt }: { prompt: string }) => {
      calls++;
      const evidence = evidenceFrom(prompt);
      const commit = evidence.commits[0];
      assert.ok(commit);
      return { agent: "claude", output: { suggestions: [suggestion("Citation normalization", commit.date.slice(0, 10), [commit.hash.slice(0, 7), "HEAD~1", "source-foreign:abcdef0"])] } };
    }) as typeof runAgent;
    await inContext({ projectId: two.id }, () => runDiscovery((line) => logs.push(line), undefined, writer));
    assert.ok(await store.getSnapshot(two.id));
    const saved = (await store.listSuggestions(two.id)).find((s) => s.title === "Citation normalization")!;
    assert.equal(saved.sources.commits.length, 1);
    assert.ok(saved.sources.commits[0].startsWith(two.settings.primarySourceId + ":"));
    assert.ok(logs.some((line) => line.includes("Ignored 2")));
    await inContext({ projectId: two.id }, () => runDiscovery(() => {}, undefined, writer));
    assert.equal(calls, 1, "the same evidence does not trigger another paid run");
  });

  await t.test("backfill enriches cross-week topics and advances despite invalid citations", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
    let pid: string | undefined;
    try {
      const git = (args: string[], date?: string) => execFileSync("git", args, { cwd: repo, windowsHide: true, env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }, encoding: "utf8" });
      git(["init", "--quiet"]);
      for (const [i, date] of ["2026-10-05T12:00:00Z", "2026-10-12T12:00:00Z"].entries()) {
        fs.writeFileSync(path.join(repo, "work.txt"), String(i));
        git(["add", "work.txt"]);
        git(["-c", "user.name=Test Author", "-c", "user.email=author@example.com", "commit", "--quiet", "-m", `Week ${i + 1}`], date);
      }
      const project = await createProject({ name: "Cross-week fixture", sourcePath: repo }); pid = project.id;
      let calls = 0;
      const writer = (async ({ prompt }: { prompt: string }) => {
        calls++;
        const evidence = evidenceFrom(prompt);
        const existing = evidence.existingSuggestions.find((s: { title: string }) => s.title === "Work across weeks");
        if (calls === 2) { assert.ok(existing); assert.ok(prompt.includes(existing.title)); }
        return { agent: "claude", output: { suggestions: [{ ...suggestion(existing ? "New wording for tracked work" : "Work across weeks", evidence.range.since, [evidence.commits[0].hash.slice(0, 7), "HEAD~1"]), duplicateOf: existing?.id ?? "" }] } };
      }) as typeof runAgent;
      await inContext({ projectId: pid }, () => runBackfill("2026-10-05", "2026-10-18", false, () => {}, undefined, writer));
      const saved = await store.listSuggestions(pid);
      assert.equal(saved.length, 1);
      assert.equal(saved[0].sources.commits.length, 2);
      assert.equal((await inContext({ projectId: pid }, backfilledWeeks)).length, 2);
      await inContext({ projectId: pid }, () => runBackfill("2026-10-05", "2026-10-18", false, () => {}, undefined, writer));
      assert.equal(calls, 2);
      await store.updateSuggestions(pid, [saved[0].id], (items) => { items[0].status = "dismissed"; });
      const newWork = (async ({ prompt }: { prompt: string }) => {
        const evidence = evidenceFrom(prompt);
        assert.ok(!evidence.existingSuggestions.some((s: { id: string }) => s.id === saved[0].id));
        assert.ok(!prompt.includes(saved[0].title));
        return { agent: "claude", output: { suggestions: [{ ...suggestion(saved[0].title, evidence.range.since, [evidence.commits[0].hash]), duplicateOf: saved[0].id }] } };
      }) as typeof runAgent;
      await inContext({ projectId: pid }, () => runBackfill("2026-10-12", "2026-10-18", true, () => {}, undefined, newWork));
      const afterDismissal = await store.listSuggestions(pid);
      assert.equal(afterDismissal.length, 2);
      assert.equal(afterDismissal.find((s) => s.id === saved[0].id)!.status, "dismissed");
      assert.equal(afterDismissal.find((s) => s.id !== saved[0].id)!.status, "proposed");
    } finally {
      if (pid) await deleteProject(pid, false, io);
      assert.equal(path.dirname(repo), path.resolve(os.tmpdir()));
      assert.ok(path.basename(repo).startsWith("devlog-test-"));
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  await t.test("material deletion atomically detaches posts, slides, suggestions and theme", async () => {
    for (const id of ["mat-review-photo", "mat-review-keep"]) await store.saveMaterial(one.id, material(id));
    await store.saveMaterial(two.id, material("mat-review-foreign"));
    const p = { ...post("post-review-material"), materialIds: ["mat-review-photo"], scripts: { portrait: script(), landscape: { ...script(), format: "landscape" as const } } };
    await store.savePost(one.id, p);
    const settings = structuredClone(getProject(one.id).settings);
    settings.theme.backgroundMaterialIds = ["mat-review-photo"];
    await saveProject(one.id, settings);
    const source = (await store.listSuggestions(one.id))[0];
    await store.updateSuggestions(one.id, [source.id], (items) => { items[0].materialIds = ["mat-review-photo"]; });
    await assert.rejects(inContext({ projectId: two.id }, () => removeMaterial("mat-review-photo", async () => { throw new Error("Must not remove another project's files"); })), /not found/);
    await query(`CREATE FUNCTION reject_material_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.id = 'mat-review-photo' THEN RAISE EXCEPTION 'simulated commit failure'; END IF;
      RETURN OLD; END $$;
      CREATE CONSTRAINT TRIGGER reject_material_commit AFTER DELETE ON materials DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_material_commit();`);
    let cleanupCalls = 0;
    try {
      await assert.rejects(inContext({ projectId: one.id }, () => removeMaterial("mat-review-photo", async () => { cleanupCalls++; })), /commit failure/);
      assert.equal(cleanupCalls, 0, "failed commits must not delete files");
    } finally { await query("DROP TRIGGER reject_material_commit ON materials; DROP FUNCTION reject_material_commit()"); }
    assert.equal((await store.getMaterials(one.id, ["mat-review-photo"])).length, 1);
    assert.deepEqual((await store.loadPost(one.id, p.id)).materialIds, ["mat-review-photo"]);
    await store.saveMaterial(one.id, material("mat-review-orphan"));
    const partial = await inContext({ projectId: one.id }, () => removeMaterial("mat-review-orphan", async () => { throw new Error("simulated storage failure"); }));
    assert.deepEqual(partial, { deleted: true, warning: "Material deleted. Some stored files could not be removed." });
    await assert.rejects(store.getMaterials(one.id, ["mat-review-orphan"]), /not found/);
    const removed: string[] = [];
    let release!: () => void, started!: () => void;
    const deleting = new Promise<void>((resolve) => { started = resolve; });
    const finishCleanup = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = inContext({ projectId: one.id }, () => removeMaterial("mat-review-photo", async (prefix) => { removed.push(prefix); started(); await finishCleanup; }));
    await deleting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(store.getMaterials(one.id, ["mat-review-photo"]), /not found/);
      assert.deepEqual(getProject(one.id).settings.theme.backgroundMaterialIds, []);
      await Promise.race([
        store.updatePost(one.id, p.id, (p) => { p.title = "Writes proceed during file cleanup"; }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("File cleanup holds the project lock")), 2000); }),
      ]);
      await assert.rejects(store.updatePost(one.id, p.id, (p) => { p.materialIds = ["mat-review-photo"]; }), /not found/);
    } finally { clearTimeout(timer); release(); await cleanup; }
    assert.deepEqual(removed, ["materials/mat-review-photo/"]);
    await assert.rejects(store.getMaterials(one.id, ["mat-review-photo"]), /not found/);
    const detached = await store.loadPost(one.id, p.id);
    assert.deepEqual(detached.materialIds, []);
    for (const script of Object.values(detached.scripts)) {
      const shot = script!.segments[0].visual;
      assert.ok(shot.type === "material"); assert.equal(shot.materialId, undefined);
      const slide = script!.segments[1].visual;
      assert.ok(slide.type === "slide");
      assert.deepEqual(slide.imageFrom, ["custom-shot", "mat-review-keep"]);
      assert.deepEqual(slide.captions, { "custom-shot": "Shot", "mat-review-keep": "Keep" });
    }
    assert.deepEqual(getProject(one.id).settings.theme.backgroundMaterialIds, []);
    assert.deepEqual((await store.getSuggestions(one.id, [source.id]))[0].materialIds, []);
    await store.updatePost(one.id, p.id, (p) => { p.title = "Still editable"; });
    await inContext({ projectId: one.id }, () => buildTimeline(detached, "portrait", false));
    await assert.rejects(store.updatePost(one.id, p.id, (p) => { p.scripts.portrait!.segments[1].visual = { type: "slide", layout: "image", heading: "Foreign", imageFrom: ["mat-review-foreign"] }; }), /not found/);
    await store.updatePost(one.id, p.id, (p) => { p.scripts.portrait!.segments.splice(0, 1); });
    const slide = (await store.loadPost(one.id, p.id)).scripts.portrait!.segments[0].visual;
    assert.ok(slide.type === "slide");
    assert.deepEqual(slide.imageFrom, ["mat-review-keep"], "removed custom segment IDs are not misclassified as materials");
  });

  await t.test("changing the default pins existing shots without changing published work", async () => {
    const settings = structuredClone(getProject(one.id).settings);
    const target = { id: "target-pin-old", label: "Original editor", kind: "unity-mcp" as const, config: { ...exampleConfig().unity.mcp, projectPath: process.cwd() } };
    settings.captureTargets = [target, { ...target, id: "target-pin-new", label: "New editor" }];
    settings.defaultCaptureTargetId = target.id;
    await saveProject(one.id, settings);
    const published: Post = { ...post("post-review-default"), stage: "final", outputStages: { portrait: "final" }, renders: { portrait: { final: "existing-final.mp4", approvedAt: "2026-11-03T12:00:00Z" } }, scripts: { portrait: { ...script(), segments: [{ id: "seg-default-shot", narration: "Keep this view", visual: { type: "capture", description: "Original scene", shot: { model: "scene", motion: { type: "orbit", amount: 45 }, fov: 40 } } }] } } };
    await store.savePost(one.id, published);
    await saveProject(one.id, { ...settings, defaultCaptureTargetId: "target-pin-new" });
    const pinned = await store.loadPost(one.id, published.id);
    const expected = structuredClone(published);
    const visual = expected.scripts.portrait!.segments[0].visual;
    assert.ok(visual.type === "capture"); visual.targetId = "target-pin-old";
    assert.deepEqual(pinned, expected);
    assert.equal(getProject(one.id).settings.defaultCaptureTargetId, "target-pin-new");
    await assert.rejects(saveProject(one.id, { ...settings, captureTargets: settings.captureTargets.filter((t) => t.id !== "target-pin-old"), defaultCaptureTargetId: "target-pin-new" }), /still uses/);
    const stale = structuredClone(published.scripts.portrait!);
    stale.segments[0].narration = "Edited in a tab opened before the default changed";
    await store.saveScript(one.id, published.id, "portrait", stale, scriptCaptureTargets(published.scripts.portrait));
    const saved = (await store.loadPost(one.id, published.id)).scripts.portrait!;
    assert.ok(saved.segments[0].visual.type === "capture");
    assert.equal(saved.segments[0].visual.targetId, "target-pin-old");
    assert.equal(saved.segments[0].narration, stale.segments[0].narration);
    const reset = structuredClone(saved);
    assert.ok(reset.segments[0].visual.type === "capture");
    delete reset.segments[0].visual.targetId;
    await store.saveScript(one.id, published.id, "portrait", reset, scriptCaptureTargets(saved));
    const followingDefault = (await store.loadPost(one.id, published.id)).scripts.portrait!.segments[0].visual;
    assert.ok(followingDefault.type === "capture");
    assert.equal(followingDefault.targetId, undefined);
  });

  await t.test("capture queries and renders do not issue redundant status calls", async () => {
    const target = { id: "target-review", label: "Fixture editor", kind: "unity-mcp" as const, config: { ...exampleConfig().unity.mcp, projectPath: process.cwd() } };
    await saveProject(two.id, { ...getProject(two.id).settings, captureTargets: [target], defaultCaptureTargetId: target.id });
    let statusCalls = 0, queries = 0, renders = 0;
    const original = { status: unityProvider.status, findObjects: unityProvider.findObjects, render: unityProvider.render };
    unityProvider.status = async () => { statusCalls++; return { ok: true, detail: "Fixture" }; };
    unityProvider.findObjects = async () => { queries++; return []; };
    unityProvider.render = async () => { renders++; return { file: "mock.png" }; };
    try {
      await inContext({ projectId: two.id }, async () => {
        for (let i = 0; i < 40; i++) await captureOperation(target.id, "objects", "Object", 1);
        await renderCapture({ type: "capture", description: "Fixture", shot: { model: "scene", motion: { type: "still" } } }, { dir: "mock-output", format: "portrait", frames: 1, fps: 30 }, () => {});
        assert.equal(statusCalls, 0);
        await captureOperation(target.id, "status");
      });
      assert.equal(statusCalls, 1); assert.equal(queries, 40); assert.equal(renders, 1);
    } finally { Object.assign(unityProvider, original); }
  });

  await t.test("capture sessions retain their editor across default and configuration changes", async () => {
    const settings = structuredClone(getProject(two.id).settings);
    const old = settings.captureTargets[0] as UnityTarget;
    settings.captureTargets.push({ ...structuredClone(old), id: "target-session-new", config: { ...old.config, url: "http://127.0.0.1:8082/mcp" } });
    await saveProject(two.id, settings);
    const original = unityProvider.render;
    const urls: string[] = [];
    unityProvider.render = async (target) => { urls.push(target.url); return { file: "mock.png" }; };
    try {
      await inContext({ projectId: two.id }, async () => {
        const session = createCaptureSession();
        const visual = { type: "capture" as const, description: "Scene", shot: { model: "scene" as const, motion: { type: "still" as const } } };
        const output = { dir: "mock-output", format: "portrait" as const, frames: 1, fps: 30 };
        await session.render(visual, output, () => {});
        const changed = structuredClone(settings);
        changed.defaultCaptureTargetId = "target-session-new";
        (changed.captureTargets[0] as UnityTarget).config.url = "http://127.0.0.1:8081/mcp";
        await saveProject(two.id, changed);
        await session.render(visual, output, () => {});
        await renderCapture(visual, output, () => {});
      });
      assert.deepEqual(urls, [old.config.url, old.config.url, "http://127.0.0.1:8082/mcp"]);
    } finally { unityProvider.render = original; }
  });

  await t.test("manual and scheduled statistics refreshes share the same running job", async () => {
    let release!: () => void, calls = 0;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const refresh = async () => { calls++; await pending; };
    try {
      const first = await inContext({ projectId: one.id }, () => startStatsRefresh(refresh));
      const second = await inContext({ projectId: one.id }, () => startStatsRefresh(refresh));
      assert.equal(first.id, second.id); assert.equal(calls, 1);
    } finally { release(); await new Promise((resolve) => setImmediate(resolve)); }
  });

  await t.test("connection deletion rolls back project defaults and cache on any failure", async () => {
    const cid = "youtube-review-rollback";
    await saveConnection({ id: cid, name: "Fixture", clientId: "fixture-client" });
    for (const p of [one, two]) await saveProject(p.id, { ...getProject(p.id).settings, publishing: { ...getProject(p.id).settings.publishing, connectionId: cid } });
    const quoted = (await query("SELECT quote_literal($1) AS id", [two.id]))[0].id;
    await query(`CREATE FUNCTION reject_connection_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.id = TG_ARGV[0] AND OLD.data #>> '{settings,publishing,connectionId}' IS NOT NULL AND NEW.data #>> '{settings,publishing,connectionId}' IS NULL THEN RAISE EXCEPTION 'simulated project update failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_connection_cleanup BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION reject_connection_cleanup(${quoted});`);
    try {
      await assert.rejects(deleteConnection(cid), /simulated project update failure/);
      assert.equal(getConnection(cid).clientId, "fixture-client");
      assert.equal((await query("SELECT id FROM egress_connections WHERE id = $1", [cid])).length, 1);
      for (const p of [one, two]) {
        assert.equal(getProject(p.id).settings.publishing.connectionId, cid);
        assert.equal((await query("SELECT data #>> '{settings,publishing,connectionId}' AS cid FROM projects WHERE id = $1", [p.id]))[0].cid, cid);
        assert.equal(inContext({ projectId: p.id }, () => config().youtube.clientId), "fixture-client");
      }
    } finally { await query("DROP TRIGGER reject_connection_cleanup ON projects; DROP FUNCTION reject_connection_cleanup()"); }
    await deleteConnection(cid);
    for (const p of [one, two]) assert.equal(getProject(p.id).settings.publishing.connectionId, undefined);
    getProject(one.id).settings.publishing.connectionId = "youtube-missing";
    try {
      assert.doesNotThrow(() => inContext({ projectId: one.id }, config));
      assert.throws(() => inContext({ projectId: one.id, connectionId: "youtube-missing" }, config), /not found/);
    } finally { delete getProject(one.id).settings.publishing.connectionId; }
  });
}
