import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaultPageDevice, FORMAT_SIZE, pageMoveProgress, pageShotMoves, type Format, type PageShot } from "../../../shared/types.js";
import { DEFAULT_PAGE_HEADERS, parseHeaders, type BrowserTargetConfig } from "../../../shared/projects.js";
import type { CaptureProvider, CaptureOutput, CaptureResult, Log } from "../provider.js";
import { encodeSequence } from "../encoding.js";
import { CancelledError, throwIfCancelled } from "../../jobs.js";
import { openPage, type PageFrame, type PageSession } from "./render.js";
import type { PageTrace } from "./trace.js";
import { savePageCheck } from "./checks.js";
import { highlightScroll } from "./highlight.js";
import { coveringPaywall, HIDE_NOTICES } from "./verify.js";

const run = promisify(execFile);

const RULES = `a webpage filmed in a browser, frame by frame, with the page's own animations playing. Fill url (an absolute URL, or a path such as "/pricing" on the target's site), device ("phone" or "desktop"; "" for the format's default: phone for Shorts, desktop for landscape) and scrollTo (where the page scrolls to during the segment: a CSS selector such as "#features", a number of pixels such as "1200", or "" to stay at the top). Leave target, motion, angle and distance empty. Use it to show a website, web app or store page; the developer can adjust scrolling and zoom afterwards. When the page is a source, such as an article a claim comes from: use its exact URL from the evidence, and never build or guess one; when the evidence names no URL for a source, show it on a slide instead. A segment whose narration names a source shows that source's page or a slide, never the page of another outlet. For a source page, set credit to who published it ("Outlet · Author", or the outlet alone), and set expectText to a short phrase the page shows, usually its headline exactly as written; the capture fails when the page no longer shows it, and the video shows the credit with the link. For other pages, leave credit and expectText empty. When the narration reports what the page says, set highlightText to that sentence or phrase as the page writes it (at most 25 words, for example a quote the evidence gives from the article): the page then holds still on it and marks it word by word, which reads better than a scroll; leave scrollTo empty then. Show one page in two consecutive segments only when each highlights a different sentence. A segment about a specific real product shows the manufacturer's product page or the article's photo of it, credited to its publisher, never footage to record or a generated image. Leave highlightText empty when you don't know the page's exact words.`;

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

/** Opens a shot's page with the shot's settings, ready to film. */
export function openShot(target: BrowserTargetConfig, shot: PageShot, format: Format, log: Log, trace?: PageTrace, onCheck = savePageCheck): Promise<PageSession> {
  const url = pageUrl(target, shot.url);
  if (trace) trace.url = url;
  return openPage({ url, trace, device: shot.device ?? defaultPageDevice(format), output: FORMAT_SIZE[format], settleMs: shot.settleMs ?? 1000, hide: shot.hide ?? [], css: [target.css ?? "", shot.css ?? ""], script: shot.script, userAgent: target.userAgent, headers: parseHeaders(target.headers ?? DEFAULT_PAGE_HEADERS), source: shot, highlight: shot.highlight, realtime: shot.realtime, onCheck, log });
}

/** A shot's frames: how many, how long each lasts, and what the view shows in them. */
export interface ShotPath { from: number; to: number; frames: number; seconds: number; step: number; frame(i: number): Promise<PageFrame> }

/** The frames a capture films and a preview takes its pictures from. A highlighted sentence holds the page still around it; the scroll fields don't apply. */
export async function shotPath(session: Pick<PageSession, "run" | "scrollOf">, shot: PageShot, length: { frames: number; fps: number }): Promise<ShotPath> {
  const still = shot.highlight?.trim() ? await session.run<number>(highlightScroll) : undefined;
  const from = still ?? await session.scrollOf(shot.scrollFrom);
  const to = still ?? await session.scrollOf(shot.scrollTo);
  const frames = pageShotMoves(shot) ? Math.max(2, length.frames) : 1;
  const seconds = (frames - 1) / length.fps;
  return {
    from, to, frames, seconds, step: 1000 / length.fps,
    async frame(i) {
      // The last frame lands on the end of the shot, so a move without a speed ends exactly there.
      const t = frames === 1 ? 0 : pageMoveProgress(shot, (i / (frames - 1)) * seconds, seconds, Math.abs(to - from));
      // Content that loads late above the sentence pushes it down, so a highlight follows it on every frame.
      const scrollY = still === undefined ? from + (to - from) * t : await session.run<number>(highlightScroll);
      return { scrollY, zoom: shot.zoomFrom + (shot.zoomTo - shot.zoomFrom) * t, focusX: shot.focus.x, focusY: shot.focus.y, rasterZoom: Math.max(shot.zoomFrom, shot.zoomTo) };
    },
  };
}

