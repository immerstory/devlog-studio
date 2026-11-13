/** Temporary: prints what the CI runner's canvas sees. Removed before the PR is reviewed. */
import { execSync } from "node:child_process";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { VideoFrameRenderer } from "../video/renderer.js";
import { serverPlatform } from "../server/render.js";
import { themeColors, type TimelineProps, type TimelineSegment } from "../shared/types.js";

const sh = (cmd: string) => { try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch (e) { return `(failed: ${(e as Error).message.split("\n")[0]})`; } };
console.log("uname:", sh("uname -m"), "| os:", sh("grep PRETTY_NAME /etc/os-release"));
console.log("fc-list count:", sh("fc-list | wc -l"));
for (const f of ["cursive", "sans-serif", "system-ui", "Segoe UI", "Comic Sans MS"]) console.log(`fc-match ${f}:`, sh(`fc-match '${f}'`));
console.log("GlobalFonts families:", GlobalFonts.families.length, GlobalFonts.families.slice(0, 8).map((f) => f.family).join(", "));
const c = createCanvas(400, 100).getContext("2d");
for (const font of ["40px DevlogDisplay, 'Segoe Print', 'Comic Sans MS', cursive", "800 40px 'Segoe UI', Inter, system-ui, sans-serif", "40px sans-serif", "40px DejaVu Sans"]) {
  c.font = font;
  console.log(`measure [${font}] -> font="${c.font}" width=${c.measureText("Heading SHOT").width.toFixed(1)}`);
}
const segment = (id: string, from: number, n: number, extra: Partial<TimelineSegment> = {}) => ({ id, from, durationInFrames: n, visual: { type: "slide", layout: "title", heading: "Heading" }, ...extra }) as TimelineSegment;
const t: TimelineProps = {
  format: "portrait", fps: 30, width: 1080, height: 1920, durationInFrames: 90, theme: { gameTitle: "Title", colors: themeColors(), backgrounds: [] },
  captions: [{ text: "A caption", startMs: 0, endMs: 3000, speakerChange: true }], narrated: false,
  segments: [segment("one", 0, 30), segment("two", 30, 60, { visual: { type: "capture", description: "A shot" } as TimelineSegment["visual"] })],
} as TimelineProps;
const renderer = await VideoFrameRenderer.create(t, serverPlatform, () => null);
const canvas = createCanvas(t.width, t.height);
const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
const frame = (n: number) => { renderer.draw(ctx, n); return Buffer.from(canvas.data()); };
const ten = frame(10), fifty = frame(50);
let differ = 0;
for (let i = 0; i < ten.length; i += 4) if (ten[i] !== fifty[i] || ten[i + 1] !== fifty[i + 1] || ten[i + 2] !== fifty[i + 2]) differ++;
const colors = (b: Buffer) => { const s = new Set<string>(); for (let i = 0; i < b.length; i += 4 * 97) s.add(`${b[i]},${b[i + 1]},${b[i + 2]},${b[i + 3]}`); return s.size; };
console.log("frame 10 vs 50: differing pixels", differ, "| distinct sampled colours 10:", colors(ten), "50:", colors(fifty), "| first pixel 10:", [...ten.subarray(0, 4)], "50:", [...fifty.subarray(0, 4)]);
