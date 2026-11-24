import puppeteer, { type HTTPResponse, type Page } from "puppeteer-core";
import type { PageCheck, PageDevice, PageShot } from "../../../shared/types.js";
import { blockedReason, PHONE_AGENT } from "./render.js";
import { chromePath } from "./chrome.js";
import { blockAds } from "./ads.js";
import { PAGE_TEXT } from "./look.js";
import type { PageTrace } from "./trace.js";
import { hiddenNotes, newlyHidden } from "./hidden.js";
import { isReplacedPage, REPLACED_PAGE, ReplacedPageError, retryReplacedPage } from "./replaced-page.js";

/** Text as a reader sees it: case, spacing, dashes and the kind of quote mark don't matter, since articles and their quotes often differ there. */
export const readable = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/[‘’‚′`´“”„″"]/g, "'").replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();

/** How long a check reads a page before it looks for a paywall that opens late. */
const LATE_PAYWALL_MS = 3000;
/** How long a check waits for the expected text and the sentence to highlight to appear. */
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

/**
 * A redirect that means the article is gone: to another site, or to a homepage. Other redirects, such as one that adds
 * a language to the path, keep the page; the expected text still checks that it shows the article.
 */
export function lostPage(requested: string, final: string): string | undefined {
  try {
    const a = new URL(requested), b = new URL(final);
    const home = pathOf(a) !== "/" && /^\/([a-z]{2}([-_][a-z]{2})?\/?)?$/i.test(pathOf(b));
    return hostOf(a) !== hostOf(b) || home ? b.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Labels of consent buttons that refuse everything optional, in English and German. */
const REFUSE = /^(reject|decline|deny|refuse)( all| optional| non-essential| additional)?( cookies)?$|^(only|use) (necessary|essential)( cookies)?( only)?$|^(necessary|essential) (cookies )?only$|^(alle )?ablehnen$|^nur (notwendige|erforderliche|essenzielle)( cookies)?( akzeptieren| zulassen)?$/i;

/**
 * Refuses optional cookies the way a visitor would, by clicking the consent dialog's refuse button, also inside the
 * consent frames many sites use. Some sites reload after the choice, so the page settles before anything reads it.
 * Returns the label of the button it clicked.
 */
export async function refuseConsent(page: Page): Promise<string | undefined> {
  let clicked: string | undefined;
  const reload = page.waitForNavigation({ waitUntil: "load", timeout: 4000 }).catch(() => null);
  for (const frame of page.frames()) {
    if (clicked) break;
    const hit = await frame.evaluate((source: string) => {
      const pattern = new RegExp(source, "i");
      const candidates = [...document.querySelectorAll<HTMLElement>("button, [role=button], a[href='#'], input[type=button], input[type=submit]")];
      const labels = candidates.map((el) => (el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim());
      const i = candidates.findIndex((el, at) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && pattern.test(labels[at]);
      });
      candidates[i]?.click();
      return labels[i];
    }, REFUSE.source).catch(() => undefined);
    clicked ??= hit;
  }
  if (clicked === undefined) return undefined;
  await reload;
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
  return clicked;
}

/**
 * Visible notices that float over the page: fixed or sticky and short. A modal dialog counts whatever it says, because
 * it is never the page's content; other floating elements count when they are marked as a banner or notice and are
 * about cookies, consent, privacy, or the country and language the site suggests. A page whose whole content sits in
 * a fixed container isn't one.
 * A string, not a function: functions compiled by the TypeScript runner reference helpers the page lacks.
 */
const NOTICES = `[...document.querySelectorAll("body *")].flatMap((el) => {
  const s = getComputedStyle(el);
  if ((s.position !== "fixed" && s.position !== "sticky") || s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return [];
  const text = el.innerText || "";
  if (text.length > 2500) return [];
  const dialog = el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true" || !!el.querySelector("[role=dialog], [aria-modal=true]");
  const notice = /cookie|consent|privacy|cmp|gdpr|banner|notice|modal|dialog/i.test(el.id + " " + el.className) && /cookie|consent|privacy|datenschutz|einwilligung|country|region|language|sprache/i.test(text);
  if (!dialog && !notice) return [];
  const b = el.getBoundingClientRect();
  const visible = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
  return visible > 0 ? [{ el, share: visible / (innerWidth * innerHeight), text: text.replace(/\\s+/g, " ").trim() }] : [];
})`;

/**
 * Short bars in the page that a visitor can close, about the country or language, cookies, a survey or a newsletter.
 * The innermost element that holds both the text and the close button is taken, so the header around a bar stays.
 */
const NOTICE_BARS = `[...document.querySelectorAll("body div, body section, body aside, body header")].filter((el) => {
  const text = (el.innerText || "").trim();
  if (!text || text.length > 250 || el.querySelector("h1, article")) return false;
  if (!/country|region|language|sprache|cookie|survey|feedback|newsletter/i.test(text)) return false;
  return [...el.querySelectorAll("button, [role=button]")].some((b) => /close|dismiss|schlie/i.test(b.getAttribute("aria-label") || "") || /^[×✕x]$/i.test((b.innerText || "").trim()));
})`;

/**
 * Empty layers floating over most of the view with a tint or blur: the backdrop a dialog leaves when it is drawn as a
 * separate element. Only looked for once a notice was hidden, so a page's own full-screen design stays.
 */
const BACKDROPS = `[...document.querySelectorAll("body *")].filter((el) => {
  const s = getComputedStyle(el);
  if (s.position !== "fixed" || s.display === "none" || (el.innerText || "").trim()) return false;
  const b = el.getBoundingClientRect();
  if (b.width * b.height < innerWidth * innerHeight * 0.8) return false;
  const tinted = !/rgba\\(0, 0, 0, 0\\)|transparent/.test(s.backgroundColor);
  return tinted || (s.backdropFilter && s.backdropFilter !== "none");
})`;

/**
 * Unlocks a page that can't scroll to the end of its content, the way dialogs lock it: the root and the body get
 * visible vertical overflow, their natural height and their place in the flow, and the scroll position a fixed body
 * kept in its offset comes back. Horizontal overflow stays clipped, because it keeps off-canvas menus out of view. A
 * page that scrolls inside its own container, which can be the body, is left as it is. Every pass checks again,
 * because a dialog's script can lock the page anew, but only a page whose styles can hold a lock is scrolled to find
 * out. The scrolling is instant, because a smooth scroll leaves the position unchanged while the check reads it.
 * Inline `!important` declarations win over the site's `!important` rules. The scroll position is the same
 * afterwards, unless the unlock brought a kept one back.
 */
const UNLOCK_SCROLL = `(() => {
    const root = document.documentElement, body = document.body;
    if (!body) return;
    const styles = [root, body].map((el) => getComputedStyle(el));
    if (!styles.some((s) => s.position === "fixed" || /hidden|clip/.test(s.overflowY))) return;
    const jump = (top) => scrollTo({ left: scrollX, top, behavior: "instant" });
    // The scroll position the end of the content needs; a small shortfall is margins, not a lock.
    const needed = Math.max(body.scrollHeight, body.getBoundingClientRect().height) - innerHeight - 100;
    if (needed <= 0) return;
    const y = scrollY;
    jump(needed);
    // Content heights can be fractions of a pixel, and the browser rounds the position it scrolls to.
    const scrolls = scrollY >= needed - 1;
    jump(y);
    if (scrolls) return;
    // The body scrolls by itself only when the root has its own overflow; otherwise the body's applies to the view.
    const candidates = [...(styles[0].overflowY === "visible" ? [] : [body]), ...body.querySelectorAll("*")];
    const ownScroller = candidates.some((el) => {
      if (el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowY)) return false;
      const b = el.getBoundingClientRect();
      return b.width * b.height >= innerWidth * innerHeight * 0.5;
    });
    if (ownScroller) return;
    const kept = getComputedStyle(body).position === "fixed" ? -parseFloat(getComputedStyle(body).top) || 0 : 0;
    for (const el of [root, body]) {
      const s = getComputedStyle(el);
      if (/hidden|clip/.test(s.overflowY)) el.style.setProperty("overflow-y", "visible", "important");
      if (s.position === "fixed") el.style.setProperty("position", "static", "important");
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("max-height", "none", "important");
    }
    if (kept > 0) jump(kept);
  })()`;

/**
 * Hides the notices still floating over the page after the choice, their backdrops, and closable notice bars, and
 * unlocks a page that can't scroll. Hiding agrees to nothing. The value is how many it hid. An expression, so it
 * also runs while the page clock is paused.
 */
export const HIDE_NOTICES = `(() => {
  const n = ${NOTICES};
  for (const x of n) x.el.style.setProperty("display", "none", "important");
  if (n.length) for (const el of ${BACKDROPS}) el.style.setProperty("display", "none", "important");
  ${UNLOCK_SCROLL};
  const bars = ${NOTICE_BARS}.filter((el, i, all) => !all.some((other, j) => j !== i && el.contains(other)));
  for (const el of bars) el.style.setProperty("display", "none", "important");
  return n.length + bars.length;
})()`;
export const hideNotices = (page: Page) => page.evaluate(HIDE_NOTICES) as Promise<number>;

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

interface PageText { title: string; text: string }
const readPage = (page: Page) => page.evaluate(PAGE_TEXT) as Promise<PageText>;
/** The expected text can be in the title too. A highlight marks words on the page, so the title doesn't count for it. */
const showsExpected = (p: PageText, expect: string) => readable(`${p.title}\n${p.text}`).includes(readable(expect));
const showsSentence = (p: PageText, sentence: string) => readable(p.text).includes(readable(sentence));

/** What a page showed at an earlier moment of a run. `when` completes "It was there …". */
export interface PageMoment extends PageText { when: string }
/** Notes what the page shows now, so a message can name the moment a text was lost. */
export async function noteMoment(page: Page, moments: PageMoment[], when: string) {
  const now = await readPage(page).catch(() => undefined);
  if (now) moments.push({ when, ...now });
}

/** When a text that is missing now was last on the page, as a sentence; empty when it never was. */
export function lostAt(moments: PageMoment[], shown: (p: PageText) => boolean): string {
  const last = moments.findLastIndex(shown);
  if (last < 0) return "";
  return ` It was there ${moments[last].when}, but not ${moments[last + 1]?.when ?? "a moment later"}.`;
}

/** A page that shows little text is often an ad, a wait or an error in the content's place, so a message quotes it. */
export function littleText({ text }: PageText): string {
  const plain = text.replace(/\s+/g, " ").trim();
  if (!plain) return " The page shows no text.";
  return plain.length > 400 ? "" : ` The page shows only: “${plain.length > 120 ? `${plain.slice(0, 120)}…` : plain}”.`;
}

/** Waits a few seconds for a sentence that the page shows late, for example after an ad in front of the content. */
export async function waitForSentence(page: Page, sentence: string) {
  for (let waited = 0; waited < EXPECT_WAIT_MS; waited += 500) {
    const now = await readPage(page).catch(() => undefined);
    if (now && showsSentence(now, sentence)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A shot that shows a source: a redirect then means the article moved, and the shot fails. */
export const isSourceShot = (shot: Pick<PageShot, "credit" | "expect">) => !!(shot.credit?.trim() || shot.expect?.trim());

/**
 * What a loaded page shows compared with what the shot expects. An error status always fails. For a source shot,
 * a redirect to another page and a missing expected text fail too. `moments` are what the page showed earlier.
 */
export async function inspectPage(page: Page, requested: string, response: HTTPResponse | null, shot: Pick<PageShot, "credit" | "expect" | "highlight">, moments: PageMoment[] = []): Promise<PageCheck> {
  const status = response?.status();
  const expect = shot.expect?.trim();
  const highlight = shot.highlight?.trim();
  const hasExpected = (p: PageText) => !expect || showsExpected(p, expect);
  const hasSentence = (p: PageText) => !highlight || showsSentence(p, highlight);
  let shown = await readPage(page).catch(() => ({ title: "", text: "" }));
  // A page that reloads after the consent choice, renders late or shows an ad first gets a few seconds to show the texts.
  for (let waited = 0; !(hasExpected(shown) && hasSentence(shown)) && waited < EXPECT_WAIT_MS; waited += 500) {
    await new Promise((r) => setTimeout(r, 500));
    shown = await readPage(page).catch(() => shown);
  }
  const { title } = shown;
  const finalUrl = page.url();
  const found = expect ? hasExpected(shown) : undefined;
  const highlightFound = highlight ? hasSentence(shown) : undefined;
  const lost = found === false ? lostAt(moments, hasExpected) : highlightFound === false ? lostAt(moments, hasSentence) : "";
  const moved = lostPage(requested, finalUrl);
  const blocked = await blockedReason(page, status);
  const dialog = await coveringDialog(page).catch(() => undefined);
  const paywall = await coveringPaywall(page).catch(() => undefined);
  const missing = found === false ? `The page doesn't show “${expect}”.${lost}${littleText(shown)}`
    : highlightFound === false ? `The page doesn't show the sentence to highlight (“${highlight}”).${lost}${littleText(shown)}`
    : undefined;
  const problem = blocked ? `The site blocked the automated browser (${blocked}).`
    : dialog ? `A cookie dialog still covers the page (“${dialog}…”). Hide it with a CSS selector under Hide.`
    : paywall ? `A paywall covers the page (“${paywall}…”). Show this source on a slide instead.`
    : status && status >= 400 ? `The page answered HTTP ${status}.`
    : moved && isSourceShot(shot) ? `The link now leads to ${moved}.`
    : missing;
  return { url: requested, checkedAt: new Date().toISOString(), ok: !problem, ...(status ? { status } : {}), ...(finalUrl !== requested ? { finalUrl } : {}), title: title.slice(0, 200), ...(expect ? { expect, found } : {}), ...(highlight ? { highlight } : {}), ...(problem ? { problem } : {}), ...(missing && problem === missing && lost ? { lost: true } : {}) };
}

