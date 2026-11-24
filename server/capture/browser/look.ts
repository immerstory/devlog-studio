import type { CDPSession, Page } from "puppeteer-core";

/** What a browser shows at one moment. */
export interface PageLook {
  /** The address the browser is at, which redirects can change. */
  pageUrl: string;
  title: string;
  /** The visible text. */
  text: string;
  /** A JPEG of the browser's view. Absent when the page produced none in time. */
  picture?: Buffer;
}

/**
 * A page's title and the text a reader can see, as an expression. A hidden body has no visible text; its innerText
 * would be everything in it, scripts included.
 */
export const PAGE_TEXT = `({ title: document.title, text: document.body && getComputedStyle(document.body).display !== "none" ? document.body.innerText : "" })`;

/** A page that hangs must not hold up the run that looks at it for longer than this. */
const LOOK_MS = 5000;
/** A page that produced no picture in time is only read, which a page that works does at once. */
const READ_MS = 1000;

/** The result of `work`, or undefined when it fails or isn't there in time. */
export const inTime = <T>(work: Promise<T>, until: number): Promise<T | undefined> => {
  let timer: NodeJS.Timeout;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, until - Date.now())); });
  return Promise.race([work.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/** A page's text with one line per block and single spaces. */
export const plainLines = (text: string) => text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/**
 * Looks at a page without changing it. Undefined when the browser shows no page, for example when the address didn't
 * load. A session with a paused clock passes its protocol connection: its clock runs on from here, because a page with
 * a paused clock may produce no picture. Without `pictures`, it only reads the page.
 */
export async function lookAt(page: Page, pausedClock?: CDPSession, pictures = true): Promise<PageLook | undefined> {
  const pageUrl = page.url();
  if (!/^https?:/.test(pageUrl)) return undefined;
  const until = Date.now() + (pictures ? LOOK_MS : READ_MS);
  if (pausedClock) await inTime(pausedClock.send("Emulation.setVirtualTimePolicy", { policy: "advance" }), until);
  const read = await inTime(page.evaluate(PAGE_TEXT) as Promise<{ title: string; text: string }>, until);
  const picture = pictures ? await inTime(page.screenshot({ type: "jpeg", quality: 75, captureBeyondViewport: false }), until) : undefined;
  if (!read && !picture) return undefined;
  return { pageUrl, title: (read?.title ?? "").slice(0, 200), text: plainLines(read?.text ?? ""), ...(picture ? { picture: Buffer.from(picture) } : {}) };
}
