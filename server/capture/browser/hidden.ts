import type { Page } from "puppeteer-core";

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
  page.evaluate(`(() => {
    const seen = (window.__devlogHidden = window.__devlogHidden || new WeakSet());
    const fresh = [...document.querySelectorAll("[style*=display]")].filter((el) => el.style.display === "none" && el.style.getPropertyPriority("display") === "important" && !seen.has(el));
    fresh.forEach((el) => seen.add(el));
    return fresh.map(${DESCRIBE});
  })()`).catch(() => []) as Promise<string[]>;

/** Marks a style element, so the notes below find its rules. */
export const AD_STYLE = "ads";

/** The outermost elements that the rules of the marked style element hide. */
const hiddenByAdRules = (page: Page) =>
  page.evaluate(`(() => {
    const sheet = document.querySelector('style[data-devlog="${AD_STYLE}"]')?.sheet;
    const matched = new Set([...(sheet ? sheet.cssRules : [])].filter((r) => r.style && r.style.display === "none").flatMap((r) => [...document.querySelectorAll(r.selectorText)]));
    return [...matched].filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META)$/.test(el.tagName) && getComputedStyle(el).display === "none" && ![...matched].some((other) => other !== el && other.contains(el))).map(${DESCRIBE});
  })()`).catch(() => []) as Promise<string[]>;

/** How many elements a selector matches; -1 when it isn't valid. */
const matches = (page: Page, selector: string) =>
  page.evaluate(`(() => { try { return document.querySelectorAll(${JSON.stringify(selector)}).length; } catch { return -1; } })()`).catch(() => 0) as Promise<number>;

/** What was hidden, for the step in which notices, ads and the elements under Hide are hidden. */
export async function hiddenNotes(page: Page, hide: string[]): Promise<string[]> {
  const notes = [...list("Hid notices and messages", await newlyHidden(page)), ...list("Hid ads", await hiddenByAdRules(page))];
  for (const selector of hide) {
    const count = await matches(page, selector);
    notes.push(count < 0 ? `Hide “${selector}” isn't a valid CSS selector` : count === 0 ? `Hide “${selector}” matches nothing` : `Hide “${selector}” matches ${count} element${count === 1 ? "" : "s"}`);
  }
  return notes;
}

/** The selectors of custom CSS that match nothing on the page. Selectors for a state such as :hover or a part of an element are left out. */
export async function unusedSelectors(page: Page, css: string): Promise<string[]> {
  const unused = await (page.evaluate(`(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(${JSON.stringify(css)});
    return [...sheet.cssRules].filter((r) => r.selectorText && !/::|:(hover|focus|active|visited|target|before|after|first-line|first-letter)/.test(r.selectorText) && !document.querySelector(r.selectorText)).map((r) => r.selectorText);
  })()`).catch(() => []) as Promise<string[]>);
  return unused.map((selector) => `CSS “${selector}” matches nothing`);
}
