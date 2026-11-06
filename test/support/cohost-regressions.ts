import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Format, Material, Post, Script, Segment } from "../../shared/types.js";
import { inContext } from "../../server/context.js";
import * as store from "../../server/store.js";
import { createProject, deleteConnection, getProject, saveConnection, saveProject } from "../../server/projects.js";
import { approveRender, checkCoHostLines, createPost, setPresentation, uploadToYouTube, writeScript } from "../../server/pipeline.js";
import type { runAgent } from "../../server/agent.js";
import { assertCoHostVerified, evidenceSnapshot, setFlagAccepted, verificationState } from "../../server/verification.js";
import { projectVoices, takeHash } from "../../server/takes.js";
import { buildTimeline, toSrt } from "../../server/timeline.js";
import { soloPost } from "./solo-timeline-fixture.js";
import { newCoHost } from "../../shared/cohost.js";
import { getUpload, setUpload } from "../../server/egress/youtube.js";

const COLOR = "#ffcc00";
const emptyPost = (id: string): Post => ({ id, title: "Co-host", createdAt: "2026-11-04T00:00:00.000Z", suggestionIds: [], materialIds: [], outputs: ["portrait", "landscape"], outputDirs: [], outputStages: {}, brief: "", questions: [], scripts: {}, narration: {}, renders: {}, stage: "questions" });
const slide = (id: string, turns: Segment["turns"]): Segment => ({ id, narration: "", turns, visual: { type: "slide", layout: "title", heading: id } });
const dialogue = (format: Format): Script => ({
  format, title: "Co-host", metadata: { title: "Co-host", description: "", tags: [] },
  segments: [
    slide("s1", [{ id: "t1", speaker: "coHost", text: "Drafts?" }, { id: "t2", speaker: "developer", text: "Drafts. For now." }, { id: "t3", speaker: "developer", text: "Only a day." }]),
    slide("s2", [{ id: "t4", speaker: "coHost", text: "Bold." }]),
  ],
});

