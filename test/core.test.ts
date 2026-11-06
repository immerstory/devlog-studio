import { previewMarkdown } from "../shared/article-preview.js";
import { nextStatsDelay } from "../server/stats.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { captionWords, estimateWords, stackStagger, toSrt } from "../server/timeline.js";
import { usesDialogueApi, wordsFromAlignment } from "../server/tts.js";
import { eulerYawPitch, forward, motionPoses, right, slerp } from "../server/capture/scene.js";
import { normalizeScript, weeksBetween } from "../server/pipeline.js";
import type { Pose } from "../shared/types.js";
import { fitTags } from "../server/youtube.js";
import { clampFrame, frameAt, frameRect } from "../shared/framing.js";

const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("estimated words are monotonic and pause after sentences", () => {
  const w = estimateWords("Hello there. This is a test, with commas.");
  assert.equal(w.length, 8);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].startMs >= w[i - 1].endMs);
  const gapAfterSentence = w[2].startMs - w[1].endMs;
  const gapNormal = w[3].startMs - w[2].endMs;
  assert.ok(gapAfterSentence > gapNormal);
});

test("alignment characters group into timed words", () => {
  const chars = "Hi you".split("");
  const words = wordsFromAlignment({
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.1),
    character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
  });
  assert.deepEqual(words, [
    { text: "Hi", startMs: 0, endMs: 200 },
    { text: "you", startMs: 300, endMs: 600 },
  ]);
});

test("captions leave out ElevenLabs expressions and keep the timing of the other words", () => {
  const captioned = (text: string) => captionWords(estimateWords(text)).map((w) => w.text).join(" ");
  assert.equal(captioned("It works. [laughs] Yet here we are."), "It works. Yet here we are.");
  assert.equal(captioned("[laugh] Hello there"), "Hello there");
  assert.equal(captioned("Hello there [laughs harder than ever]"), "Hello there");
  assert.equal(captioned("Hello[laugh] there"), "Hello there");
  assert.equal(captioned("Hello [laugh]. There [sighs], well"), "Hello. There, well");
  assert.equal(captioned("[laugh] [sighs]"), "");
  assert.equal(captioned("A [stray bracket stays"), "A [stray bracket stays");
  const words = [{ text: "One", startMs: 0, endMs: 100 }, { text: "[laughs]", startMs: 100, endMs: 900 }, { text: "two", startMs: 900, endMs: 1000 }];
  assert.deepEqual(captionWords(words), [words[0], words[2]]);
});

test("srt formatting", () => {
  assert.equal(toSrt([{ text: "Hello", startMs: 1500, endMs: 62_250 }]), "1\n00:00:01,500 --> 00:01:02,250\nHello\n");
});

test("Unity Euler(pitch, yaw, 0) matches known forward vectors", () => {
  const f0 = forward(eulerYawPitch(0, 0));
  close(f0[0], 0); close(f0[1], 0); close(f0[2], 1);
  const f90 = forward(eulerYawPitch(90, 0));
  close(f90[0], 1); close(f90[2], 0);
  // Positive pitch looks down in Unity.
  const down = forward(eulerYawPitch(0, 30));
  close(down[1], -0.5);
});

test("slerp endpoints", () => {
  const a = eulerYawPitch(0, 0);
  const b = eulerYawPitch(90, 10);
  slerp(a, b, 0).forEach((v, i) => close(v, a[i]));
  slerp(a, b, 1).forEach((v, i) => close(v, b[i]));
});

test("orbit keeps distance to the centre and looks at it", () => {
  const start: Pose = { position: [10, 5, 0], rotation: eulerYawPitch(-90, 26.565), fov: 40 };
  const poses = motionPoses(start, { type: "orbit", amount: 90 }, 10, [0, 0, 0]);
  assert.equal(poses.length, 10);
  for (const p of poses) {
    close(Math.hypot(p.position[0], p.position[2]), 10, 1e-6);
    const f = forward(p.rotation);
    const toCentre = [-p.position[0], -p.position[1], -p.position[2]];
    const n = Math.hypot(...toCentre);
    close(f[0], toCentre[0] / n, 1e-3);
    close(f[1], toCentre[1] / n, 1e-3);
    close(f[2], toCentre[2] / n, 1e-3);
  }
});

