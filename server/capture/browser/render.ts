import fs from "node:fs";
import path from "node:path";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { Browser as BrowserKind, computeExecutablePath, install } from "@puppeteer/browsers";
import { CACHE_DIR } from "../../config.js";
import type { PageDevice } from "../../../shared/types.js";

/** The Chrome build this version of Puppeteer is made for. */
const CHROME = { browser: BrowserKind.CHROMEHEADLESSSHELL, buildId: "155.0.8059.39", cacheDir: path.join(CACHE_DIR, "chrome") };

/** Path of the Chrome headless shell, downloaded on first use. */
export async function chromePath(): Promise<string> {
  const executable = computeExecutablePath(CHROME);
  if (!fs.existsSync(executable)) await install(CHROME);
  return executable;
}

/** CSS viewport width per device and orientation; the height follows the video's aspect ratio. */
const VIEWPORT_WIDTH: Record<PageDevice, { portrait: number; landscape: number }> = {
  phone: { portrait: 390, landscape: 844 },
  desktop: { portrait: 1280, landscape: 1440 },
};
const PHONE_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

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
  close(): Promise<void>;
}

/**
 * Opens a page in headless Chrome for frame-by-frame capture. The page loads and settles in real time;
 * then its clock is paused, so CSS animations, videos and timers advance exactly one frame per captured
 * frame, however long a screenshot takes. Lazy-loaded content still loads: page time waits for pending
 * network requests.
 */
export async function openPage(opts: { url: string; device: PageDevice; output: { width: number; height: number }; settleMs: number; hide: string[]; css?: string[]; userAgent?: string; headers?: Record<string, string>; log: (l: string) => void }): Promise<PageSession> {
  const orientation = opts.output.height > opts.output.width ? "portrait" : "landscape";
  const width = VIEWPORT_WIDTH[opts.device][orientation];
  // Rounded up, so the clip of the exact output size always fits inside the viewport.
  const height = Math.ceil((width * opts.output.height) / opts.output.width);
  const scale = opts.output.width / width;
  let browser: Browser | undefined;
  try {
    browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, protocolTimeout: 30_000, args: ["--hide-scrollbars", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage();
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
    opts.log(`Opening ${opts.url} (${opts.device}, ${width}×${height})…`);
    const response = await page.goto(opts.url, { waitUntil: "load", timeout: 60_000 });
    // Busy pages (endless image loading, chat widgets, analytics) never go quiet, so quiet is waited for briefly only.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => {});
    const blocked = await blockedReason(page, response?.status());
    if (blocked) throw new Error(`The site blocked the automated browser (${blocked}). Record the page yourself and upload it as a material, or film a page that allows automated browsers.`);
    const css = [
      "html { scroll-behavior: auto !important; }",
      ...opts.hide.filter((s) => s.trim()).map((s) => `${s} { display: none !important; }`),
    ].join("\n");
    await page.addStyleTag({ content: css });
    // Custom CSS goes in separate style elements, so a mistake in it cannot disable the rules above.
    for (const custom of opts.css ?? []) if (custom.trim()) await page.addStyleTag({ content: custom });
    await new Promise((r) => setTimeout(r, Math.max(0, opts.settleMs)));
    const cdp = await page.createCDPSession();
    // Requests in flight, by start time; long-lived ones (streams, long polling, live reload) are ignored.
    const inFlight = new Map<string, number>();
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (e) => inFlight.set(e.requestId, Date.now()));
    cdp.on("Network.loadingFinished", (e) => inFlight.delete(e.requestId));
    cdp.on("Network.loadingFailed", (e) => inFlight.delete(e.requestId));
    const freshRequests = () => [...inFlight.values()].some((started) => Date.now() - started < 2000);
    await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });

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
          if (!c.base.has(a)) { c.base.set(a, (Number(a.currentTime) || 0) - before); a.pause(); }
          a.currentTime = c.base.get(a) + c.t;
        }
        for (const v of document.querySelectorAll("video")) {
          if (!c.base.has(v)) { c.base.set(v, v.currentTime - before / 1000); v.pause(); }
          v.currentTime = c.base.get(v) + c.t / 1000;
        }
      };
      true`);
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
        await run(`window.scrollTo(0, ${Number(f.scrollY) || 0})`);
        await advance(ms);
        await run(`window.__devlogStep(${ms})`);
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
        const request = cdp.send("Page.captureScreenshot", { format: "png", clip: { x: scroll.x + x, y: scroll.y + y, width: w, height: h, scale: zoom * scale }, captureBeyondViewport: false });
        request.catch(() => {});
        const within = (ms: number) => Promise.race([request, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
        let shot = await within(1500);
        if (!shot) {
          await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
          shot = await within(lastFrame ? 5000 : 20_000);
          await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
          if (shot) released++;
        }
        let image: Buffer;
        if (shot) {
          image = Buffer.from(shot.data, "base64");
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
      async close() {
        await browser?.close();
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    throw err;
  }
}