async function render(target: BrowserTargetConfig, shot: PageShot, out: CaptureOutput, log: Log): Promise<CaptureResult> {
  const output = FORMAT_SIZE[out.format];
  const moving = pageShotMoves(shot);
  fs.mkdirSync(out.dir, { recursive: true });
  const frameDir = path.join(out.dir, "page-frames");
  fs.rmSync(frameDir, { recursive: true, force: true });
  const session = await openShot(target, shot, out.format, log, out.trace);
  try {
    const shown = await shotPath(session, shot, out);
    const { from, to, frames, step, seconds: shotSeconds } = shown;
    log(moving ? `Filming ${frames} frames: scroll ${Math.round(from)} → ${Math.round(to)} px, zoom ${shot.zoomFrom} → ${shot.zoomTo}…` : "Taking a still of the page…");
    if (moving && shot.scrollSpeed && to !== from) {
      const needed = (shot.delaySeconds ?? 0) + Math.abs(to - from) / shot.scrollSpeed;
      if (needed > shotSeconds + 0.05) log(`  At ${shot.scrollSpeed} px/s the scroll needs ${needed.toFixed(1)} s, but the shot lasts ${shotSeconds.toFixed(1)} s: it stops partway.`);
    }
    const frameFile = (i: number) => path.join(frameDir, `f_${String(i).padStart(4, "0")}.png`);
    const film = async (i: number) => session.frame(await shown.frame(i), step, frameFile(i));
    let lastLogged = 0;
    const progress = (done: number) => {
      if (frames > 1 && (done - lastLogged >= 30 || done === frames)) { lastLogged = done; log(`  ${done}/${frames} frames`); }
    };
    if (shot.realtime && frames > 1) {
      // On the page's own clock, each frame takes the picture due at that moment. Frames the browser couldn't deliver
      // in time repeat the picture before them, so the timing stays right and the motion may stutter.
      const startedAt = Date.now();
      let next = 0, repeated = 0, sinceHide = Number.POSITIVE_INFINITY;
      while (next < frames) {
        throwIfCancelled();
        if (Date.now() - sinceHide >= 500 || sinceHide === Number.POSITIVE_INFINITY) { await session.run<number>(HIDE_NOTICES); sinceHide = Date.now(); }
        const due = Math.min(frames - 1, Math.max(next, Math.floor((Date.now() - startedAt) / step)));
        await film(due);
        for (let k = next; k < due; k++) { fs.copyFileSync(frameFile(due), frameFile(k)); repeated++; }
        next = due + 1;
        progress(next);
        const wait = startedAt + next * step - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      if (repeated) log(`  ${repeated} of ${frames} frame(s) repeat the picture before them: the browser filmed slower than real time.`);
    } else {
      for (let i = 0; i < frames; i++) {
        throwIfCancelled();
        // Surveys and notices that open while filming are hidden too, twice a second of page time.
        if (i % 15 === 0) await session.run<number>(HIDE_NOTICES);
        await film(i);
        progress(i + 1);
      }
    }
    // A paywall that opened while filming covers the footage, so the take isn't kept.
    const paywall = await coveringPaywall(session.page).catch(() => undefined);
    if (paywall) throw new Error(`A paywall opened over the page while filming (“${paywall}…”). Show this source on a slide instead.`);
    if (session.releasedFrames) log(`  ${session.releasedFrames} frame(s) needed page time to run freely for a moment; script-driven effects may jump there.`);
    if (session.repeatedFrames) log(`  ${session.repeatedFrames} frame(s) repeat the previous picture: the page produced none in time.`);
  } catch (err) {
    if (!(err instanceof CancelledError)) await session.fail();
    throw err;
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