test("normalizeScript resolves slide images to earlier footage segments and known materials", () => {
  const blank = { description: "", target: "", motion: "still" as const, angle: "front" as const, distance: "medium" as const, materialId: "", layout: "none" as const, entrance: "drop" as const, heading: "", bullets: [], imageFrom: [] as string[] };
  const s = normalizeScript(
    {
      title: "T",
      metadata: { title: "T", description: "", tags: [] },
      segments: [
        { narration: "a", onScreen: "", visual: { ...blank, type: "capture", target: "Player", motion: "orbit" } },
        { narration: "b", onScreen: "", visual: { ...blank, type: "material", materialId: "mat-unknown" } },
        { narration: "c", onScreen: "", visual: { ...blank, type: "material", materialId: "mat-a" } },
        { narration: "d", onScreen: "", visual: { ...blank, type: "slide", layout: "compare", heading: "Before/after", imageFrom: ["mat-b", "seg:0", "seg:3", "seg:9", "mat-x"] } },
      ],
    },
    "portrait",
    ["mat-a", "mat-b"],
  );
  assert.equal(s.segments[0].visual.type, "capture");
  assert.equal(s.segments[1].visual.type === "material" && s.segments[1].visual.materialId, undefined);
  assert.equal(s.segments[2].visual.type === "material" && s.segments[2].visual.materialId, "mat-a");
  const slide = s.segments[3].visual;
  assert.ok(slide.type === "slide");
  assert.deepEqual(slide.imageFrom, ["mat-b", s.segments[0].id]);
});

test("weeks cover the range Monday to Sunday, clipped to its ends", () => {
  assert.deepEqual(weeksBetween("2026-09-16", "2026-09-30"), [
    { from: "2026-09-16", to: "2026-09-20" },
    { from: "2026-09-21", to: "2026-09-27" },
    { from: "2026-09-28", to: "2026-09-30" },
  ]);
});

test("pan slides sideways along the camera's right vector, keeps the view and centres on the framing", () => {
  const start: Pose = { position: [5, 2, 1], rotation: eulerYawPitch(90, 10), fov: 40 };
  const poses = motionPoses(start, { type: "pan", amount: 4 }, 11);
  const r = right(start.rotation);
  close(r[1], 0); // a yawed and pitched camera's right vector stays horizontal
  for (const p of poses) assert.deepEqual(p.rotation, start.rotation);
  const first = poses[0].position, middle = poses[5].position, last = poses[10].position;
  middle.forEach((v, i) => close(v, start.position[i]));
  const travel = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
  close(Math.hypot(...travel), 4);
  travel.forEach((v, i) => close(v / 4, r[i]));
});

test("turn swivels on the spot, centred on the framing", () => {
  const start: Pose = { position: [0, 1, 0], rotation: eulerYawPitch(0, 0), fov: 40 };
  const poses = motionPoses(start, { type: "turn", amount: 40 }, 3);
  for (const p of poses) assert.deepEqual(p.position, start.position);
  const fx = poses.map((p) => forward(p.rotation)[0]);
  close(fx[0], -Math.sin(Math.PI / 9));
  close(fx[1], 0);
  close(fx[2], Math.sin(Math.PI / 9));
});

