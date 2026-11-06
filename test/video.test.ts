import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { jitter, outputSize, spring, VideoFrameRenderer, wrapText } from "../video/renderer.js";
import { audioSchedule, FADE_FRAMES, footageSeconds, segmentWindows } from "../video/schedule.js";
import { audioMixArgs, serverPlatform } from "../server/render.js";
import { themeColors, type TimelineProps, type TimelineSegment } from "../shared/types.js";

const segment = (id: string, from: number, durationInFrames: number, extra: Partial<TimelineSegment> = {}): TimelineSegment => ({
  id, from, durationInFrames, visual: { type: "slide", layout: "title", heading: "Heading" }, ...extra,
} as TimelineSegment);

const timeline = (extra: Partial<TimelineProps> = {}): TimelineProps => ({
  format: "portrait", fps: 30, width: 108, height: 192, durationInFrames: 90,
  theme: { gameTitle: "Title", colors: themeColors(), backgrounds: [] },
  segments: [segment("one", 0, 30), segment("two", 30, 60)], captions: [], narrated: false, ...extra,
});

test("a segment starts early by the fade over the previous one, except the first", () => {
  assert.deepEqual(segmentWindows(timeline()).map((w) => [w.start, w.end]), [[0, 30], [30 - FADE_FRAMES, 90]]);
});

test("footage time follows the trim and the playback rate", () => {
  const media = { src: "a.mp4", kind: "video" as const, trimStartFrames: 30, playbackRate: 0.5 };
  assert.equal(footageSeconds(segment("v", 0, 30, { media }), 30, 60), 2);
  assert.equal(footageSeconds(segment("v", 0, 30, { media: { src: "a.mp4", kind: "video" } }), 30, 15), 0.5);
});

test("the schedule places narration after the speech lead, footage under it and the outro music before the outro", () => {
  const sounds = audioSchedule(timeline({
    theme: { gameTitle: "", colors: themeColors(), backgrounds: [], outro: { style: "x", params: {}, durationInFrames: 30, audioUrl: "outro.wav", audioLeadSeconds: 0.5 } },
    segments: [
      segment("one", 0, 30, { introFrames: 15, audio: [{ src: "line.mp3", startFrame: 3 }] }),
      segment("two", 30, 60, { media: { src: "clip.mp4", kind: "video", trimStartFrames: 6, playbackRate: 2 } }),
    ],
  }));
  const by = (src: string) => sounds.find((s) => s.src === src)!;
  assert.equal(by("line.mp3").at, (15 + 5 + 3) / 30);
  assert.equal(by("line.mp3").maxSeconds, (30 - 23) / 30);
  assert.deepEqual(
    { at: by("clip.mp4").at, offset: by("clip.mp4").offset, rate: by("clip.mp4").rate, optional: by("clip.mp4").optional, volume: by("clip.mp4").volume },
    { at: (30 - FADE_FRAMES) / 30, offset: 6 / 30, rate: 2, optional: true, volume: 0.25 },
  );
  assert.equal(by("outro.wav").at, (90 - 30 - 15) / 30);
  assert.equal(by("outro.wav").maxSeconds, undefined);
});

test("the mix graph trims, delays and sums every sound in stereo, and is absent for silence", () => {
  assert.equal(audioMixArgs([], 3), null);
  const mix = audioMixArgs([
    { src: "line.mp3", at: 1.5, offset: 0, volume: 1, rate: 1 },
    { src: "clip.mp4", at: 0, offset: 2, maxSeconds: 4, volume: 0.25, rate: 2, optional: true },
  ], 10)!;
  assert.deepEqual(mix.inputs, ["-i", "line.mp3", "-i", "clip.mp4"]);
  assert.match(mix.filter, /\[0:a\]aresample=48000,aformat=channel_layouts=stereo,adelay=1500:all=1\[a0\]/);
  assert.match(mix.filter, /\[1:a\]atrim=start=2\.000,asetpts=PTS-STARTPTS,atempo=2\.0000,atrim=end=4\.000,volume=0\.25/);
  assert.match(mix.filter, /amix=inputs=2:normalize=0:dropout_transition=0,apad,atrim=end=10\.000\[mix\]/);
});

test("spring starts at rest, overshoots and settles on 1", () => {
  const at = (frame: number) => spring(frame, 30, 14, 120, 0.9);
  assert.equal(at(-3), 0);
  assert.equal(at(0), 0);
  assert.ok(Math.max(...Array.from({ length: 30 }, (_, i) => at(i))) > 1, "it overshoots");
  assert.ok(Math.abs(at(120) - 1) < 1e-4);
});

test("jitter repeats for one seed and differs between seeds", () => {
  assert.equal(jitter("a", 1, 2), jitter("a", 1, 2));
  assert.notEqual(jitter("a", 1, 2), jitter("b", 1, 2));
});

test("text wraps at spaces, and a long word stays on its own line", () => {
  const width = (s: string) => s.length;
  assert.deepEqual(wrapText(width, "aa bb  cc", 5), ["aa bb", "cc"]);
  assert.deepEqual(wrapText(width, "aaaaaaaa b", 5), ["aaaaaaaa", "b"]);
  assert.deepEqual(wrapText(width, "   ", 5), []);
});

