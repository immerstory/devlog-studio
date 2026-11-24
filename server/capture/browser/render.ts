import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { PageCheck, PageDevice, PageShot } from "../../../shared/types.js";
import { currentJobSignal } from "../../jobs.js";
import { chromePath } from "./chrome.js";
import { coveringDialog, coveringPaywall, hideNotices, inspectPage, loadNotes, noteMoment, refuseConsent, waitForSentence, type PageMoment } from "./verify.js";
import { PAGE_TEXT, inTime, plainLines, type PageLook } from "./look.js";
import type { PageTrace } from "./trace.js";
import { AD_STYLE, HIDE_STYLE, hiddenNotes, newlyHidden, unusedSelectors } from "./hidden.js";
import { highlightScript } from "./highlight.js";
import { AD_CSS, blockAds, hideAdPleas } from "./ads.js";
import { isReplacedPage, retryReplacedPage, SCRIPT_LEFT_PAGE, ScriptError } from "./replaced-page.js";

/** CSS viewport width per device and orientation; the height follows the video's aspect ratio. */
const VIEWPORT_WIDTH: Record<PageDevice, { portrait: number; landscape: number }> = {
  phone: { portrait: 390, landscape: 844 },
  desktop: { portrait: 1280, landscape: 1440 },
};
export const PHONE_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Wording of common bot checks and access walls, matched against the page title and the start of its text. */
const CHALLENGE = /captcha|verify(ing)? (you are|you're) (human|not a (bot|robot))|are you a robot|just a moment|attention required|checking your browser|access denied|unusual traffic|bot (check|protection)/i;

/** Why the page looks like a bot check or access wall, or undefined when it looks like the real page. */
export async function blockedReason(page: Page, status?: number): Promise<string | undefined> {
  const { title, text } = await page.evaluate(() => ({ title: document.title, text: (document.body?.innerText ?? "").slice(0, 600) }));
  const challenge = CHALLENGE.test(title) || CHALLENGE.test(text);
  const statusBlock = status === 401 || status === 403 || status === 429 || status === 503;
  if (!challenge && !statusBlock) return undefined;
  return [status && statusBlock ? `HTTP ${status}` : "", title ? `“${title.slice(0, 80)}”` : ""].filter(Boolean).join(", ") || "bot check";
}

/**
 * Cuts a region given in CSS pixels out of a viewport picture rendered at `pixelsPerCss`, and scales it to the output
 * size. Fractional edges are interpolated, so a region that moves by less than a pixel moves smoothly.
 */
async function cropFrame(png: Buffer, region: { x: number; y: number; width: number; height: number }, pixelsPerCss: number, output: { width: number; height: number }): Promise<Buffer> {
  const picture = await loadImage(png);
  const canvas = createCanvas(output.width, output.height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture, region.x * pixelsPerCss, region.y * pixelsPerCss, region.width * pixelsPerCss, region.height * pixelsPerCss, 0, 0, output.width, output.height);
  return canvas.encode("png");
}

/** Consecutive frames without a picture after which filming gives up: one second at 30 fps. */
const STUCK_LIMIT = 30;

export interface PageFrame {
  /** Scroll position in CSS pixels from the top. */
  scrollY: number;
  /** 1 shows the whole viewport; 2 shows half its width and height, around the focus. */
  zoom: number;
  /** Zoom centre as fractions of the viewport. */
  focusX: number;
  focusY: number;
  /**
   * The closest zoom of the whole shot. A shot that zooms renders every frame at this one resolution and crops it
   * with sub-pixel precision, because Chrome rasterizes text differently at each scale and snaps a screenshot's clip
   * to whole device pixels, so a zoom filmed through the screenshot's own scale wobbles.
   */
  rasterZoom?: number;
}

export interface PageSession {
  page: Page;
  cdp: CDPSession;
  viewport: { width: number; height: number; scale: number };
  /** Resolves a scroll target: a number of CSS pixels, or a selector whose element is brought to the top of the view. */
  scrollOf(target: number | string): Promise<number>;
  /** Frames whose picture needed page time to run freely for a moment. */
  readonly releasedFrames: number;
  /** Frames that repeat the previous picture because the page produced none in time. */
  readonly repeatedFrames: number;
  /** Runs a synchronous expression in the page and returns its value. */
  run<T>(expression: string): Promise<T>;
  /** Advances page time by `ms` and saves a screenshot of the frame at the video's resolution. */
  frame(f: PageFrame, ms: number, file: string): Promise<void>;
  /** Plays the page for `ms` at a scroll position without taking a frame: page time, or real time for a real-time session. */
  play(scrollY: number, ms: number): Promise<void>;
  /** What the page shows now and where it is scrolled to, without a picture. The clock stays paused. */
  read(): Promise<PageLook & { scrollY: number }>;
  /** Records the failure of the session's run. The page's clock runs on from here, so nothing is filmed afterwards. */
  fail(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens a page in headless Chrome for frame-by-frame capture. The page loads and settles in real time;
 * then its clock is paused, so CSS animations, videos and timers advance exactly one frame per captured
 * frame, however long a screenshot takes. Lazy-loaded content still loads: page time waits for pending
 * network requests.
 */
export function openPage(opts: OpenPageOptions): Promise<PageSession> {
  return retryReplacedPage(() => openPageOnce(opts), opts.log);
}

type OpenPageOptions = { url: string; device: PageDevice; output: { width: number; height: number }; settleMs: number; hide: string[]; /** The target's CSS for every page, then the shot's own. */ css?: string[]; script?: string; userAgent?: string; headers?: Record<string, string>; source?: Pick<PageShot, "credit" | "expect" | "highlight">; highlight?: string; realtime?: boolean; onCheck?: (check: PageCheck) => Promise<void> | void; /** Records what the browser shows at each step. */ trace?: PageTrace; log: (l: string) => void };

async function openPageOnce(opts: OpenPageOptions): Promise<PageSession> {
  const orientation = opts.output.height > opts.output.width ? "portrait" : "landscape";
  const width = VIEWPORT_WIDTH[opts.device][orientation];
  // Rounded up, so the clip of the exact output size always fits inside the viewport.
  const height = Math.ceil((width * opts.output.height) / opts.output.width);
  const scale = opts.output.width / width;
  let browser: Browser | undefined;
  let opened: Page | undefined;
  let pausedClock: CDPSession | undefined;
  let scriptRan = false;
  opts.trace?.start();
  try {
    browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, protocolTimeout: 30_000, args: ["--lang=en-US", "--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
    opened = page;
    const agent = opts.userAgent?.trim() || (opts.device === "phone" ? PHONE_AGENT : "");
    if (agent) await page.setUserAgent(agent);
    const headers = opts.headers ?? {};
    if (Object.keys(headers).length) await page.setExtraHTTPHeaders(headers);
    // Sites read the privacy signals from script as well as from the request headers.
    const header = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
    const dnt = header("dnt");
    const gpc = header("sec-gpc");
    if (dnt !== undefined || gpc !== undefined) {
      // A string, not a function: functions compiled by the TypeScript runner reference helpers the page lacks.
      await page.evaluateOnNewDocument(
        (dnt !== undefined ? `Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => ${JSON.stringify(dnt)}, configurable: true });` : "") +
          (gpc === "1" ? `Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true, configurable: true });` : ""),
      );
    }
    await page.setViewport({ width, height, deviceScaleFactor: scale, isMobile: opts.device === "phone", hasTouch: opts.device === "phone" });
    await blockAds(page);
    opts.log(`Opening ${opts.url} (${opts.device}, ${width}×${height})…`);
    const response = await page.goto(opts.url, { waitUntil: "load", timeout: 60_000 });
    // Busy pages (endless image loading, chat widgets, analytics) never go quiet, so quiet is waited for briefly only.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => {});
    const moments: PageMoment[] = [];
    await noteMoment(page, moments, "when the page loaded");
    await opts.trace?.step(page, "loaded", loadNotes(opts.url, page.url(), response));
    const refused = await refuseConsent(page);
    if (refused !== undefined) {
      opts.log("Refused optional cookies in the consent dialog.");
      await noteMoment(page, moments, "after the cookie choice");
      await opts.trace?.step(page, "cookies", [`Clicked “${refused}”`]);
    }
    await opts.trace?.notes(() => newlyHidden(page));
    const notices = await hideNotices(page).catch(() => 0);
    const pleas = await hideAdPleas(page).catch(() => 0);
    if (pleas) opts.log(`Hid ${pleas} message(s) in empty ad slots.`);
    if (notices) opts.log(`Hid ${notices} privacy notice(s) over the page.`);
    // Hidden elements come before the check, so a banner the shot hides doesn't count as covering the page.
    const hide = opts.hide.filter((s) => s.trim());
    const rules = await page.addStyleTag({ content: `html { scroll-behavior: auto !important; }\n${AD_CSS}` });
    await rules.evaluate((el, mark) => el.setAttribute("data-devlog", mark), AD_STYLE);
    // Each selector has a style element of its own, because an invalid one takes in the rules after it.
    for (const selector of hide) {
      const rule = await page.addStyleTag({ content: `${selector} { display: none !important; }` });
      await rule.evaluate((el, mark) => el.setAttribute("data-devlog", mark), HIDE_STYLE);
    }
    await noteMoment(page, moments, "after notices, ads and the elements under Hide were hidden");
    if (opts.trace) {
      const notes = await opts.trace.notes(() => hiddenNotes(page, hide));
      if (notes.length || notices || pleas || hide.length) await opts.trace.step(page, "hidden", notes);
    }
    // A shot's script can reveal the sentence to highlight, for example by opening a tab, so with a script the
    // sentence is looked for once the script has run (below), not in the page as it loads.
    const deferHighlight = !!opts.script?.trim() && !!opts.source?.highlight?.trim();
    const check = await inspectPage(page, opts.url, response, deferHighlight ? { ...opts.source, highlight: undefined } : opts.source ?? {}, moments);
    if (deferHighlight) check.highlight = opts.source!.highlight!.trim();
    await opts.onCheck?.(check);
    if (check.finalUrl) opts.log(`The page is now at ${check.finalUrl}.`);
    if (!check.ok) {
      if (check.problem?.startsWith("The site blocked")) throw new Error(`${check.problem} Record the page yourself and upload it as a material, or film a page that allows automated browsers.`);
      // A text the page showed earlier in the run says the link and the text are right.
      throw new Error(check.lost ? check.problem : `${check.problem} Check the link${check.expect ? " and the expected text" : ""} of this shot.`);
    }
    // Custom CSS goes in separate style elements, so a mistake in it cannot disable the rules above.
    const styled: string[] = [];
    for (const [i, custom] of (opts.css ?? []).entries()) {
      if (!custom.trim()) continue;
      await page.addStyleTag({ content: custom });
      // The target's CSS is for every page, so rules that match nothing on this one are expected.
      const own = i === opts.css!.length - 1;
      styled.push(own ? "Added the shot's CSS" : "Added the target's CSS", ...((own && (await opts.trace?.notes(() => unusedSelectors(page, custom)))) || []));
    }
    // The shot's own script runs as a function body; an error in it fails the shot with its message.
    if (opts.script?.trim()) {
      scriptRan = true;
      try {
        await page.evaluate(`(async () => {\n${opts.script}\n})()`);
      } catch (err) {
        throw new ScriptError(isReplacedPage(err) ? SCRIPT_LEFT_PAGE : `The shot's script failed: ${(err as Error).message.split("\n")[0]}`);
      }
      styled.push("Ran the script");
    }
    await new Promise((r) => setTimeout(r, Math.max(0, opts.settleMs)));
    // Some consent dialogs return after a reload or open late, so the last look before filming refuses and hides again.
    const refusedLate = await refuseConsent(page);
    if (refusedLate !== undefined) {
      opts.log("Refused optional cookies in a consent dialog that opened late.");
      styled.push(`Clicked “${refusedLate}” in a dialog that opened late`);
    }
    // Once the clock is paused, a sentence the page shows late can't appear.
    if (opts.highlight?.trim()) await waitForSentence(page, opts.highlight);
    await hideNotices(page).catch(() => 0);
    if (styled.length) await opts.trace?.step(page, "styled", [...new Set(styled)]);
    const late = await coveringDialog(page).catch(() => undefined);
    if (late) throw new Error(`A cookie dialog covers the page (“${late}…”). Hide it with a CSS selector under Hide.`);
    const paywall = await coveringPaywall(page).catch(() => undefined);
    if (paywall) throw new Error(`A paywall covers the page (“${paywall}…”). Show this source on a slide instead.`);
    const cdp = await page.createCDPSession();
    // Requests in flight, by start time; long-lived ones (streams, long polling, live reload) are ignored.
    const inFlight = new Map<string, number>();
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (e) => inFlight.set(e.requestId, Date.now()));
    cdp.on("Network.loadingFinished", (e) => inFlight.delete(e.requestId));
    cdp.on("Network.loadingFailed", (e) => inFlight.delete(e.requestId));
    const freshRequests = () => [...inFlight.values()].some((started) => Date.now() - started < 2000);
    // A real-time session leaves the page on its own clock, so its streamed videos load and play.
    if (!opts.realtime) {
      await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
      pausedClock = cdp;
    }

    // While page time is paused, promises never settle, so expressions run synchronously through the protocol.
    const run = async <T>(expression: string): Promise<T> => {
      const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      return res.result.value as T;
    };
    // CSS animations and transitions run on the compositor in real time, outside page time. Each one is
    // paused when first seen and set to its time in the clip on every frame; videos are stepped the same way.
    await run(`window.__devlogClock = { t: 0, base: new WeakMap() };
      window.__devlogStep = (ms) => {
        const c = window.__devlogClock;
        const before = c.t;
        c.t += ms;
        for (const a of document.getAnimations()) {
          // Scroll-driven animations follow the scroll position, which the frames set, not page time.
          if (a.timeline && !(a.timeline instanceof DocumentTimeline)) continue;
          if (!c.base.has(a)) { c.base.set(a, (Number(a.currentTime) || 0) - before); a.pause(); }
          a.currentTime = c.base.get(a) + c.t;
        }
        for (const v of document.querySelectorAll("video")) {
          if (!c.base.has(v)) { c.base.set(v, v.currentTime - before / 1000); v.pause(); }
          // A looping video starts over at its end, as it would on the page; others hold their last picture.
          const at = c.base.get(v) + c.t / 1000;
          v.currentTime = v.loop && v.duration > 0 && isFinite(v.duration) ? at % v.duration : at;
        }
      };
      true`);
    // The marker's animation starts on the paused clock, so the first frame shows it at its very start.
    if (opts.highlight?.trim() && !(await run<boolean>(highlightScript(opts.highlight)))) {
      throw new Error(`The page doesn't show the sentence to highlight (“${opts.highlight.trim().slice(0, 80)}”). Copy it from the page exactly.`);
    }
    /** Resolves true when the page has run `ms` of page time, false after `timeoutMs` of real time. */
    const budgetExpired = (timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const done = (expired: boolean) => {
          clearTimeout(timer);
          cdp.off("Emulation.virtualTimeBudgetExpired", onExpired);
          resolve(expired);
        };
        const onExpired = () => done(true);
        const timer = setTimeout(() => done(false), timeoutMs);
        cdp.on("Emulation.virtualTimeBudgetExpired", onExpired);
      });
    const advance = async (ms: number) => {
      // Page time waits for fresh requests, so lazy-loaded content appears in time. Requests older than
      // two seconds are long-lived connections that would hold the clock forever, so they are ignored,
      // and a fresh request gets at most 1.5 s.
      let expired: Promise<boolean>;
      if (freshRequests()) {
        expired = budgetExpired(1500);
        await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pauseIfNetworkFetchesPending", budget: ms });
        if (await expired) return;
      }
      expired = budgetExpired(5000);
      await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: ms });
      await expired;
    };

    const scrollTo = (y: number) => run(`window.scrollTo(0, ${Number(y) || 0})`);
    const play = async (scrollY: number, ms: number) => {
      await scrollTo(scrollY);
      if (opts.realtime) return void (await new Promise((r) => setTimeout(r, ms)));
      await advance(ms);
      await run(`window.__devlogStep(${ms})`);
    };

    let lastFrame: Buffer | undefined;
    let stuck = 0;
    let repeated = 0;
    let released = 0;
    return {
      page,
      cdp,
      run,
      get repeatedFrames() { return repeated; },
      get releasedFrames() { return released; },
      viewport: { width, height, scale },
      async scrollOf(target) {
        if (typeof target === "number") return Math.max(0, target);
        const trimmed = target.trim();
        if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
        const y = await run<number | null>(`(() => { const el = document.querySelector(${JSON.stringify(trimmed)}); return el ? el.getBoundingClientRect().top + window.scrollY : null; })()`);
        if (y === null) throw new Error(`Nothing on the page matches “${trimmed}”.`);
        return Math.max(0, y);
      },
      async frame(f, ms, file) {
        await (opts.realtime ? scrollTo(f.scrollY) : play(f.scrollY, ms));
        const zoom = Math.max(1, f.zoom);
        const w = opts.output.width / scale / zoom;
        const h = opts.output.height / scale / zoom;
        const x = Math.min(width - w, Math.max(0, f.focusX * width - w / 2));
        const y = Math.min(height - h, Math.max(0, f.focusY * height - h / 2));
        // Clip coordinates are document coordinates in CSS pixels; the scale renders the region at the
        // video's resolution (the clip scale does not include the device scale factor).
        const scroll = await run<{ x: number; y: number }>("({ x: window.scrollX, y: window.scrollY })");
        // On some pages Chrome stops producing pictures while page time is paused, and the screenshot waits
        // forever. Letting page time run freely releases it; CSS animations and videos keep their exact
        // timing because each frame sets them, only script-driven effects may jump at that frame. If even
        // that does not help, the frame repeats the previous picture, and a page that stays stuck fails.
        const raster = f.rasterZoom !== undefined && f.rasterZoom > 1 ? Math.max(zoom, f.rasterZoom) : undefined;
        const clip = raster ? { x: scroll.x, y: scroll.y, width, height, scale: raster * scale } : { x: scroll.x + x, y: scroll.y + y, width: w, height: h, scale: zoom * scale };
        const request = cdp.send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
        request.catch(() => {});
        const within = (ms: number) => Promise.race([request, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
        let shot = await within(1500);
        if (!shot && !opts.realtime) {
          await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
          shot = await within(lastFrame ? 5000 : 20_000);
          await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
          if (shot) released++;
        }
        let image: Buffer;
        if (shot) {
          image = Buffer.from(shot.data, "base64");
          if (raster) image = await cropFrame(image, { x, y, width: w, height: h }, raster * scale, opts.output);
          lastFrame = image;
          stuck = 0;
        } else {
          if (!lastFrame) throw new Error("The page produced no picture to film.");
          if (++stuck > STUCK_LIMIT) throw new Error(`The page stopped producing pictures for ${stuck} frames in a row while being filmed.`);
          image = lastFrame;
          repeated++;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, image);
      },
      play,
      async read() {
        const now = await inTime(run<{ title: string; text: string; scrollY: number }>(`({ ...${PAGE_TEXT}, scrollY: window.scrollY })`), Date.now() + 5000);
        if (!now) throw new Error("The page stopped answering.");
        return { pageUrl: page.url(), title: now.title.slice(0, 200), text: plainLines(now.text), scrollY: now.scrollY };
      },
      fail: async () => opts.trace?.fail(page, pausedClock),
      async close() {
        await browser?.close();
      },
    };
  } catch (err) {
    // A cancelled run shows nothing, so it ends without a look.
    if (!currentJobSignal()?.aborted) await opts.trace?.fail(opened, pausedClock);
    await browser?.close().catch(() => {});
    // After a shot's script ran, a page that is gone counts as the script leaving it, so it isn't opened again.
    throw scriptRan && isReplacedPage(err) ? new ScriptError(SCRIPT_LEFT_PAGE) : err;
  }
}