test("v3 and v4 models use the Text to Dialogue API, others Text to Speech", () => {
  for (const m of ["eleven_v4", "eleven_v4_turbo", "eleven_v3"]) assert.equal(usesDialogueApi(m), true, m);
  for (const m of ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_v45"]) assert.equal(usesDialogueApi(m), false, m);
});

test("tags fit YouTube's 500-character total, counting commas and quotes around spaced tags", () => {
  const tags = Array.from({ length: 60 }, (_, i) => `indie game ${i}`);
  const fitted = fitTags(tags);
  const cost = fitted.reduce((n, t, i) => n + t.length + (t.includes(" ") ? 2 : 0) + (i ? 1 : 0), 0);
  assert.ok(cost <= 500 && fitted.length < tags.length && fitted.length > 0);
  assert.deepEqual(fitTags(["a<b>", " devlog "]), ["ab", "devlog"]);
});

test("frameRect covers the viewport and clampFrame reports the shown centre", () => {
  // A 16:9 screenshot in a 9:16 viewport: cover scale comes from the height.
  const r = frameRect(1920, 1080, 1080, 1920, { x: 0.5, y: 0.5, zoom: 1 });
  assert.equal(Math.round(r.height), 1920);
  assert.equal(Math.round(r.left), Math.round((1080 - r.width) / 2));
  assert.equal(r.top, 0);
  // A focus point at the top edge is pushed inwards: the image still covers the viewport.
  const z = frameRect(1920, 1080, 1080, 1920, { x: 0.5, y: 0, zoom: 2 });
  assert.equal(z.top, 0);
  const c = clampFrame(1920, 1080, 1080, 1920, { x: 0.5, y: 0, zoom: 2 });
  assert.ok(Math.abs(c.y - 0.25) < 1e-9);
  // Easing passes the midpoint halfway.
  const mid = frameAt({ start: { x: 0, y: 0, zoom: 1 }, end: { x: 1, y: 1, zoom: 3 } }, 0.5);
  assert.deepEqual(mid, { x: 0.5, y: 0.5, zoom: 2 });
});

test("orbit turns the whole camera around an off-centre pivot", () => {
  // The camera looks along +Z; the pivot lies ahead and to the right, so it is off-centre on screen.
  const start: Pose = { position: [0, 2, 0], rotation: eulerYawPitch(0, 10), fov: 40 };
  const pivot: [number, number, number] = [3, 0, 10];
  const poses = motionPoses(start, { type: "orbit", amount: 60 }, 7, pivot);
  // The framed pose is the middle of the move.
  poses[3].position.forEach((v, i) => close(v, start.position[i], 1e-9));
  poses[3].rotation.forEach((v, i) => close(v, start.rotation[i], 1e-9));
  // It starts 30 degrees to one side and ends 30 degrees to the other.
  const yawAround = (p: Pose) => Math.atan2(p.position[0] - pivot[0], p.position[2] - pivot[2]);
  const turned = (p: Pose) => { const d = yawAround(p) - yawAround(start); return Math.atan2(Math.sin(d), Math.cos(d)); };
  close(turned(poses[0]), (-30 * Math.PI) / 180, 1e-6);
  close(turned(poses[6]), (30 * Math.PI) / 180, 1e-6);
  const angleToPivot = (p: Pose) => {
    const f = forward(p.rotation);
    const d = [pivot[0] - p.position[0], pivot[1] - p.position[1], pivot[2] - p.position[2]];
    return Math.acos((f[0] * d[0] + f[1] * d[1] + f[2] * d[2]) / Math.hypot(...d));
  };
  const startAngle = angleToPivot(start);
  for (const p of poses) {
    close(Math.hypot(p.position[0] - pivot[0], p.position[2] - pivot[2]), Math.hypot(3, 10), 1e-6);
    close(p.position[1], 2, 1e-9);
    close(angleToPivot(p), startAngle, 1e-6);
  }
});

test("fovEnd zooms the lens across any move", () => {
  const start: Pose = { position: [0, 2, 0], rotation: eulerYawPitch(0, 10), fov: 50 };
  const poses = motionPoses(start, { type: "still" }, 5, undefined, 20);
  assert.equal(poses[0].fov, 50);
  assert.equal(poses[4].fov, 20);
  assert.equal(poses[2].fov, 35);
  poses.forEach((p) => p.position.forEach((v, i) => close(v, start.position[i], 1e-9)));
});

test("stack polaroids spread across the narration", () => {
  // 4 polaroids over 6 s of speech at 30 fps: the last lands at 80 % (4.8 s), so 1.6 s apart.
  assert.equal(stackStagger(4, 6000, 30), 48);
  // Short speech never drops them faster than the minimum stagger.
  assert.equal(stackStagger(6, 1000, 30), Math.round(0.55 * 30));
  assert.equal(stackStagger(3, 0, 30), Math.round(0.55 * 30));
});


test("the folder listing marks Git working copies, finds the enclosing one and hides dot folders", async () => {
  const { listFolders } = await import("../server/folders.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "folders-"));
  try {
    fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "repo", "src"));
    fs.mkdirSync(path.join(root, "plain"));
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, "file.txt"), "");
    fs.mkdirSync(path.join(root, "game", "Assets"), { recursive: true });
    fs.mkdirSync(path.join(root, "game", "ProjectSettings"));
    fs.writeFileSync(path.join(root, "tool.exe"), "");
    fs.chmodSync(path.join(root, "tool.exe"), 0o755);
    const top = await listFolders(root);
    assert.deepEqual(top.folders.map((f) => [f.name, f.git, f.unity]), [["game", false, true], ["plain", false, false], ["repo", true, false]]);
    assert.equal((await listFolders(path.join(root, "game"))).unity, true);
    assert.deepEqual(top.executables, []);
    assert.deepEqual((await listFolders(root, { executables: true })).executables.map((f) => f.name), ["tool.exe"]);
    assert.ok((await listFolders(root, { hidden: true })).folders.some((f) => f.name === ".hidden"));
    assert.ok(!(await listFolders(path.join(root, "repo"), { hidden: true })).folders.some((f) => f.name === ".git"));
    assert.equal((await listFolders(path.join(root, "repo", "src"))).repo, path.join(root, "repo"));
    assert.equal(top.parent, path.dirname(root));
    await assert.rejects(listFolders(path.join(root, "missing")), /does not exist/);
    await assert.rejects(listFolders(path.join(root, "file.txt")), /is not a folder/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("statistics refresh on their interval, and a restart doesn't add a fetch", () => {
  const hour = 3600_000, interval = 3 * hour, now = 1_000 * hour;
  assert.equal(nextStatsDelay(now - hour, interval, now), 2 * hour, "the rest of the interval");
  assert.equal(nextStatsDelay(now - 5 * hour, interval, now), 60_000, "overdue: shortly after start");
  assert.equal(nextStatsDelay(undefined, interval, now), 60_000, "never fetched: shortly after start");
  assert.equal(nextStatsDelay(now - interval + 1000, interval, now), 60_000, "never sooner than the start delay");
});

test("an article preview resolves pictures, the embed and the video's link", () => {
  const body = "## Shop\n\n{{image:mat-1}}\n\n{{youtube.embed}}\n\nWatch {{youtube.url}}\n\n{{image:gone [x]}}";
  const alt = (id: string) => (id === "mat-1" ? "The [new] shop" : "");
  const out = previewMarkdown(body, { alt, youtubeUrl: "https://youtu.be/x" });
  assert.match(out, /!\[The new shop\]\(devlog-image:mat-1\)/, "brackets leave the alt text, as they do on export");
  assert.match(out, /!\[\]\(devlog-video:embed\)/);
  assert.match(out, /Watch https:\/\/youtu\.be\/x/);
  assert.match(out, /devlog-image:gone%20%5Bx%5D/, "an ID stays one address");
  assert.doesNotMatch(out, /\{\{/);
  assert.match(previewMarkdown("See {{youtube.url}}", { alt }), /once it's uploaded/);
});