export async function runCoHostRegressions(t: TestContext, remove: (id: string, files: boolean) => Promise<unknown>) {
  const pid = (await createProject({ name: "Co-host test", sourcePath: process.cwd() })).id;
  const named = getProject(pid).settings;
  await saveProject(pid, { ...named, narration: { ...named.narration, voiceId: "narrator-voice" } });
  const inProject = <T>(work: () => T) => inContext({ projectId: pid }, work);
  const setPresentationFor = (id: string) => setPresentation(id, "portrait", "coHost", false);

  await t.test("a solo timeline stays identical", async () => {
    const expected = JSON.parse(fs.readFileSync("test/fixtures/solo-timeline.json", "utf8"));
    for (const format of ["portrait", "landscape"] as const) for (const narrated of [true, false]) {
      const timeline = await inProject(() => buildTimeline(soloPost(), format, narrated));
      const actual = JSON.parse(JSON.stringify({ durationInFrames: timeline.durationInFrames, segments: timeline.segments, captions: timeline.captions }));
      assert.deepEqual(actual, expected[`${format}-${narrated ? "narrated" : "estimated"}`]);
    }
  });

  await t.test("project settings refuse an unusable co-host", async () => {
    const settings = getProject(pid).settings;
    const coHost = { ...newCoHost(), name: "Robin", voiceId: "cohost-voice", captionColor: COLOR };
    await assert.rejects(saveProject(pid, { ...settings, coHost: { ...coHost, voiceId: settings.narration.voiceId } }), /different voice/);
    await assert.rejects(saveProject(pid, { ...settings, coHost: { ...coHost, voiceId: " " } }), /voice ID/);
    await assert.rejects(saveProject(pid, { ...settings, coHost: { ...coHost, captionColor: "yellow" } }), /#rrggbb/);
    await assert.rejects(saveProject(pid, { ...settings, coHost: { ...coHost, name: "" } }), /name/);
    await assert.rejects(inProject(() => setPresentationFor("ep-none")), /Turn on the co-host/);
    await saveProject(pid, { ...settings, coHost });
  });

  await t.test("a co-hosted timeline lays out turns with voices, gaps and colored captions", async () => {
    await store.savePost(pid, emptyPost("ep-layout"));
    await inProject(() => setPresentationFor("ep-layout"));
    await assert.rejects(store.saveScript(pid, "ep-layout", "landscape", dialogue("landscape")), /solo/, "turns need a co-hosted format");
    const repeated = dialogue("portrait");
    repeated.segments[1].turns![0].id = "t1";
    await assert.rejects(store.saveScript(pid, "ep-layout", "portrait", repeated), /own ID/);
    await store.saveScript(pid, "ep-layout", "portrait", dialogue("portrait"));

    const turns = dialogue("portrait").segments.flatMap((s) => s.turns!.map((turn) => ({ turn, segmentId: s.id })));
    const voices = inProject(() => projectVoices());
    await store.updatePost(pid, "ep-layout", (p) => {
      p.narration.portrait = turns.map(({ turn, segmentId }, i) => ({ segmentId, turnId: turn.id, speaker: turn.speaker, file: `tts/${turn.id}.mp3`, durationMs: 1000, generatedAt: i, hash: takeHash(voices(turn.speaker)!, turn.text), words: [{ text: turn.text, startMs: 0, endMs: 900 }] }));
    });
    const post = await store.loadPost(pid, "ep-layout");
    const timeline = await inProject(() => buildTimeline(post, "portrait", true));
    // 30 fps: 1000 ms, a 300 ms gap for the new speaker, 1000 ms, a 150 ms gap for the same speaker.
    assert.deepEqual(timeline.segments[0].audio!.map((c) => c.startFrame), [0, 39, 74]);
    assert.deepEqual(timeline.segments[1].audio!.map((c) => c.startFrame), [0]);
    assert.deepEqual(timeline.captions.map((c) => [c.text, c.color, c.speakerChange]), [
      ["Drafts?", COLOR, undefined],
      ["Drafts. For now.", undefined, true],
      ["Only a day.", undefined, undefined],
      ["Bold.", COLOR, true],
    ]);
    assert.deepEqual(timeline.captions.slice(0, 3).map((c) => c.startMs - timeline.captions[0].startMs), [0, 1300, 2450]);
    assert.match(toSrt(timeline.captions), /\n>> Bold\.\n/);

    const laughing = structuredClone(post);
    laughing.narration.portrait![1].words = [{ text: "[laughs]", startMs: 0, endMs: 900 }];
    const expressions = await inProject(() => buildTimeline(laughing, "portrait", true));
    assert.deepEqual(expressions.captions.map((c) => [c.text, c.speakerChange]), [["Drafts?", undefined], ["Only a day.", true], ["Bold.", true]], "a line that is only an expression has no caption and still plays");
    assert.deepEqual(expressions.segments[0].audio!.map((c) => c.startFrame), [0, 39, 74]);

    const estimated = await inProject(() => buildTimeline(post, "portrait", false));
    assert.equal(estimated.segments[0].audio, undefined, "an unnarrated preview has no audio");
    assert.equal(estimated.captions[0].color, COLOR);
  });

  await t.test("saving a script keeps the takes of unchanged turns", async () => {
    const edited = structuredClone((await store.loadPost(pid, "ep-layout")).scripts.portrait!);
    edited.segments[0].turns![1].text = "Drafts. Temporarily.";
    edited.segments[1].turns!.unshift(edited.segments[0].turns!.pop()!);
    const saved = await store.saveScript(pid, "ep-layout", "portrait", edited);
    assert.deepEqual(saved.narration.portrait!.map((take) => [take.turnId, take.segmentId]), [["t1", "s1"], ["t3", "s2"], ["t4", "s2"]]);
    await assert.rejects(inProject(() => buildTimeline(saved, "portrait", true)), /Narration missing for 1 line/);
  });

  await t.test("changing a voice setting invalidates only that speaker's takes in the timeline", async () => {
    const settings = getProject(pid).settings;
    await saveProject(pid, { ...settings, coHost: { ...settings.coHost!, voice: { stability: 0.1 } } });
    const saved = await store.loadPost(pid, "ep-layout");
    await assert.rejects(inProject(() => buildTimeline(saved, "portrait", true)), /Narration missing for 3 line/, "two co-host turns and the edited developer turn");
    await saveProject(pid, settings);
  });

  await t.test("changing one format's presentation clears only that format", async () => {
    const post = emptyPost("ep-formats");
    const solo = (format: Format): Script => ({ format, title: "Solo", metadata: { title: "", description: "", tags: [] }, segments: [{ id: "s", narration: "Hi", visual: { type: "slide", layout: "title", heading: "" } }] });
    post.scripts = { portrait: solo("portrait"), landscape: solo("landscape") };
    post.narration = { portrait: [], landscape: [] };
    post.renders = { portrait: { draft: "a" }, landscape: { draft: "b" } };
    post.outputStages = { portrait: "final", landscape: "final" };
    post.stage = "final";
    post.questions = [{ id: "q", question: "Why?", answer: "Because." } as Post["questions"][number]];
    await store.savePost(pid, post);

    await assert.rejects(inProject(() => setPresentationFor("ep-formats")), /Confirm first/);
    const changed = await inProject(() => setPresentation("ep-formats", "portrait", "coHost", true));
    assert.equal(changed.presentation!.portrait, "coHost");
    assert.equal(changed.scripts.portrait, undefined);
    assert.equal(changed.narration.portrait, undefined);
    assert.equal(changed.renders.portrait, undefined);
    assert.equal(changed.outputStages.portrait, "questions");
    assert.equal(changed.stage, "questions");
    assert.ok(changed.scripts.landscape && changed.narration.landscape && changed.renders.landscape);
    assert.equal(changed.outputStages.landscape, "final");
    assert.equal(changed.questions.length, 1);

    await setUpload(pid, "ep-formats", "landscape", { connectionId: "c", status: "uploaded", videoId: "v" });
    await assert.rejects(inProject(() => setPresentation("ep-formats", "landscape", "coHost", true)), /on YouTube/);
  });
  const materialOf = (id: string, annotation = "Original annotation") => ({ id, title: id, createdAt: "2026-11-04T00:00:00.000Z", date: "2026-11-03", kind: "image", fileName: "a.png", contentType: "image/png", size: 1, key: `materials/${id}.png`, thumbKey: `materials/${id}-t.png`, previewKey: `materials/${id}-p.png`, annotation, tags: [] }) as unknown as Material;
  const state = async (id: string, format: Format = "portrait") => {
    const post = await store.loadPost(pid, id);
    return verificationState(post.scripts[format]!, post, await evidenceSnapshot(pid, post));
  };
  /** A mocked agent run by schema: first draft, read-through, check and rewrite. */
  const mockAgent = (flagged: () => boolean, prompts: string[] = []) => (async (opts: { prompt: string; schema: object }) => {
    prompts.push(opts.prompt);
    const fields = (opts.schema as { properties: Record<string, unknown> }).properties;
    if ("claims" in fields) return { agent: "claude", output: { claims: flagged() ? [{ turnId: /\[([^\]]+)\] coHost/.exec(opts.prompt)![1], claim: "It took a week", source: "none", supported: false, reason: "No source says so" }] : [] } };
    if ("edits" in fields) {
      if (opts.prompt.includes("Unsupported claims")) return { agent: "claude", output: { edits: [{ segment: 0, turn: 0, text: "Rewritten question?", reason: "unsupported" }] } };
      return { agent: "claude", output: { edits: [{ segment: 0, turn: 1, text: "Reviewed answer.", reason: "adds energy" }] } };
    }
    return { agent: "claude", output: { title: "Dialogue", metadata: { title: "T", description: "D", tags: [] }, segments: [{ onScreen: "", visual: { type: "slide", description: "", layout: "title", heading: "H", bullets: [], imageFrom: [], entrance: "drop" }, turns: [{ speaker: "coHost", text: "Took a week?" }, { speaker: "developer", text: "Draft answer." }] }] } };
  }) as unknown as typeof runAgent;

  await t.test("a new post starts co-hosted only when the project says so", async () => {
    const settings = getProject(pid).settings;
    await saveProject(pid, { ...settings, coHost: { ...settings.coHost!, defaultOn: true } });
    await inProject(async () => {
      await store.insertSuggestion(pid, { id: "sug-cohost", title: "Topic", summary: "Summary", whyItMatters: "", highlights: "", workDate: "2026-11-03", sources: { commits: [], files: [], notes: [] }, suggestedShots: [], materialIds: [], createdAt: "2026-11-04T00:00:00.000Z", status: "approved" } as never);
      const on = await createPost(["sug-cohost"], ["portrait"], "On");
      assert.equal(on.presentation?.portrait, "coHost");
      await saveProject(pid, { ...settings, coHost: { ...settings.coHost!, defaultOn: true, enabled: false } });
      const off = await createPost(["sug-cohost"], ["portrait"], "Off");
      assert.equal(off.presentation, undefined, "a co-host that is turned off starts no new videos");
    });
    await saveProject(pid, settings);
  });

  await t.test("the writer produces turns, reviews them and rewrites unsupported lines once", async () => {
    await store.savePost(pid, emptyPost("ep-write"));
    await inProject(() => setPresentationFor("ep-write"));
    const prompts: string[] = [];
    let checks = 0;
    await inProject(() => writeScript("ep-write", "portrait", () => {}, "claude", mockAgent(() => ++checks === 1, prompts)));
    assert.match(prompts[0], /You are Robin, the developer's AI co-host/);
    assert.match(prompts[0], /about 25% of the spoken words/);
    const post = await store.loadPost(pid, "ep-write");
    const turns = post.scripts.portrait!.segments[0].turns!;
    assert.deepEqual(turns.map((x) => [x.speaker, x.text, x.agentText]), [["coHost", "Rewritten question?", "Rewritten question?"], ["developer", "Reviewed answer.", "Reviewed answer."]]);
    assert.equal(post.scripts.portrait!.segments[0].narration, "");
    assert.equal(checks, 2, "the rewrite is checked again");
    assert.equal(await state("ep-write"), "current");
    assert.equal(post.outputStages.portrait, "script");
  });

  await t.test("a failed check leaves a new script unverified", async () => {
    await store.savePost(pid, emptyPost("ep-failed"));
    await inProject(() => setPresentationFor("ep-failed"));
    const failing = (async (opts: { prompt: string; schema: object }) => {
      if ("claims" in (opts.schema as { properties: object }).properties) throw new Error("agent failed");
      return mockAgent(() => false)(opts as never);
    }) as unknown as typeof runAgent;
    await inProject(() => writeScript("ep-failed", "portrait", () => {}, "claude", failing));
    assert.equal((await store.loadPost(pid, "ep-failed")).scripts.portrait!.verification, undefined);
    assert.equal(await state("ep-failed"), "outOfDate");
  });

  /** A checked script with one flag on its first co-host line, with a material as evidence. */
  async function flaggedPost(id: string) {
    await store.saveMaterial(pid, materialOf(`mat-${id}`));
    await store.savePost(pid, { ...emptyPost(id), materialIds: [`mat-${id}`], questions: [{ id: "q", question: "How long?", answer: "A day." }] });
    await inProject(() => setPresentationFor(id));
    await store.saveScript(pid, id, "portrait", dialogue("portrait"));
    await inProject(() => checkCoHostLines(id, "portrait", () => {}, "claude", mockAgent(() => true)));
    return (await store.loadPost(pid, id)).scripts.portrait!.verification!.flags[0].key;
  }
  const edit = async (id: string, change: (s: Script) => void) => {
    const next = structuredClone((await store.loadPost(pid, id)).scripts.portrait!);
    change(next);
    return store.saveScript(pid, id, "portrait", next);
  };

  await t.test("verification goes out of date when the script, answers or evidence change", async () => {
    const cases: Array<[string, (id: string) => Promise<unknown>]> = [
      ["a new co-host line", (id) => edit(id, (s) => { s.segments[1].turns!.push({ id: "t-new", speaker: "coHost", text: "It sold a million." }); })],
      ["a developer line swapped to the co-host", (id) => edit(id, (s) => { s.segments[0].turns![1].speaker = "coHost"; })],
      ["a claim moved before its support", (id) => edit(id, (s) => { s.segments[0].turns!.reverse(); })],
      ["a changed answer", (id) => store.updatePost(pid, id, (p) => { p.questions[0].answer = "A week."; })],
      ["a changed annotation", (id) => store.saveMaterial(pid, materialOf(`mat-${id}`, "Changed"))],
      ["a changed file", (id) => store.saveMaterial(pid, { ...materialOf(`mat-${id}`), key: "materials/other.png" })],
      ["a removed material", (id) => store.updatePost(pid, id, (p) => { p.materialIds = []; })],
    ];
    let n = 0;
    for (const [name, change] of cases) {
      const id = `ep-stale-${n++}`;
      await flaggedPost(id);
      assert.equal(await state(id), "flagged", name);
      await change(id);
      assert.equal(await state(id), "outOfDate", name);
    }
    await flaggedPost("ep-stale-unrelated");
    await store.saveMaterial(pid, { ...materialOf("mat-ep-stale-unrelated"), size: 2, fileName: "renamed.png" });
    await edit("ep-stale-unrelated", (s) => { s.metadata.title = "New title"; });
    assert.equal(await state("ep-stale-unrelated"), "flagged", "fields the check doesn't read leave it as it was");
  });

  await t.test("the client can't overwrite a verification", async () => {
    await flaggedPost("ep-client");
    const saved = await edit("ep-client", (s) => { s.verification = { fingerprint: "x", scriptFingerprint: "x", checkedAt: "", flags: [], accepted: [] }; });
    assert.notEqual(saved.scripts.portrait!.verification!.fingerprint, "x");
    assert.equal(saved.scripts.portrait!.verification!.flags.length, 1);
  });

  await t.test("an acceptance holds for one exact flag and its support", async () => {
    await flaggedPost("ep-accept");
    const recheck = (reason = "No source says so", turnId = "t1") => inProject(() => checkCoHostLines("ep-accept", "portrait", () => {}, "claude", (async () => ({ agent: "claude", output: { claims: [{ turnId, claim: "It took a week", source: "none", supported: false, reason }] } })) as unknown as typeof runAgent));
    const accept = async () => inProject(async () => setFlagAccepted("ep-accept", "portrait", (await store.loadPost(pid, "ep-accept")).scripts.portrait!.verification!.flags[0].key, true));
    await assert.rejects(inProject(async () => setFlagAccepted("ep-accept", "portrait", "unknown", true)), /no longer exists/);
    await accept();
    assert.equal(await state("ep-accept"), "current");
    await recheck();
    assert.equal(await state("ep-accept"), "current", "an identical flag keeps its acceptance");
    await edit("ep-accept", (s) => { s.segments[1].turns![0].text = "Very bold."; });
    await assert.rejects(accept(), /again first/, "an out-of-date check takes no decisions");
    await recheck();
    assert.equal(await state("ep-accept"), "current", "a later line isn't this line's support");
    await store.updatePost(pid, "ep-accept", (p) => { p.questions[0].answer = "A week."; });
    await recheck();
    assert.equal(await state("ep-accept"), "flagged", "a changed answer needs a new decision");
    await accept();
    await recheck("Another reason");
    assert.equal(await state("ep-accept"), "flagged", "a different reason needs a new decision");
    await recheck("Another reason", "t4");
    await accept();
    await edit("ep-accept", (s) => { s.segments[0].turns![1].text = "Drafts. Temporarily."; });
    await recheck("Another reason", "t4");
    assert.equal(await state("ep-accept"), "flagged", "an earlier developer line is this line's support");
  });

  await t.test("approval and upload need a current check and a matching render", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cohost-"));
    const final = path.join(dir, "final.mp4");
    fs.writeFileSync(final, "video");
    const connection = "conn-cohost";
    await saveConnection({ id: connection, name: "Fixture", clientId: "fixture" });
    const render = (id: string, fingerprint: string) => store.updatePost(pid, id, (p) => { p.renders.portrait = { final, package: { title: "T", description: "D", tags: [] }, scriptFingerprint: fingerprint, connectionId: connection }; });
    const fingerprint = async (id: string) => (await store.loadPost(pid, id)).scripts.portrait!.verification!.scriptFingerprint;
    const approve = (id: string) => inProject(() => approveRender(id, "portrait"));
    const upload = (id: string) => inProject(() => uploadToYouTube(id, "portrait", () => {}));
    const accept = (id: string, key: string) => inProject(() => setFlagAccepted(id, "portrait", key, true));
    try {
      const key = await flaggedPost("ep-gate");
      await render("ep-gate", await fingerprint("ep-gate"));
      await assert.rejects(approve("ep-gate"), /Resolve the flagged/, "an open flag blocks approval");
      await accept("ep-gate", key);
      await render("ep-gate", "older-script");
      await assert.rejects(approve("ep-gate"), /Render the final video again/, "an older render blocks approval");
      await render("ep-gate", await fingerprint("ep-gate"));
      await approve("ep-gate");
      assert.ok((await store.loadPost(pid, "ep-gate")).renders.portrait!.approvedAt);

      await store.updatePost(pid, "ep-gate", (p) => { p.questions[0].answer = "A week."; });
      await assert.rejects(upload("ep-gate"), /Check the co-host lines first/, "approve, then change the answers, then upload");
      assert.equal(await getUpload(pid, "ep-gate", "portrait"), undefined, "a refused upload doesn't start");

      await accept("ep-gate-edit", await flaggedPost("ep-gate-edit"));
      await render("ep-gate-edit", await fingerprint("ep-gate-edit"));
      await approve("ep-gate-edit");
      await edit("ep-gate-edit", (s) => { s.segments[1].turns![0].text = "It sold a million."; });
      await assert.rejects(upload("ep-gate-edit"), /Check the co-host lines first/, "approve, then edit, then upload");
      await inProject(() => checkCoHostLines("ep-gate-edit", "portrait", () => {}, "claude", mockAgent(() => false)));
      await assert.rejects(upload("ep-gate-edit"), /Render the final video again/, "a new check doesn't cover an older render");

      await accept("ep-gate-same", await flaggedPost("ep-gate-same"));
      await render("ep-gate-same", await fingerprint("ep-gate-same"));
      await approve("ep-gate-same");
      await store.updatePost(pid, "ep-gate-same", (p) => { p.questions[0].answer = "A week."; });
      await inProject(() => checkCoHostLines("ep-gate-same", "portrait", () => {}, "claude", mockAgent(() => false)));
      const post = await store.loadPost(pid, "ep-gate-same");
      await inProject(() => assertCoHostVerified(post, "portrait"));

      await store.savePost(pid, { ...emptyPost("ep-gate-solo"), scripts: { portrait: { ...dialogue("portrait"), segments: [] } }, renders: { portrait: { final, package: { title: "T", description: "D", tags: [] } } } });
      await approve("ep-gate-solo");
    } finally {
      for (const id of ["ep-gate", "ep-gate-edit", "ep-gate-same"]) await store.updatePost(pid, id, (p) => { delete p.renders.portrait; }).catch(() => {});
      await deleteConnection(connection).catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await remove(pid, false);
}
