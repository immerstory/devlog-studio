import type { CDPSession, Page } from "puppeteer-core";

/** What a browser shows at one moment. */
export interface PageLook {
  /** The address the browser is at, which redirects can change. */
  pageUrl: string;
  title: string;
  /** The visible text, shortened when very long. */
  text: string;
  /** A JPEG of the browser's view. Absent when the page produced none in time. */
  picture?: Buffer;
}

/** A page that hangs must not hold up the run that looks at it for longer than this. */
const LOOK_MS = 5000;
/** Long enough for an article, short enough to store with every shot. */
const MAX_TEXT = 20_000;

/** The result of `work`, or undefined when it fails or isn't there in time. */
const inTime = <T>(work: Promise<T>, until: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now())); });
  return Promise.race([work.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/**
 * Looks at a page without changing it. Undefined when the browser shows no page, for example when the address didn't
 * load. A session with a paused clock passes its protocol connection: its clock runs on from here, because a page with
 * a paused clock may produce no picture.
 */
export async function lookAt(page: Page, pausedClock?: CDPSession): Promise<PageLook | undefined> {
  const pageUrl = page.url();
  if (!/^https?:/.test(pageUrl)) return undefined;
  const until = Date.now() + LOOK_MS;
  if (pausedClock) await inTime(pausedClock.send("Emulation.setVirtualTimePolicy", { policy: "advance" }), until);
  const read = await inTime(page.evaluate(`({ title: document.title, text: document.body ? document.body.innerText : "" })`) as Promise<{ title: string; text: string }>, until);
  const picture = await inTime(page.screenshot({ type: "jpeg", quality: 75, captureBeyondViewport: false }), until);
  if (!read && !picture) return undefined;
  const text = (read?.text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return { pageUrl, title: (read?.title ?? "").slice(0, 200), text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text, ...(picture ? { picture: Buffer.from(picture) } : {}) };
}
