import puppeteer, { type HTTPResponse, type Page } from "puppeteer-core";
import type { PageCheck, PageDevice, PageShot } from "../../../shared/types.js";
import { blockedReason, chromePath, PHONE_AGENT } from "./render.js";
import { blockAds } from "./ads.js";

/** Text as a reader sees it: case, spacing, dashes and the kind of quote mark don't matter, since articles and their quotes often differ there. */
export const readable = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/[‘’‚′`´“”„″"]/g, "'").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();

/** How long a check reads a page before it looks for a paywall that opens late. */
const LATE_PAYWALL_MS = 3000;
/** How long a check waits for the expected text to appear. */
const EXPECT_WAIT_MS = 8000;

const pathOf = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
const hostOf = (url: URL) => url.hostname.replace(/^www\./, "");

/** The page a link leads to differs from the one it names: another site, or another path on it. */
export function movedTo(requested: string, final: string): string | undefined {
  try {
    const a = new URL(requested), b = new URL(final);
    return hostOf(a) !== hostOf(b) || pathOf(a) !== pathOf(b) ? b.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Labels of consent buttons that refuse everything optional, in English and German. */
const REFUSE = /^(reject|decline|deny|refuse)( all| optional| non-essential| additional)?( cookies)?$|^(only|use) (necessary|essential)( cookies)?( only)?$|^(necessary|essential) (cookies )?only$|^(alle )?ablehnen$|^nur (notwendige|erforderliche|essenzielle)( cookies)?( akzeptieren| zulassen)?$/i;

/**
 * Refuses optional cookies the way a visitor would, by clicking the consent dialog's refuse button, also inside the
 * consent frames many sites use. Some sites reload after the choice, so the page settles before anything reads it.
 * Returns whether a button was clicked.
 */
export async function refuseConsent(page: Page): Promise<boolean> {
  let clicked = false;
  const reload = page.waitForNavigation({ waitUntil: "load", timeout: 4000 }).catch(() => null);
  for (const frame of page.frames()) {
    if (clicked) break;
    const hit = await frame.evaluate((source: string) => {
      const pattern = new RegExp(source, "i");
      const candidates = [...document.querySelectorAll<HTMLElement>("button, [role=button], a[href='#'], input[type=button], input[type=submit]")];
      const button = candidates.find((el) => {
        const label = (el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && pattern.test(label);
      });
      button?.click();
      return !!button;
    }, REFUSE.source).catch(() => false);
    clicked ||= hit;
  }
  if (!clicked) return false;
  await reload;
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  return true;
}

/**
 * Visible privacy and cookie notices that float over the page: fixed or sticky, short, marked as a dialog, banner or
 * notice, and about cookies, consent or privacy. A page whose whole content sits in a fixed container isn't one.
 * A string, not a function: functions compiled by the TypeScript runner reference helpers the page lacks.
 */
const NOTICES = `[...document.querySelectorAll("body *")].flatMap((el) => {
  const s = getComputedStyle(el);
  if ((s.position !== "fixed" && s.position !== "sticky") || s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return [];
  const text = el.innerText || "";
  if (text.length > 2500 || !/cookie|consent|privacy|datenschutz|einwilligung/i.test(text)) return [];
  const marked = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || /cookie|consent|privacy|cmp|gdpr|banner|notice|modal|dialog/i.test(el.id + " " + el.className);
  if (!marked) return [];
  const b = el.getBoundingClientRect();
  const visible = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
  return visible > 0 ? [{ el, share: visible / (innerWidth * innerHeight), text: text.replace(/\\s+/g, " ").trim() }] : [];
})`;

/** Hides the privacy notices still floating over the page after the choice. Hiding agrees to nothing. Returns how many. */
export const hideNotices = (page: Page) => page.evaluate(`(() => { const n = ${NOTICES}; for (const x of n) x.el.style.setProperty("display", "none", "important"); return n.length; })()`) as Promise<number>;

/**
 * Consent walls in a frame: a fixed container named for consent that holds an iframe and covers much of the view. The
 * page can't read the frame's text, and such a wall often refuses only against payment, so it is never hidden.
 */
const CONSENT_FRAMES = `[...document.querySelectorAll("body *")].flatMap((el) => {
  const s = getComputedStyle(el);
  if (s.position !== "fixed" || s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return [];
  if (!/sp_message|consent|cookie|cmp|gdpr|privacy/i.test(el.id + " " + el.className) || !el.querySelector("iframe")) return [];
  const b = el.getBoundingClientRect();
  const visible = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
  return visible >= innerWidth * innerHeight * 0.3 ? [el] : [];
})`;

/** Paywalls that float over much of the view. They are reported, never hidden. */
const PAYWALLS = `[...document.querySelectorAll("body *")].find((el) => {
  const s = getComputedStyle(el);
  if ((s.position !== "fixed" && s.position !== "sticky") || s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
  const text = el.innerText || "";
  if (text.length > 1500 || !/subscri|continue reading|sign in to (read|continue)|abonn|weiterlesen mit|paywall/i.test(text)) return false;
  const b = el.getBoundingClientRect();
  const visible = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
  return visible >= innerWidth * innerHeight * 0.25;
})`;

/** The start of a paywall's text that covers much of the view, if one does. */
export const coveringPaywall = (page: Page) =>
  page.evaluate(`(() => { const el = ${PAYWALLS}; return el ? el.innerText.replace(/\\s+/g, " ").trim().slice(0, 60) : undefined; })()`) as Promise<string | undefined>;

/** The text of a privacy notice or consent wall that still covers much of the view, if one does. */
export const coveringDialog = (page: Page) =>
  page.evaluate(`(() => {
    const n = ${NOTICES}.find((x) => x.share >= 0.3);
    if (n) return n.text.slice(0, 60);
    return ${CONSENT_FRAMES}.length ? "a consent wall in a frame" : undefined;
  })()`) as Promise<string | undefined>;

/** A shot that shows a source: a redirect then means the article moved, and the shot fails. */
export const isSourceShot = (shot: Pick<PageShot, "credit" | "expect">) => !!(shot.credit?.trim() || shot.expect?.trim());

/**
 * What a loaded page shows compared with what the shot expects. An error status always fails. For a source shot,
 * a redirect to another page and a missing expected text fail too.
 */
export async function inspectPage(page: Page, requested: string, response: HTTPResponse | null, shot: Pick<PageShot, "credit" | "expect" | "highlight">): Promise<PageCheck> {
  const status = response?.status();
  const expect = shot.expect?.trim();
  const read = () => page.evaluate(`({ title: document.title, text: document.body ? document.body.innerText : "" })`) as Promise<{ title: string; text: string }>;
  const shows = (p: { title: string; text: string }) => readable(`${p.title}\n${p.text}`).includes(readable(expect ?? ""));
  let shown = await read().catch(() => ({ title: "", text: "" }));
  // A page that reloads after the consent choice, or renders late, gets a few seconds to show the text.
  for (let waited = 0; expect && !shows(shown) && waited < EXPECT_WAIT_MS; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    shown = await read().catch(() => shown);
  }
  const { title, text } = shown;
  const finalUrl = page.url();
  const found = expect ? shows(shown) : undefined;
  const highlight = shot.highlight?.trim();
  const highlightFound = highlight ? readable(`${title}
${text}`).includes(readable(highlight)) : undefined;
  const moved = movedTo(requested, finalUrl);
  const blocked = await blockedReason(page, status);
  const dialog = await coveringDialog(page).catch(() => undefined);
  const paywall = await coveringPaywall(page).catch(() => undefined);
  const problem = blocked ? `The site blocked the automated browser (${blocked}).`
    : dialog ? `A cookie dialog still covers the page (“${dialog}…”). Hide it with a CSS selector under Hide.`
    : paywall ? `A paywall covers the page (“${paywall}…”). Show this source on a slide instead.`
    : status && status >= 400 ? `The page answered HTTP ${status}.`
    : moved && isSourceShot(shot) ? `The link now leads to ${moved}.`
    : found === false ? `The page doesn't show “${expect}”.`
    : highlightFound === false ? `The page doesn't show the sentence to highlight (“${highlight}”).`
    : undefined;
  return { url: requested, checkedAt: new Date().toISOString(), ok: !problem, ...(status ? { status } : {}), ...(finalUrl !== requested ? { finalUrl } : {}), title: title.slice(0, 200), ...(expect ? { expect, found } : {}), ...(highlight ? { highlight } : {}), ...(problem ? { problem } : {}) };
}

/** Opens a page only to check it, without filming. A page that doesn't load is a failed check, not an error. */
export async function checkPage(url: string, shot: Pick<PageShot, "credit" | "expect" | "highlight">, opts: { userAgent?: string; headers?: Record<string, string>; device?: PageDevice } = {}): Promise<PageCheck> {
  const browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, protocolTimeout: 30_000, args: ["--hide-scrollbars", "--mute-audio"] });
  try {
    const page = await browser.newPage();
    // The page is checked as the shot films it: sites show phones other banners and paywalls than desktops.
    const phone = opts.device === "phone";
    const agent = opts.userAgent?.trim() || (phone ? PHONE_AGENT : "");
    if (agent) await page.setUserAgent(agent);
    if (opts.headers && Object.keys(opts.headers).length) await page.setExtraHTTPHeaders(opts.headers);
    await page.setViewport(phone ? { width: 390, height: 694, isMobile: true, hasTouch: true } : { width: 1280, height: 900 });
    await blockAds(page);
    const response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => {});
    await refuseConsent(page);
    await hideNotices(page).catch(() => 0);
    const check = await inspectPage(page, url, response, shot);
    if (!check.ok) return check;
    // Metered paywalls often open only after reading or scrolling for a moment.
    await page.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight / 3)`);
    await new Promise((r) => setTimeout(r, LATE_PAYWALL_MS));
    const paywall = await coveringPaywall(page).catch(() => undefined);
    return paywall ? { ...check, ok: false, problem: `A paywall covers the page (“${paywall}…”). Show this source on a slide instead.` } : check;
  } catch (err) {
    return { url, checkedAt: new Date().toISOString(), ok: false, problem: `The page didn't load: ${(err as Error).message}`, ...(shot.expect?.trim() ? { expect: shot.expect.trim() } : {}) };
  } finally {
    await browser.close().catch(() => {});
  }
}
