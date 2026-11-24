import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Format, PageShot } from "../../../shared/types.js";
import type { BrowserTargetConfig } from "../../../shared/projects.js";
import type { Log } from "../provider.js";
import { CancelledError, currentJobSignal, throwIfCancelled } from "../../jobs.js";
import { openShot, shotPath } from "./index.js";
import { coveringPaywall, HIDE_NOTICES } from "./verify.js";
import type { savePageCheck } from "./checks.js";
import { PageTrace } from "./trace.js";

/** Frames between two looks for notices, as while filming. */
const HIDE_EVERY = 15;

/** Frames between two that are drawn, unless the page scrolls far in between. Drawing every frame would take most of a preview's time. */
const DRAW_EVERY = 5;

const jpeg = async (file: string) => {
  const picture = await loadImage(file);
  const canvas = createCanvas(picture.width, picture.height);
  canvas.getContext("2d").drawImage(picture, 0, 0);
  return canvas.encode("jpeg", 80);
};

/**
 * Opens a shot's page and plays the shot frame by frame as a capture does, because content can load on the way, but
 * takes only the first and the last frame. Returns what the browser showed at each step, and the problem that would fail the capture, if there is one.
 */
export async function previewShot(target: BrowserTargetConfig, shot: PageShot, format: Format, length: { frames: number; fps: number }, log: Log, onCheck?: typeof savePageCheck): Promise<{ trace: PageTrace; problem?: string }> {
  const trace = new PageTrace(shot);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-preview-"));
  try {
    const session = await openShot(target, shot, format, log, trace, onCheck);
    try {
      const shown = await shotPath(session, shot, length);
      const take = async (name: "start" | "end", i: number) => {
        throwIfCancelled();
        const frame = await shown.frame(i);
        const file = path.join(dir, `${name}.png`);
        await session.frame(frame, shown.step, file);
        const { scrollY, ...look } = await session.read();
        const at = Math.round(scrollY), wanted = Math.round(frame.scrollY);
        trace.add(name, { ...look, picture: await jpeg(file) }, [`Scrolled to ${at} px${wanted > at ? `; the page ends before ${wanted} px` : ""}`, ...(frame.zoom > 1 ? [`Zoom ${Number(frame.zoom.toFixed(2))}`] : [])]);
      };
      const last = shown.frames - 1;
      await session.run<number>(HIDE_NOTICES);
      await take("start", 0);
      const startedAt = Date.now();
      let drawn = (await shown.frame(0)).scrollY;
      for (let i = 1; i <= last; i++) {
        throwIfCancelled();
        if (i % HIDE_EVERY === 0) await session.run<number>(HIDE_NOTICES);
        if (i === last) { await take("end", last); break; }
        const { scrollY } = await shown.frame(i);
        // Content that loads when it comes into view waits for a drawn frame, so none of the page is scrolled past undrawn.
        const draw = i % DRAW_EVERY === 0 || Math.abs(scrollY - drawn) >= session.viewport.height / 2;
        if (draw) drawn = scrollY;
        // In real time, each frame is shown until the next one is due.
        await session.play(scrollY, shot.realtime ? Math.max(0, startedAt + i * shown.step - Date.now()) : shown.step, draw);
      }
      const paywall = await coveringPaywall(session.page).catch(() => undefined);
      if (paywall) throw new Error(`A paywall covers the page (“${paywall}…”). Show this source on a slide instead.`);
    } catch (err) {
      if (!(err instanceof CancelledError)) await session.fail();
      throw err;
    } finally {
      await session.close();
    }
    return { trace };
  } catch (err) {
    if (err instanceof CancelledError || currentJobSignal()?.aborted) throw err;
    return { trace, problem: (err as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