/** How a page answered, for the step in which it loaded. */
export function loadNotes(requested: string, final: string, response: HTTPResponse | null): string[] {
  return [...(response ? [`HTTP ${response.status()}`] : []), ...(movedTo(requested, final) ? [`Redirected to ${final}`] : [])];
}

interface CheckPageOptions { userAgent?: string; headers?: Record<string, string>; device?: PageDevice; log?: (line: string) => void; /** Records what the browser shows at each step. */ trace?: PageTrace }

/**
 * Opens a page only to check it, without filming. A page that doesn't load is a failed check, not an error. A browser
 * that doesn't start is an error, because it says nothing about the page.
 */
export async function checkPage(url: string, shot: Pick<PageShot, "credit" | "expect" | "highlight">, opts: CheckPageOptions = {}): Promise<PageCheck> {
  try {
    return await retryReplacedPage(() => checkPageOnce(url, shot, opts), opts.log ?? (() => {}));
  } catch (err) {
    if (err instanceof ReplacedPageError) return failedCheck(url, shot, REPLACED_PAGE);
    throw err;
  }
}

const failedCheck = (url: string, shot: Pick<PageShot, "expect">, problem: string): PageCheck =>
  ({ url, checkedAt: new Date().toISOString(), ok: false, problem, ...(shot.expect?.trim() ? { expect: shot.expect.trim() } : {}) });

