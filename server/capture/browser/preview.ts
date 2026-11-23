import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { pageMoveProgress, pageShotMoves, type Format, type PageShot } from "../../../shared/types.js";
import type { BrowserTargetConfig } from "../../../shared/projects.js";
import type { Log } from "../provider.js";
import { CancelledError, throwIfCancelled } from "../../jobs.js";
import { openShot, shotScroll } from "./index.js";
import { highlightScroll } from "./highlight.js";
import { coveringPaywall, HIDE_NOTICES } from "./verify.js";
import type { savePageCheck } from "./checks.js";
import { PageTrace } from "./trace.js";

const jpeg = async (file: string) => {
  const picture = await loadImage(file);
  const canvas = createCanvas(picture.width, picture.height);
  canvas.getContext("2d").drawImage(picture, 0, 0);
  return canvas.encode("jpeg", 80);
};

/**
 * Opens a shot's page as a capture does and takes its first and last frame instead of filming it. Returns what the
 * browser showed at each step, and the problem that would fail the capture, if there is one.
 */
export async function previewShot(target: BrowserTargetConfig, shot: PageShot, format: Format, seconds: number, log: Log, onCheck?: typeof savePageCheck): Promise<{ trace: PageTrace; problem?: string }> {
  const trace = new PageTrace(shot);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-preview-"));
  try {
    const session = await openShot(target, shot, format, log, trace, onCheck);
    try {
      const { still, from, to } = await shotScroll(session, shot);
      const frame = async (name: "start" | "end", t: number, ms: number) => {
        throwIfCancelled();
        await session.run<number>(HIDE_NOTICES);
        const scrollY = still === undefined ? from + (to - from) * t : await session.run<number>(highlightScroll);
        const zoom = shot.zoomFrom + (shot.zoomTo - shot.zoomFrom) * t;
        const file = path.join(dir, `${name}.png`);
        await session.frame({ scrollY, zoom, focusX: shot.focus.x, focusY: shot.focus.y }, ms, file);
        // The page can be shorter than the position asked for.
        const at = await session.run<number>("window.scrollY");
        trace.add(name, { ...(await session.read()), picture: await jpeg(file) }, [`Scrolled to ${Math.round(at)} px${Math.round(scrollY) > Math.round(at) ? `; the page ends before ${Math.round(scrollY)} px` : ""}`, ...(zoom > 1 ? [`Zoom ${Number(zoom.toFixed(2))}`] : [])]);
      };
      await frame("start", 0, 33);
      if (pageShotMoves(shot)) await frame("end", pageMoveProgress(shot, seconds, seconds, Math.abs(to - from)), seconds * 1000);
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
    if (err instanceof CancelledError) throw err;
    return { trace, problem: (err as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
