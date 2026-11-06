import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeCommitReferences } from "../server/commit-references.js";
import { detachMaterial, mergeCaptureTargets, pinDefaultCaptureTarget, pruneSegmentReferences, scriptCaptureTargets } from "../shared/references.js";
import { validateCaptureTargetChange } from "../server/projects.js";
import { config, exampleConfig } from "../server/config.js";
import { projectFromStudio } from "../server/project-model.js";
import type { Post, Script } from "../shared/types.js";

function script(): Script {
  return { format: "portrait", title: "References", metadata: { title: "", description: "", tags: [] }, segments: [
    { id: "seg-shot", narration: "", visual: { type: "material", description: "Photo", materialId: "mat-photo" } },
    { id: "seg-slide", narration: "", visual: { type: "slide", layout: "compare", heading: "Before and after", imageFrom: ["seg-shot", "mat-photo", "mat-keep"], captions: { "seg-shot": "shot", "mat-photo": "photo", "mat-keep": "keep" } } },
  ] };
}

test("material detachment clears nested references without changing unrelated content", () => {
  const post = { materialIds: ["mat-photo", "mat-keep"], scripts: { portrait: script(), landscape: { ...script(), format: "landscape" } } } as Post;
  detachMaterial(post, "mat-photo");
  assert.deepEqual(post.materialIds, ["mat-keep"]);
  for (const s of Object.values(post.scripts)) {
    assert.equal(s!.segments[0].visual.type === "material" && s!.segments[0].visual.materialId, undefined);
    const visual = s!.segments[1].visual;
    assert.ok(visual.type === "slide");
    assert.deepEqual(visual.imageFrom, ["seg-shot", "mat-keep"]);
    assert.deepEqual(visual.captions, { "seg-shot": "shot", "mat-keep": "keep" });
  }
});

test("removed segment references are pruned within each script while material references stay", () => {
  const s = script();
  s.segments.splice(0, 1);
  pruneSegmentReferences(s, ["seg-shot"]);
  const visual = s.segments[0].visual;
  assert.ok(visual.type === "slide");
  assert.deepEqual(visual.imageFrom, ["mat-photo", "mat-keep"]);
  assert.deepEqual(visual.captions, { "mat-photo": "photo", "mat-keep": "keep" });
});

test("stale script edits retain server pinning while deliberate target changes remain possible", () => {
  const original = script();
  original.segments[0].visual = { type: "capture", description: "Scene", shot: { model: "scene", motion: { type: "still" } } };
  const pinned = structuredClone(original);
  assert.ok(pinned.segments[0].visual.type === "capture");
  pinned.segments[0].visual.targetId = "target-old";
  const edited = structuredClone(original);
  edited.segments[0].narration = "Local edit";
  mergeCaptureTargets(pinned, edited, scriptCaptureTargets(original));
  assert.ok(edited.segments[0].visual.type === "capture");
  assert.equal(edited.segments[0].visual.targetId, "target-old");
  assert.equal(edited.segments[0].narration, "Local edit");
  const legacy = structuredClone(original);
  mergeCaptureTargets(pinned, legacy);
  assert.ok(legacy.segments[0].visual.type === "capture");
  assert.equal(legacy.segments[0].visual.targetId, "target-old");
  const reset = structuredClone(pinned);
  assert.ok(reset.segments[0].visual.type === "capture");
  delete reset.segments[0].visual.targetId;
  mergeCaptureTargets(pinned, reset, scriptCaptureTargets(pinned));
  assert.equal(reset.segments[0].visual.targetId, undefined);
});

test("agent commit references resolve only to unique evidence and discard invalid citations", () => {
  const evidence = [{ sourceId: "source-one", hash: "abcdef0123456789" }, { sourceId: "source-two", hash: "1234567890abcdef" }];
  assert.deepEqual(normalizeCommitReferences(["abcdef0", "source-two:1234567", "HEAD~1", "source-foreign:abcdef0", "fffffff", 123, "source-one:abcdef0123456789"], evidence), { references: ["source-one:abcdef0123456789", "source-two:1234567890abcdef"], rejected: 4 });
  assert.deepEqual(normalizeCommitReferences(["abcdef0"], [...evidence, { sourceId: "source-two", hash: evidence[0].hash }]), { references: [], rejected: 1 });
});

test("capture target removal and default changes account for implicit shot targets", () => {
  const settings = projectFromStudio(exampleConfig(), "source-one", "target-one");
  const next = structuredClone(settings);
  next.captureTargets.push({ ...next.captureTargets[0], id: "target-two" });
  const post = { scripts: { portrait: { ...script(), segments: [{ id: "seg-shot", narration: "", visual: { type: "capture", description: "View", shot: { model: "scene", motion: { type: "still" } } } }] } } } as Post;
  next.defaultCaptureTargetId = "target-two";
  assert.doesNotThrow(() => validateCaptureTargetChange(settings, next, [post]));
  assert.equal(pinDefaultCaptureTarget(post, settings.defaultCaptureTargetId!), true);
  const visual = post.scripts.portrait!.segments[0].visual;
  assert.ok(visual.type === "capture");
  assert.equal(visual.targetId, "target-one");
  assert.equal(pinDefaultCaptureTarget(post, "target-two"), false);
  next.captureTargets = next.captureTargets.filter((t) => t.id !== "target-one");
  assert.throws(() => validateCaptureTargetChange(settings, next, [post]), /still uses/);
  assert.doesNotThrow(() => validateCaptureTargetChange(settings, next, []));
  assert.doesNotThrow(() => validateCaptureTargetChange({ ...settings, captureTargets: [], defaultCaptureTargetId: undefined }, { ...next, captureTargets: settings.captureTargets, defaultCaptureTargetId: "target-one" }, [post]));
});

test("example configuration is read once and callers receive independent copies", () => {
  const read = fs.readFileSync;
  let count = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith("studio.example.json")) count++;
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readFileSync;
  try {
    const first = exampleConfig();
    first.agent.claude.executable = "changed";
    assert.notEqual(exampleConfig().agent.claude.executable, "changed");
    for (let i = 0; i < 5; i++) config();
    assert.ok(count <= 1);
  } finally { fs.readFileSync = read; }
});
