import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultPageDevice, FORMAT_SIZE, pageMoveProgress, pageShotMoves, type PageShot } from "../../../shared/types.js";
import { DEFAULT_PAGE_HEADERS, parseHeaders, type BrowserTargetConfig } from "../../../shared/projects.js";
import type { CaptureProvider, CaptureOutput, CaptureResult, Log } from "../provider.js";
import { encodeSequence } from "../encoding.js";
import { throwIfCancelled } from "../../jobs.js";
import { openPage } from "./render.js";
import { savePageCheck } from "./checks.js";
import { highlightScroll } from "./highlight.js";
import { coveringPaywall } from "./verify.js";

const run = promisify(execFile);

const RULES = `a webpage filmed in a browser, frame by frame, with the page's own animations playing. Fill url (an absolute URL, or a path such as "/pricing" on the target's site), device ("phone" or "desktop"; "" for the format's default: phone for Shorts, desktop for landscape) and scrollTo (where the page scrolls to during the segment: a CSS selector such as "#features", a number of pixels such as "1200", or "" to stay at the top). Leave target, motion, angle and distance empty. Use it to show a website, web app or store page; the developer can adjust scrolling and zoom afterwards. When the page is a source, such as an article a claim comes from: use its exact URL from the evidence, and never build or guess one; when the evidence names no URL for a source, show it on a slide instead. A segment whose narration names a source shows that source's page or a slide, never the page of another outlet. For a source page, set credit to who published it ("Outlet · Author", or the outlet alone), and set expectText to a short phrase the page shows, usually its headline exactly as written; the capture fails when the page no longer shows it, and the video shows the credit with the link. For other pages, leave credit and expectText empty. When the narration reports what the page says, set highlightText to that sentence or phrase as the page writes it (at most 25 words, for example a quote the evidence gives from the article): the page then holds still on it and marks it word by word, which reads better than a scroll; leave scrollTo empty then. Show one page in two consecutive segments only when each highlights a different sentence. Leave highlightText empty when you don't know the page's exact words.`;

/** Resolves a shot's URL against the target's base URL; only http and https pages are filmed. */
export function pageUrl(target: BrowserTargetConfig, url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("Enter the page URL of this shot.");
  let resolved: URL;
  try {
    resolved = new URL(trimmed, target.baseUrl?.trim() || undefined);
  } catch {
    throw new Error(target.baseUrl?.trim() ? `“${trimmed}” is not a valid URL.` : `“${trimmed}” is not a full URL, and the capture target has no base URL.`);
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") throw new Error("Only http and https pages can be filmed.");
  return resolved.toString();
}

async function render(target: BrowserTargetConfig, shot: PageShot, out: CaptureOutput, log: Log): Promise<CaptureResult> {
  const output = FORMAT_SIZE[out.format];
  const moving = pageShotMoves(shot);
  fs.mkdirSync(out.dir, { recursive: true });
  const frameDir = path.join(out.dir, "page-frames");
  fs.rmSync(frameDir, { recursive: true, force: true });
  const session = await openPage({ url: pageUrl(target, shot.url), device: shot.device ?? defaultPageDevice(out.format), output, settleMs: shot.settleMs ?? 1000, hide: shot.hide ?? [], css: [target.css ?? "", shot.css ?? ""], userAgent: target.userAgent, headers: parseHeaders(target.headers ?? DEFAULT_PAGE_HEADERS), source: shot, highlight: shot.highlight, onCheck: savePageCheck, log });
  try {
    // A highlighted sentence holds the page still around it; the scroll fields don't apply.
    const still = shot.highlight?.trim() ? await session.run<number>(highlightScroll) : undefined;
    const from = still ?? await session.scrollOf(shot.scrollFrom);
    const to = still ?? await session.scrollOf(shot.scrollTo);
    const frames = moving ? Math.max(2, out.frames) : 1;
    const shotSeconds = (frames - 1) / out.fps;
    const step = 1000 / out.fps;
    log(moving ? `Filming ${frames} frames: scroll ${Math.round(from)} → ${Math.round(to)} px, zoom ${shot.zoomFrom} → ${shot.zoomTo}…` : "Taking a still of the page…");
    if (moving && shot.scrollSpeed && to !== from) {
      const needed = (shot.delaySeconds ?? 0) + Math.abs(to - from) / shot.scrollSpeed;
      if (needed > shotSeconds + 0.05) log(`  At ${shot.scrollSpeed} px/s the scroll needs ${needed.toFixed(1)} s, but the shot lasts ${shotSeconds.toFixed(1)} s: it stops partway.`);
    }
    for (let i = 0; i < frames; i++) {
      throwIfCancelled();
      // The last frame lands on the end of the shot, so a move without a speed ends exactly there.
      const t = frames === 1 ? 0 : pageMoveProgress(shot, (i / (frames - 1)) * shotSeconds, shotSeconds, Math.abs(to - from));
      // Content that loads late above the sentence pushes it down, so a highlight follows it on every frame.
      const scrollY = still === undefined ? from + (to - from) * t : await session.run<number>(highlightScroll);
      await session.frame(
        { scrollY, zoom: shot.zoomFrom + (shot.zoomTo - shot.zoomFrom) * t, focusX: shot.focus.x, focusY: shot.focus.y },
        step,
        path.join(frameDir, `f_${String(i).padStart(4, "0")}.png`),
      );
      if (frames > 1 && ((i + 1) % 30 === 0 || i + 1 === frames)) log(`  ${i + 1}/${frames} frames`);
    }
    // A paywall that opened while filming covers the footage, so the take isn't kept.
    const paywall = await coveringPaywall(session.page).catch(() => undefined);
    if (paywall) throw new Error(`A paywall opened over the page while filming (“${paywall}…”). Show this source on a slide instead.`);
    if (session.releasedFrames) log(`  ${session.releasedFrames} frame(s) needed page time to run freely for a moment; script-driven effects may jump there.`);
    if (session.repeatedFrames) log(`  ${session.repeatedFrames} frame(s) repeat the previous picture: the page produced none in time.`);
  } finally {
    await session.close();
  }
  if (!moving) {
    const file = path.join(out.dir, "page.png");
    fs.renameSync(path.join(frameDir, "f_0000.png"), file);
    fs.rmSync(frameDir, { recursive: true, force: true });
    return { file };
  }
  const mp4 = path.join(out.dir, "page.mp4");
  await encodeSequence(path.join(frameDir, "f_%04d.png"), out.fps, mp4, output);
  const poster = path.join(out.dir, "page.jpg");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(frameDir, "f_0000.png"), "-q:v", "2", poster], { windowsHide: true });
  fs.rmSync(frameDir, { recursive: true, force: true });
  return { file: mp4, poster, durationSeconds: out.frames / out.fps };
}

export const browserProvider: CaptureProvider<BrowserTargetConfig, PageShot> = {
  kind: "browser",
  shotModel: "page",
  capabilities: { objects: false, selection: false, viewPose: false, motions: [], video: true },
  // Every capture starts its own browser, so captures of different targets never wait for each other.
  resourceKey: () => `browser:${crypto.randomUUID()}`,
  async status(target) {
    return { ok: true, detail: target.baseUrl?.trim() ? `Browser ready for ${target.baseUrl.trim()}` : "Browser ready" };
  },
  promptRules: (target) => RULES + (target.baseUrl?.trim() ? ` The site is ${target.baseUrl.trim()}.` : ""),
  render,
};