test("a draft's canvas size stays even for the encoder", () => {
  assert.deepEqual(outputSize({ width: 1080, height: 1920 }, 0.5), { width: 540, height: 960 });
  assert.deepEqual(outputSize({ width: 1080, height: 1920 }, 0.33), { width: 356, height: 634 });
});

const dataUrlServer = async <T>(file: Buffer, run: (url: string) => Promise<T>) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array(file))) as typeof fetch;
  try { return await run("http://test/image"); } finally { globalThis.fetch = original; }
};

test("a frame draws fades, captions and missing shots without footage, the same at any seek order", async () => {
  const t = timeline({
    width: 1080,
    height: 1920,
    captions: [{ text: "A caption", startMs: 0, endMs: 3000, speakerChange: true }],
    segments: [segment("one", 0, 30), segment("two", 30, 60, { visual: { type: "capture", description: "A shot" } as TimelineSegment["visual"] })],
  });
  const renderer = await VideoFrameRenderer.create(t, serverPlatform, () => null);
  const canvas = createCanvas(t.width, t.height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const pixels = (frame: number) => { renderer.draw(ctx, frame); return Buffer.from(canvas.data()); };
  const fifty = pixels(50);
  const ten = pixels(10);
  assert.notEqual(Buffer.compare(fifty, ten), 0);
  assert.equal(Buffer.compare(pixels(50), fifty), 0, "frames do not depend on what was drawn before");
  assert.equal(Buffer.compare(pixels(10), ten), 0);
});

test("a shot that is still missing keeps its on-screen label", async () => {
  const visual = { type: "material", description: "To record" } as TimelineSegment["visual"];
  const size = { width: 1080, height: 1920, durationInFrames: 60 };
  const render = async (onScreen?: string) => {
    const t = timeline({ ...size, segments: [segment("one", 0, 60, { visual, onScreen })] });
    const renderer = await VideoFrameRenderer.create(t, serverPlatform, () => null);
    const canvas = createCanvas(t.width, t.height);
    renderer.draw(canvas.getContext("2d") as unknown as CanvasRenderingContext2D, 30);
    return Buffer.from(canvas.data());
  };
  assert.notEqual(Buffer.compare(await render("21 shops"), await render()), 0);
});

test("a box shadow is as strong as CSS draws it, below the print", async () => {
  const t = timeline({
    width: 1080,
    height: 1920,
    segments: [segment("one", 0, 90, { visual: { type: "slide", layout: "image", heading: "" } as TimelineSegment["visual"], slideImages: ["http://test/a.png"] })],
  });
  const png = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=8x8", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 1e6 }).stdout;
  const renderer = await dataUrlServer(png, () => VideoFrameRenderer.create(t, serverPlatform, () => null));
  const canvas = createCanvas(t.width, t.height);
  renderer.draw(canvas.getContext("2d") as unknown as CanvasRenderingContext2D, 40);
  const ctx = canvas.getContext("2d");
  const column = Array.from({ length: t.height }, (_, y) => ctx.getImageData(540, y, 1, 1).data[0]);
  // Walking up from the paper to the print's lower edge: 35% offset by 18 px with a 40 px blur reaches about 27% there.
  let edge = 1800;
  while (edge > 0 && column[edge] < 245) edge--;
  assert.ok(edge > 0, "the print's lower edge is found");
  const shade = column[edge + 4] / column[edge + 120];
  assert.ok(shade > 0.68 && shade < 0.8, `shadow under the edge: ${column[edge + 4]} on paper ${column[edge + 120]}`);
});

test("an export stops on a picture that cannot load, while a preview leaves its place empty", async () => {
  const t = timeline({ segments: [segment("one", 0, 90, { media: { src: "http://test/missing.png", kind: "image" }, visual: { type: "material", description: "" } as TimelineSegment["visual"] })] });
  await dataUrlServer(Buffer.from("not an image"), async () => {
    await assert.rejects(VideoFrameRenderer.create(t, serverPlatform, () => null), /picture could not be read/);
    assert.ok(await VideoFrameRenderer.create(t, serverPlatform, () => null, { tolerant: true }));
  });
});

test("the server reads PNG variants its canvas library rejects, keeping transparency", async () => {
  // A chunk the canvas library does not know, inserted before the picture data.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-png-"));
  try {
    const file = path.join(dir, "a.png");
    const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red@0.5:s=4x4,format=rgba", "-frames:v", "1", file]);
    assert.equal(made.status, 0);
    const png = fs.readFileSync(file);
    const extra = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from("caBX"), Buffer.from([0]), Buffer.from([0, 0, 0, 0])]);
    const altered = Buffer.concat([png.subarray(0, 33), extra, png.subarray(33)]);
    const picture = await dataUrlServer(altered, (url) => serverPlatform.loadImage(url));
    assert.equal(picture.width, 4);
    const canvas = createCanvas(4, 4);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(picture.source as never, 0, 0);
    assert.ok(ctx.getImageData(1, 1, 1, 1).data[3] < 255, "alpha survives");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
