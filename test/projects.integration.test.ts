import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

/** Opt in: uses only a disposable schema. */
test("project migrations, ownership and deletion recovery", { skip: !process.env.DEVLOG_INTEGRATION && process.env.npm_lifecycle_event !== "test:integration" }, async (t) => {
  dotenv.config({ quiet: true });
  const original = process.env.DATABASE_URL!;
  const admin = new pg.Pool({ connectionString: original });
  const schema = `devlog_test_${crypto.randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(original);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { migrate, db, query } = await import("../server/db.js");
  const { loadConfig } = await import("../server/config.js");
  const { loadProjects, listProjects, createProject, saveProject, deleteProject: deleteProjectWithStorage, getProject } = await import("../server/projects.js");
  const noStorage: import("../server/projects.js").CleanupIO = {
    listKeys: async (_prefix: string): Promise<string[]> => { throw new Error("Integration tests must not list real Garage objects"); },
    deleteKey: async (_key: string) => { throw new Error("Integration tests must not delete real Garage objects"); },
    removeFolder: (_dir: string) => { throw new Error("Integration tests must not delete real output folders"); },
  };
  const deleteProject = (id: string, files: boolean, io = noStorage) => deleteProjectWithStorage(id, files, io);
  const store = await import("../server/store.js");
  const { inContext } = await import("../server/context.js");
  const { startJob } = await import("../server/jobs.js");
  try {
    await migrate(); await loadConfig(); await loadProjects();
    assert.equal(listProjects().length, 0, "fresh install has no project");
    const migrations = (await query("SELECT * FROM schema_migrations")).length;
    await migrate();
    assert.equal((await query("SELECT * FROM schema_migrations")).length, migrations, "a second run changes nothing");
    const one = await createProject({ name: "Test One", sourcePath: process.cwd() });
    const two = await createProject({ name: "Test Two", sourcePath: process.cwd() });
    {
      const { listSessionImages, setSessionImageStatus } = await import("../server/sessionImages.js");
      const image = (id: string, recordId: string, extra: object = {}) => ({ id, recordId, at: `2026-11-03T10:00:${id.slice(-2)}Z`, status: "inbox", ...extra });
      for (const row of [image("si-01", "claude-sessions:shown:2026-11-03"), image("si-02", "claude-sessions:excluded:2026-11-03"), image("si-03", "claude-sessions:unread:2026-11-03", { otherWork: true }), image("si-04", "claude-sessions:unread:2026-11-03"), image("si-05", "claude-sessions:shown:2026-11-03", { status: "added", materialId: "mat-1" })]) {
        await query("INSERT INTO session_images (project_id, id, date, data) VALUES ($1, $2, '2026-11-03', $3)", [one.id, row.id, row]);
      }
      for (const [id, visibility] of [["claude-sessions:shown:2026-11-03", "private"], ["claude-sessions:excluded:2026-11-03", "excluded"]]) {
        await query("INSERT INTO activity (project_id, id, date, data) VALUES ($1, $2, '2026-11-03', $3)", [one.id, id, { id, kind: "session", visibility }]);
      }
      assert.deepEqual((await listSessionImages(one.id)).map((i) => i.id).sort(), ["si-01", "si-04"], "an excluded session, other work without a record and added images stay out");
      assert.deepEqual(await listSessionImages(two.id), [], "images belong to one project");
      await inContext({ projectId: one.id }, async () => {
        assert.equal((await setSessionImageStatus("si-01", "dismissed")).status, "dismissed");
        assert.equal((await setSessionImageStatus("si-01", "inbox")).status, "inbox");
        await assert.rejects(setSessionImageStatus("si-05", "inbox"), /no longer in the inbox/);
      });
      await query("DELETE FROM activity WHERE project_id = $1", [one.id]);
    }
    {
      const { execFileSync } = await import("node:child_process");
      const os = await import("node:os");
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-feed-"));
      const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true }).toString();
      sh("init", "-q"); sh("config", "user.email", "test@example.com"); sh("config", "user.name", "Test");
      const today = new Date();
      const day = (offset: number) => { const d = new Date(today); d.setDate(d.getDate() - offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      fs.writeFileSync(path.join(repo, `brief-${day(1)}.txt`), "BRIEF ONE\n1. [HIGH] Headline (https://example.com/one)\n");
      sh("add", "."); sh("commit", "-q", "-m", "Add brief");
      fs.writeFileSync(path.join(repo, "tool.py"), "print(1)\n");
      sh("add", "."); sh("commit", "-q", "-m", "Add tool");
      fs.writeFileSync(path.join(repo, `brief-${day(40)}.txt`), "OLD BRIEF\n");
      sh("add", "."); sh("commit", "-q", "-m", "Add old brief");
      const news = await createProject({ name: "News", archetype: "news", sourcePath: repo });
      try {
        await saveProject(news.id, { ...news.settings, sources: news.settings.sources.map((x) => ({ ...x, feedGlobs: ["brief-*.txt"] })) });
        await inContext({ projectId: news.id }, async () => {
          const { syncFeeds, feedContext } = await import("../server/ingress/feeds.js");
          const { collectCommitsBetween } = await import("../server/discovery.js");
          const { runFeedProposals, feedInfo } = await import("../server/pipeline.js");
          const { feedPrompt } = await import("../server/prompts.js");
          assert.deepEqual((await collectCommitsBetween(day(60), day(-1))).map((c) => c.subject), ["Add tool"], "commits of feed files only aren't work");
          assert.equal((await syncFeeds({ from: day(30) })).records, 1, "an entry dated before the range stays out");
          assert.equal((await syncFeeds({ from: day(30) })).records, 0, "an unchanged file isn't read again");
          assert.deepEqual(await feedInfo(), { feeds: true, waiting: 1 });
          assert.match(feedPrompt("evidence.json", day(1), []), /You help an author turn their daily news brief/);
          let calls = 0;
          const write = (async () => { calls++; return { output: { suggestions: [{ title: "Headline", duplicateOf: "", hook: "h", summary: "s", whyItMatters: "w", kind: "news", appeal: 5, recommendedFormat: "short", workDate: day(1), commits: ["bogus"], files: [], notes: [], materials: [], suggestedShots: [] }] } }; }) as never;
          await runFeedProposals(() => {}, undefined, write);
          await runFeedProposals(() => {}, undefined, write);
          assert.equal(calls, 1, "an entry is proposed from once");
          const [topic] = (await store.listSuggestions(news.id)).filter((x) => x.title === "Headline");
          assert.equal(topic.kind, "news");
          assert.equal(topic.workDate, day(1));
          assert.deepEqual(topic.sources, { commits: [], files: [], notes: [], feeds: [`feed:${news.settings.sources[0].id}:brief-${day(1)}.txt`] });
          assert.match(await feedContext(news.id, [topic]), /BRIEF ONE/);
          assert.equal(await feedContext(news.id, [{ sources: { commits: [], files: [], notes: [] } }]), "");
        });
      } finally {
        await deleteProject(news.id, false);
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
    {
      const { execFileSync } = await import("node:child_process");
      const os = await import("node:os");
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-media-"));
      const repo = (name: string) => {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        const sh = (args: string[], env: Record<string, string> = {}) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env }, windowsHide: true }).toString().trim();
        sh(["init", "-q"]); sh(["config", "user.email", "test@example.com"]); sh(["config", "user.name", "Test"]);
        const commit = (message: string, date = "2026-11-01T12:00:00+00:00") => { sh(["add", "-A"]); sh(["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }); return sh(["rev-parse", "HEAD"]); };
        const write = (file: string, body: string | object) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), typeof body === "string" ? body : JSON.stringify(body)); };
        return { dir, commit, write, remove: (file: string) => fs.rmSync(path.join(dir, file)) };
      };
      const game = repo("game");
      game.write("src/main.txt", "v1");
      const build = game.commit("Build 0.3", "2026-03-05T10:00:00+00:00").slice(0, 7);
      const media = repo("media");
      media.write("releases/0.3/forest.png", "forest pixels");
      media.write("releases/0.3/lake.png", "lake pixels");
      media.write("releases/0.3/twin.png", "lake pixels");
      media.write("releases/0.3/drafts/sketch.png", "sketch pixels");
      media.write("releases/0.3/old.png", "old pixels");
      media.write("releases/0.3/materials.json", { folder: { commit: build, tags: ["release"] }, files: { "forest.png": { title: "Forest at dawn", annotation: "New light." }, "old.png": { exclude: true } } });
      media.write("releases/0.2/hut.png", "hut pixels");
      media.write("releases/broken/a.png", "a pixels");
      media.write("releases/broken/materials.json", "{");
      media.write("scratch/test.png", "test pixels");
      media.write("releases/0.3/large.png", "version https://git-lfs.github.com/spec/v1\noid sha256:0123\nsize 99999\n");
      media.commit("Add sets");
      const project = await createProject({ name: "Media", archetype: "game", sourcePath: game.dir });
      const removed: string[] = [];
      try {
        const rules = [{ id: "rule-1", include: ["releases/**"], exclude: ["**/drafts/**"], pattern: "releases/{release}/{name}.{ext}" }];
        await saveProject(project.id, { ...project.settings, sources: [...project.settings.sources, { id: "media", label: "Media", path: media.dir, contentGlobs: [], materialRules: rules }] });
        await inContext({ projectId: project.id }, async () => {
          const { importSourceMaterials } = await import("../server/sourceMaterials.js");
          const { removeMaterial } = await import("../server/materials.js");
          type Io = import("../server/sourceMaterials.js").ImportIO;
          const ingest: Io["ingest"] = async (file, fileName, fields, options) => {
            const id = options.id ?? store.newId("mat");
            const folder = `materials/${id}/${options.version}/`;
            const m = { id, createdAt: options.createdAt ?? new Date().toISOString(), date: fields.date!, kind: "image" as const, fileName, contentType: "image/png", size: fs.statSync(file).size, key: `${folder}${fileName}`, thumbKey: `${folder}thumb.jpg`, previewKey: `${folder}preview.jpg`, title: fields.title!, annotation: fields.annotation ?? "", tags: fields.tags ?? [], group: fields.group, origin: fields.origin };
            if (options.save !== false) await store.saveMaterial(project.id, m);
            return m;
          };
          const io: Io = { ingest, removeFiles: async (prefix) => { removed.push(prefix); } };
          const byPath = async () => new Map((await store.listMaterials(project.id)).map((m) => [m.origin?.path, m]));

          const [first, parallel] = await Promise.all([importSourceMaterials(() => {}, io), importSourceMaterials(() => {}, io)]);
          assert.deepEqual([first.added, first.skipped], [3, 1], "forest, lake and hut; old.png is excluded, sketch.png is a draft, a.png's folder is invalid, and twin.png has the content of lake.png, which comes first");
          assert.equal(parallel.added, 0, "a second import waits for the first, so nothing is stored twice");
          assert.equal(first.errors.length, 2);
          assert.match(first.errors[0], /releases\/broken\/materials\.json not valid JSON/);
          assert.match(first.errors[1], /1 matched file is a Git LFS pointer, such as releases\/0\.3\/large\.png/);
          let materials = await byPath();
          assert.deepEqual([...materials.keys()].sort(), ["releases/0.2/hut.png", "releases/0.3/forest.png", "releases/0.3/lake.png"]);
          const forest = materials.get("releases/0.3/forest.png")!;
          const hutBefore = materials.get("releases/0.2/hut.png")!;
          const lakeBefore = materials.get("releases/0.3/lake.png")!;
          assert.deepEqual([forest.title, forest.annotation, forest.tags, forest.date], ["Forest at dawn", "New light.", ["0.3", "release"], "2026-03-05"], "the build commit in the game source dates the folder");
          assert.equal(materials.get("releases/0.2/hut.png")!.date, "2026-11-01", "without metadata, the first commit dates the file");
          assert.equal(materials.get("releases/0.3/lake.png")!.title, "lake");

          const lines: string[] = [];
          assert.deepEqual(await importSourceMaterials((l) => lines.push(l), io), { added: 0, updated: 0, moved: 0, removed: 0, skipped: 1, inbox: 0, errors: first.errors }, "unchanged files aren't stored again");
          assert.ok(lines.some((l) => /Media: no new commits or rule changes/.test(l)), "an unchanged source isn't scanned again");

          await store.saveMaterial(project.id, (await import("../server/sourceMaterials.js")).withEdits(forest, { ...forest, title: "My title" }));
          media.write("releases/0.3/materials.json", { folder: { commit: build, tags: ["release"] }, files: { "forest.png": { title: "Forest at night", annotation: "Night light." }, "old.png": { exclude: true } } });
          media.write("releases/0.2/hut.png", "new hut pixels");
          media.remove("releases/0.3/lake.png");
          media.commit("Update sets");
          lines.length = 0;
          const second = await importSourceMaterials((l) => lines.push(l), io);
          assert.ok(!lines.some((l) => /no new commits/.test(l)), "a new commit scans the source again");
          assert.deepEqual([second.added, second.updated, second.moved, second.removed, second.skipped], [0, 2, 1, 0, 0], "forest and hut change; lake.png is gone and twin.png has its content, so lake's material moves there");
          materials = await byPath();
          const after = materials.get("releases/0.3/forest.png")!;
          assert.deepEqual([after.title, after.annotation], ["My title", "Night light."], "an edited title stays, the annotation follows the metadata");
          const hut = materials.get("releases/0.2/hut.png")!;
          assert.equal(hut.id, hutBefore.id, "a changed file keeps its material");
          assert.equal(hut.key, `materials/${hut.id}/${hut.origin!.blob.slice(0, 12)}/hut.png`, "and is stored under its new blob");
          assert.deepEqual(removed, [`materials/${hut.id}/${hutBefore.origin!.blob.slice(0, 12)}/`], "the old version's files are removed");
          assert.equal(materials.get("releases/0.3/twin.png")!.id, lakeBefore.id);

          await removeMaterial(hut.id, async () => {});
          assert.equal((await importSourceMaterials(() => {}, io)).added, 0, "a deleted material isn't imported again");

          media.write("releases/0.3/twin.png", "new twin pixels");
          media.commit("Change twin");
          removed.length = 0;
          const deleting: Io = { ...io, ingest: async (file, fileName, fields, options) => { await removeMaterial(lakeBefore.id, async () => {}); return ingest(file, fileName, fields, options); } };
          assert.equal((await importSourceMaterials(() => {}, deleting)).updated, 0, "a material deleted while its new version is stored stays deleted");
          assert.equal((await byPath()).has("releases/0.3/twin.png"), false);
          assert.deepEqual(removed, [`materials/${lakeBefore.id}/${execFileSync("git", ["rev-parse", "HEAD:releases/0.3/twin.png"], { cwd: media.dir }).toString().trim().slice(0, 12)}/`], "and the new version's files are removed");

          fs.mkdirSync(path.join(media.dir, "releases/0.4"));
          fs.renameSync(path.join(media.dir, "releases/0.3/forest.png"), path.join(media.dir, "releases/0.4/forest.png"));
          media.commit("Move forest");
          const move = await importSourceMaterials(() => {}, io);
          assert.deepEqual([move.moved, move.added, move.removed], [1, 0, 0], "a moved file keeps its material");
          const movedForest = (await byPath()).get("releases/0.4/forest.png")!;
          assert.deepEqual([movedForest.id, movedForest.title, movedForest.tags], [forest.id, "My title", ["0.4"]], "the new path's values apply, and edits stay");

          media.write("releases/0.4/materials.json", "{");
          media.commit("Break metadata");
          const broken = await importSourceMaterials(() => {}, io);
          assert.equal(broken.removed, 0, "an invalid metadata file leaves its folder's materials as they are");
          assert.equal((await byPath()).get("releases/0.4/forest.png")!.origin!.removed, undefined);

          const current = getProject(project.id).settings;
          await saveProject(project.id, { ...current, sources: current.sources.map((x) => (x.id === "media" ? { ...x, materialRules: [] } : x)) });
          assert.equal(getProject(project.id).settings.sources.find((x) => x.id === "media")!.materialRules, undefined, "an empty rule list is removed");
          assert.equal((await importSourceMaterials(() => {}, io)).removed, 1, "without rules, the source's materials no longer match a rule");
          assert.equal((await byPath()).get("releases/0.4/forest.png")!.origin!.removed, true, "a material that no longer matches a rule stays");
          await assert.rejects(saveProject(project.id, { ...current, sources: current.sources.map((x) => (x.id === "media" ? { ...x, materialRules: [{ id: "r", include: ["a"] }, { id: "r", include: ["b"] }] } : x)) }), /unique IDs/);
          const { addInboxFiles, inboxFileId, listInboxFiles, setInboxFileStatus } = await import("../server/sourceMaterials.js");
          for (const name of ["a", "b", "c"]) media.write(`inbox/${name}.png`, `${name} pixels`);
          media.commit("Add inbox files");
          const settings = getProject(project.id).settings;
          await saveProject(project.id, { ...settings, sources: settings.sources.map((x) => (x.id === "media" ? { ...x, materialRules: [{ id: "rule-2", include: ["inbox/**"], importTo: "inbox" as const }, ...rules] } : x)) });
          const toInbox = await importSourceMaterials(() => {}, io);
          assert.deepEqual([toInbox.inbox, toInbox.added], [3, 0], "an inbox rule's files wait in the inbox");
          assert.deepEqual((await listInboxFiles(project.id)).map((f) => [f.path, f.status, f.fields.title]), [["inbox/a.png", "inbox", "a"], ["inbox/b.png", "inbox", "b"], ["inbox/c.png", "inbox", "c"]]);
          const xmin = async () => (await query<{ xmin: string }>("SELECT xmin::text FROM source_files WHERE project_id = $1 ORDER BY id", [project.id])).map((r) => r.xmin).join();
          const before = await xmin();
          assert.equal((await importSourceMaterials(() => {}, io)).inbox, 0, "unchanged inbox files stay as they are");
          assert.equal(await xmin(), before, "and their rows aren't written again");
          const id = (name: string) => inboxFileId("media", `inbox/${name}.png`);
          await setInboxFileStatus(id("b"), "dismissed");
          const [added] = await addInboxFiles([id("a")], { title: "Mine" }, () => {}, io);
          assert.deepEqual([added.title, added.origin?.path, added.origin?.edited], ["Mine", "inbox/a.png", ["title"]], "a title given when adding counts as an edit");
          media.remove("inbox/c.png");
          media.commit("Remove c");
          const later = await importSourceMaterials(() => {}, io);
          assert.deepEqual([later.added, later.updated, later.inbox], [0, 0, 0], "an added file is a material, and a dismissed file stays dismissed");
          assert.deepEqual((await listInboxFiles(project.id)).map((f) => [f.path, f.status]), [["inbox/b.png", "dismissed"]], "a file that left the source leaves the inbox");
          assert.equal((await byPath()).get("inbox/a.png")!.title, "Mine");
          await assert.rejects(addInboxFiles([id("c")], {}, () => {}, io), /no longer in the inbox/);

          const { previewRules } = await import("../server/sourceMaterials.js");
          media.write("inbox/d.png", "d pixels");
          media.commit("Add d");
          const preview = await previewRules("media", [{ id: "rule-2", include: ["inbox/**"], importTo: "inbox" }, ...rules, { id: "rule-3", include: ["nothing/**"] }]);
          assert.deepEqual(Object.fromEntries(preview.files.map((f) => [f.path, f.state])), {
            "inbox/a.png": "material", "inbox/b.png": "dismissed", "inbox/d.png": "new-inbox", "releases/0.2/hut.png": "deleted", "releases/0.3/twin.png": "deleted",
          }, "forest.png's folder has an invalid metadata file, so the preview leaves it out too");
          assert.deepEqual(preview.matchesPerRule, { "rule-2": 3, "rule-1": 2, "rule-3": 0 });
          assert.equal(preview.errors.length, 3, "the invalid metadata files and the Git LFS pointer are reported");
          assert.equal((await listInboxFiles(project.id)).length, 1, "a preview changes nothing");
          media.remove("inbox/d.png");
          media.commit("Remove d");
          await assert.rejects(previewRules("unsaved", rules), /Save the source first/);
          const { inboxFilePath } = await import("../server/sourceMaterials.js");
          assert.equal(fs.readFileSync((await inboxFilePath(id("b"))).file, "utf8"), "b pixels", "the inbox shows the committed file");
          const withRules = getProject(project.id).settings;
          const inboxOnly = (include: string[]) => ({ ...withRules, sources: withRules.sources.map((x) => (x.id === "media" ? { ...x, materialRules: [{ id: "rule-2", include, importTo: "inbox" as const }] } : x)) });
          await saveProject(project.id, inboxOnly(["nothing/**"]));
          await importSourceMaterials(() => {}, io);
          assert.deepEqual((await listInboxFiles(project.id)).map((f) => [f.path, f.status]), [["inbox/b.png", "dismissed"]], "a dismissed file that no longer matches stays dismissed while it is in the source");
          await saveProject(project.id, inboxOnly(["inbox/**", "moved/**"]));
          fs.mkdirSync(path.join(media.dir, "moved"));
          fs.renameSync(path.join(media.dir, "inbox/b.png"), path.join(media.dir, "moved/b.png"));
          media.commit("Move b");
          assert.equal((await importSourceMaterials(() => {}, io)).moved, 1);
          assert.deepEqual((await listInboxFiles(project.id)).map((f) => [f.path, f.status]), [["moved/b.png", "dismissed"]], "a moved inbox file stays dismissed");
          await saveProject(project.id, { ...getProject(project.id).settings, sources: getProject(project.id).settings.sources.map((x) => (x.id === "media" ? { ...x, archived: true } : x)) });
          assert.deepEqual(await listInboxFiles(project.id), [], "an archived source's files leave the inbox list");
        });
      } finally {
        await deleteProject(project.id, false);
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    const webapp = await createProject({ name: "Neutral wording", archetype: "webapp", sourcePath: process.cwd() });
    assert.deepEqual(webapp.settings.sources[0].contentGlobs, []);
    const { discoveryPrompt, questionsPrompt, scriptPrompt } = await import("../server/prompts.js");
    const prompts = () => inContext({ projectId: webapp.id }, () => {
      const post = { outputs: ["landscape"], brief: "", questions: [] } as unknown as import("../shared/types.js").Post;
      return [discoveryPrompt("evidence.json", []), questionsPrompt(post, [], []), scriptPrompt(post, [], "portrait", [], []), scriptPrompt(post, [], "landscape", [], [])].join("\n");
    });
    assert.doesNotMatch(prompts(), /\b(games?|gameplay|players?|play mode|indie)\b/i);
    assert.match(prompts(), /what people can now do/);
    await saveProject(webapp.id, { ...getProject(webapp.id).settings, promptGuidance: "Write for accountants." });
    assert.match(prompts(), /Write for accountants\./);
    assert.doesNotMatch(prompts(), /what people can now do/);
    const { promptGuidance: _custom, ...restored } = getProject(webapp.id).settings;
    await saveProject(webapp.id, restored);
    assert.match(prompts(), /what people can now do/);
    await assert.rejects(saveProject(webapp.id, { ...restored, archetype: "toaster" as never }), /project type/);
    await assert.rejects(createProject({ name: "Unknown type", archetype: "toaster" as never, sourcePath: process.cwd() }), /project type/);
    await deleteProject(webapp.id, false);
    const { runBackfill, backfilledWeeks } = await import("../server/pipeline.js");
    const { collectCommits, commitDetails, commitRef } = await import("../server/discovery.js");
    const latest = (await inContext({ projectId: one.id }, () => collectCommits(["-1"], false)))[0];
    // Backfill asks git for a day in this machine's time zone, so the commit's day must be taken in it too: the author's
    // date can be a day off, for example for a commit made just after midnight in another zone.
    const { localDate } = await import("../server/ingress/provider.js");
    const testDate = localDate(latest.date);
    const missing = "0000000000";
    const [byRef, byHash, unknown, invalid] = await inContext({ projectId: one.id }, () => commitDetails([commitRef(latest), latest.hash.slice(0, 10), `${latest.sourceId}:${missing}`, "not a commit"]));
    assert.equal(byRef.subject, latest.subject);
    assert.equal(byHash.hash, latest.hash, "a bare short hash is found in the project's sources");
    assert.equal(unknown.subject, undefined);
    assert.equal(unknown.hash, missing);
    assert.equal(invalid, undefined);
    const ranges: string[][] = [];
    const fakeWriter = (async (opts: { prompt: string }) => {
      const file = /JSON file: ([^\r\n]+)/.exec(opts.prompt)![1];
      const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
      ranges.push([...new Set(evidence.commits.map((c: { sourceId: string }) => c.sourceId))] as string[]);
      return { agent: "claude", output: { suggestions: [{ title: "Weekly work", duplicateOf: evidence.existingSuggestions[0]?.id ?? "", hook: "", summary: "Work across repositories", whyItMatters: "", kind: "other", appeal: 3, recommendedFormat: "either", workDate: testDate, commits: evidence.commits.slice(0, 2).map(commitRef), files: [], notes: [], materials: [], suggestedShots: [] }] } };
    }) as typeof import("../server/agent.js").runAgent;
    await inContext({ projectId: one.id }, () => runBackfill(testDate, testDate, false, () => {}, undefined, fakeWriter));
    assert.ok((await inContext({ projectId: one.id }, backfilledWeeks)).length);
    const expanded = structuredClone(getProject(one.id).settings);
    expanded.sources.push({ ...expanded.sources[0], id: "source-second", label: "Second repository" });
    await saveProject(one.id, expanded);
    assert.deepEqual(await inContext({ projectId: one.id }, backfilledWeeks), []);
    const evidence = await inContext({ projectId: one.id }, () => collectCommits(["-1"], false));
    assert.equal(evidence.length, 2);
    assert.equal(new Set(evidence.map(commitRef)).size, 2, "identical hashes stay distinct across sources");
    await inContext({ projectId: one.id }, () => runBackfill(testDate, testDate, false, () => {}, undefined, fakeWriter));
    assert.deepEqual(ranges.at(-1), ["source-second"]);
    assert.equal((await store.listSuggestions(one.id)).length, 1, "the new source enriches the original topic");
    assert.equal(new Set((await store.listSuggestions(one.id))[0].sources.commits.map((ref) => ref.split(":")[0])).size, 2);
    const note = { id: "note-owned", date: "2026-11-03", text: "test", createdAt: new Date().toISOString() };
    await store.insertNote(one.id, note);
    assert.equal((await store.listNotes(one.id)).length, 1);
    assert.equal((await store.listNotes(two.id)).length, 0);
    await assert.rejects(store.deleteNote(two.id, note.id), /not found/);
    assert.equal((await store.listNotes(one.id)).length, 1);
    const post = { id: "post-owned", outputDirs: [], title: "Weekly update", createdAt: note.createdAt, suggestionIds: [], materialIds: [], outputs: ["portrait" as const], outputStages: {}, brief: "", questions: [], scripts: {}, narration: {}, renders: {}, stage: "questions" as const };
    await store.savePost(one.id, post);
    await assert.rejects(store.loadPost(two.id, post.id), /not found/);
    await assert.rejects(store.updatePost(two.id, post.id, (p) => { p.title = "wrong"; }), /not found/);
    await assert.rejects(store.savePost(two.id, { ...post, title: "wrong" }), /not found/);
    await assert.rejects(store.savePost(two.id, { ...post, id: "foreign-material", materialIds: ["material-other"] }), /not found/);
    await (await import("./support/review-regressions.js")).runReviewRegressions(t, one, two, noStorage);
    await (await import("./support/cohost-regressions.js")).runCoHostRegressions(t, deleteProject);
    await (await import("./support/connector-regressions.js")).runConnectorRegressions(t, deleteProject);
    const archived = structuredClone(getProject(one.id).settings);
    archived.sources.push({ id: "source-history", label: "History", path: process.cwd(), contentGlobs: [], archived: true });
    await saveProject(one.id, archived);
    const suggestion = { id: "suggestion-history", createdAt: note.createdAt, workDate: note.date, title: "History", hook: "", summary: "", whyItMatters: "", kind: "other" as const, appeal: 3, recommendedFormat: "either" as const, sources: { commits: ["source-history:abcdef0"], files: [], notes: [] }, materialIds: [], suggestedShots: [], highlights: "", status: "proposed" as const };
    await store.insertSuggestion(one.id, suggestion);
    await store.updateSuggestions(one.id, [suggestion.id], (items) => { items[0].title = "Edited archived source"; });
    await assert.rejects(store.getSuggestions(two.id, [suggestion.id]), /not found/);
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const job = await inContext({ projectId: one.id }, () => startJob("test", "project", () => running));
    await assert.rejects(deleteProject(one.id, false), /running project jobs/);
    release(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(job.status, "done");
    // A durable deleting mark blocks writes and job registration after a restart.
    await query("UPDATE projects SET data = data || $2::jsonb WHERE id = $1", [one.id, JSON.stringify({ deletion: { files: false, garageKeys: [], folders: [] } })]);
    await loadProjects();
    await assert.rejects(store.insertNote(one.id, { ...note, id: "late" }), /being deleted/);
    await assert.rejects(inContext({ projectId: one.id }, () => startJob("late", "project", async () => {})), /being deleted/);
    await deleteProject(one.id, false);
    await deleteProject(two.id, false);
    await migrate(); await loadProjects();
    assert.equal(listProjects().length, 0, "deleting the last project does not reseed it");
    const a = await createProject({ name: "Cleanup A", sourcePath: process.cwd() });
    const b = await createProject({ name: "Cleanup B", sourcePath: process.cwd() });
    const sharedTake = { segmentId: "s1", file: "tts/shared.mp3", hash: "shared", durationMs: 1000, words: [] };
    const folder = path.join((await import("../server/config.js")).OUTPUT_DIR, "devlog-test-cleanup");
    await store.savePost(a.id, { ...post, id: "cleanup-a", outputDirs: [folder], narration: { portrait: [sharedTake] }, renders: {} });
    await (await import("../server/egress/youtube.js")).setUpload(a.id, "cleanup-a", "portrait", { videoId: "test-cleanup-video", status: "uploaded" });
    await query("INSERT INTO video_stats VALUES ('test-cleanup-video', now(), 10, 1, 0)");
    await store.savePost(b.id, { ...post, id: "cleanup-b", narration: { portrait: [sharedTake] } });
    const deleted: string[] = [];
    const removed: string[] = [];
    let fail = true;
    const io = { listKeys: async (prefix: string) => prefix === "episodes/cleanup-a/" ? ["episodes/cleanup-a/final/video.mp4"] : [], deleteKey: async (key: string) => { if (fail) { fail = false; throw new Error("simulated storage outage"); } deleted.push(key); }, removeFolder: (dir: string) => { removed.push(dir); } };
    await assert.rejects(deleteProject(a.id, true, io), /storage outage/);
    assert.equal((await store.listPosts(a.id)).length, 0);
    assert.equal((await query("SELECT 1 FROM video_stats WHERE video_id = 'test-cleanup-video'")).length, 0);
    await loadProjects();
    assert.ok(getProject(a.id).deletion?.garageKeys.length, "manifest survives deleted posts and reload");
    await deleteProject(a.id, true, io);
    assert.deepEqual(deleted, ["episodes/cleanup-a/final/video.mp4"]);
    assert.deepEqual(removed, [folder]);
    assert.ok(!deleted.includes("tts/shared.mp3") && !deleted.includes("tts/shared.json"));
    await deleteProject(b.id, false, io);
  } finally {
    await db().end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end(); process.env.DATABASE_URL = original;
  }
});