/** One attempt at checkPage. A page that replaced itself throws, so it can be opened again. */
async function checkPageOnce(url: string, shot: Pick<PageShot, "credit" | "expect" | "highlight">, opts: CheckPageOptions): Promise<PageCheck> {
  opts.trace?.start();
  const browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, protocolTimeout: 30_000, args: ["--lang=en-US", "--hide-scrollbars", "--mute-audio"] });
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
    const failed = async (check: PageCheck) => {
      await opts.trace?.fail(page);
      return check;
    };
    const moments: PageMoment[] = [];
    await noteMoment(page, moments, "when the page loaded");
    await opts.trace?.step(page, "loaded", loadNotes(url, page.url(), response));
    const refused = await refuseConsent(page);
    if (refused !== undefined) {
      await noteMoment(page, moments, "after the cookie choice");
      await opts.trace?.step(page, "cookies", [`Clicked “${refused}”`]);
    }
    if (opts.trace) await newlyHidden(page);
    if (await hideNotices(page).catch(() => 0)) {
      await noteMoment(page, moments, "after notices were hidden");
      await opts.trace?.step(page, "hidden", await hiddenNotes(page, []));
    }
    const check = await inspectPage(page, url, response, shot, moments);
    if (!check.ok) return await failed(check);
    // Metered paywalls often open only after reading or scrolling for a moment.
    await page.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight / 3)`);
    await new Promise((r) => setTimeout(r, LATE_PAYWALL_MS));
    const paywall = await coveringPaywall(page).catch(() => undefined);
    return paywall ? await failed({ ...check, ok: false, problem: `A paywall covers the page (“${paywall}…”). Show this source on a slide instead.` }) : check;
  } catch (err) {
    if (isReplacedPage(err)) throw err;
    return failedCheck(url, shot, `The page didn't load: ${(err as Error).message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
