import type { Page } from "puppeteer-core";
import { inTime } from "./look.js";

/** Each query walks through the whole page and has its own limit, so a slow one on a large page leaves the others. */
const NOTE_MS = 2000;
const ask = async <T>(page: Page, expression: string): Promise<T[]> => (await inTime(page.evaluate(expression) as Promise<T[]>, Date.now() + NOTE_MS)) ?? [];

/** How many elements a note names before it only counts the rest. */
const NAMED = 8;

/** Names an element the way a CSS selector would, with the start of its text. */
const DESCRIBE = String.raw`(el) => {
  const classes = [...el.classList].slice(0, 2).map((c) => "." + c).join("");
  const copy = el.cloneNode(true);
  for (const code of copy.querySelectorAll("script, style, noscript")) code.remove();
  const text = (copy.textContent || "").replace(/\s+/g, " ").trim();
  return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + classes + (text ? " “" + (text.length > 60 ? text.slice(0, 60) + "…" : text) + "”" : "");
}`;

/** Elements with the same name are named once, with their number. */
function list(label: string, elements: string[]): string[] {
  const names = [...new Set(elements)].map((name) => {
    const count = elements.filter((e) => e === name).length;
    return count > 1 ? `${count} × ${name}` : name;
  });
  return names.length ? [`${label}: ${names.slice(0, NAMED).join(", ")}${names.length > NAMED ? ` and ${names.length - NAMED} more` : ""}`] : [];
}

/**
 * The elements with an inline `display: none !important` that the call before didn't see, which is how notices and
 * messages in ad slots are hidden. A site's own such elements are seen by a first call before anything is hidden.
 */
export const newlyHidden = (page: Page) =>
  ask<string>(page, `(() => {
    const seen = (window.__devlogHidden = window.__devlogHidden || new WeakSet());
    const fresh = [...document.querySelectorAll("[style*=display]")].filter((el) => el.style.display === "none" && el.style.getPropertyPriority("display") === "important" && !seen.has(el));
    fresh.forEach((el) => seen.add(el));
    return fresh.map(${DESCRIBE});
  })()`);

/** Marks of the style elements, so the notes below find their rules: the ad rules, and each selector under Hide. */
export const AD_STYLE = "ads";
export const HIDE_STYLE = "hide";

/** The outermost elements that the rules of the marked style element hide. */
const hiddenByAdRules = (page: Page) =>
  ask<string>(page, `(() => {
    const sheet = document.querySelector('style[data-devlog="${AD_STYLE}"]')?.sheet;
    const matched = new Set([...(sheet ? sheet.cssRules : [])].filter((r) => r.style && r.style.display === "none").flatMap((r) => [...document.querySelectorAll(r.selectorText)]));
    return [...matched].filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(el.tagName) && getComputedStyle(el).display === "none" && ![...matched].some((other) => other !== el && other.contains(el))).map(${DESCRIBE});
  })()`);

/**
 * How many elements each selector under Hide matches, in order; -1 when Chrome dropped its rule. The rule is read from
 * the style sheet, because querySelectorAll accepts some selectors that a style sheet doesn't.
 */
const hideMatches = (page: Page) =>
  ask<number>(page, `[...document.querySelectorAll('style[data-devlog="${HIDE_STYLE}"]')].map((style) => {
    const rules = style.sheet ? style.sheet.cssRules : [];
    return rules.length === 1 && rules[0].selectorText ? document.querySelectorAll(rules[0].selectorText).length : -1;
  })`);

/** What was hidden, for the step in which notices, ads and the elements under Hide are hidden. */
export async function hiddenNotes(page: Page, hide: string[]): Promise<string[]> {
  const notes = [...list("Hid notices and messages", await newlyHidden(page)), ...list("Hid ads", await hiddenByAdRules(page))];
  for (const [i, count] of (await hideMatches(page)).entries()) {
    const selector = hide[i];
    notes.push(count < 0 ? `Hide “${selector}” isn't a valid CSS selector` : count === 0 ? `Hide “${selector}” matches nothing` : `Hide “${selector}” matches ${count} element${count === 1 ? "" : "s"}`);
  }
  return notes;
}

/**
 * The selectors of custom CSS that match nothing on the page, also inside media queries that apply. Selectors for a
 * state such as :hover or a part of an element are left out.
 */
export async function unusedSelectors(page: Page, css: string): Promise<string[]> {
  const unused = await ask<string>(page, `(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(${JSON.stringify(css)});
    const selectors = (rules) => [...rules].flatMap((r) => r.selectorText ? [r.selectorText] : r instanceof CSSMediaRule && matchMedia(r.conditionText).matches ? selectors(r.cssRules) : []);
    const unused = (selector) => { try { return !document.querySelector(selector); } catch { return false; } };
    return selectors(sheet.cssRules).filter((s) => !/::|:(hover|focus|active|visited|target|before|after|first-line|first-letter)/.test(s) && unused(s));
  })()`);
  return unused.map((selector) => `CSS “${selector}” matches nothing`);
}
