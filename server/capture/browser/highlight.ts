/** Milliseconds before the marker begins, between two words, and for one word's sweep; and the marker colour. */
export const HIGHLIGHT = { delayMs: 600, wordMs: 140, sweepMs: 260, color: "rgba(255, 214, 0, 0.55)", solid: "rgb(255, 214, 0)", darkText: "#111111" };

/** Quote marks, which all read as one straight quote, and dashes, which read as a hyphen. */
const FOLDS = { single: "‘’‚′`´", double: "“”„″", dash: "‐‑‒–—―−" };

/**
 * Finds a sentence on the page and wraps each of its words in a marker that sweeps in, one word after another. The
 * search ignores case, spacing, the kind of quote mark and dashes, so a sentence copied from an article still matches. The marker is
 * a CSS animation, so the capture's page clock steps it frame by frame. Returns whether the sentence was found.
 * A string, not a function: functions compiled by the TypeScript runner reference helpers the page lacks.
 */
export function highlightScript(sentence: string, delayMs = HIGHLIGHT.delayMs): string {
  return String.raw`(() => {
  const folds = ${JSON.stringify(FOLDS)};
  const fold = (c) => folds.single.includes(c) || folds.double.includes(c) || c === '"' ? "'" : folds.dash.includes(c) ? "-" : c.toLowerCase();
  const target = [...${JSON.stringify(sentence)}.trim().replace(/\s+/g, " ")].map(fold).join("");
  if (!target) return false;
  const visible = (node) => {
    const el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(el.tagName)) return false;
    return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let flat = "";
  const at = [];
  let space = true;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!visible(n)) continue;
    for (let i = 0; i < n.data.length; i++) {
      const c = n.data[i];
      if (/\s/.test(c)) { if (space) continue; flat += " "; space = true; }
      else { flat += fold(c); space = false; }
      at.push([n, i]);
    }
  }
  const start = flat.indexOf(target);
  if (start < 0) return false;
  const [first, firstOffset] = at[start];
  const [last, lastOffset] = at[start + target.length - 1];
  const pieces = [];
  let inside = false;
  const all = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = all.nextNode(); n; n = all.nextNode()) {
    if (n === first) inside = true;
    if (inside && visible(n)) pieces.push([n, n === first ? firstOffset : 0, n === last ? lastOffset + 1 : n.data.length]);
    if (n === last) break;
  }
  // Light text on a dark page would vanish on a see-through marker, so there the marker is solid and the words turn dark.
  // A one-pixel canvas reads any colour format, including oklch, as RGB.
  const probe = document.createElement("canvas").getContext("2d");
  probe.fillStyle = getComputedStyle(first.parentElement).color;
  probe.fillRect(0, 0, 1, 1);
  const rgb = probe.getImageData(0, 0, 1, 1).data;
  // Brighter than mid-grey: dark pages often set body text in a light grey rather than white.
  const lightText = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 > 0.45;
  let word = 0;
  for (const [node, from, to] of pieces) {
    let part = node;
    if (from > 0) part = part.splitText(from);
    if (to - from < part.data.length) part.splitText(to - from);
    const fragment = document.createDocumentFragment();
    for (const token of part.data.match(/\S+\s*|\s+/g) || []) {
      if (!token.trim()) { fragment.append(token); continue; }
      const span = document.createElement("span");
      span.className = lightText ? "devlog-highlight devlog-highlight-solid" : "devlog-highlight";
      span.style.animationDelay = (${delayMs} + word * ${HIGHLIGHT.wordMs}) + "ms";
      span.textContent = token;
      fragment.append(span);
      word++;
    }
    part.replaceWith(fragment);
  }
  const style = document.createElement("style");
  style.textContent = ".devlog-highlight { background-image: linear-gradient(${HIGHLIGHT.color}, ${HIGHLIGHT.color}); background-repeat: no-repeat; background-position: 0 70%; background-size: 0% 75%; animation: devlog-highlight ${HIGHLIGHT.sweepMs}ms ease-out forwards; -webkit-box-decoration-break: clone; box-decoration-break: clone; } @keyframes devlog-highlight { to { background-size: 100% 75%; } } .devlog-highlight-solid { background-image: linear-gradient(${HIGHLIGHT.solid}, ${HIGHLIGHT.solid}); background-position: 0 50%; background-size: 0% 100%; animation-name: devlog-highlight-solid; } @keyframes devlog-highlight-solid { to { background-size: 100% 100%; color: ${HIGHLIGHT.darkText}; } }";
  document.head.append(style);
  return word > 0;
})()`;
}

/** Scroll position that puts the highlighted sentence at about a third of the view's height. */
export const highlightScroll = `(() => {
  const first = document.querySelector(".devlog-highlight");
  if (!first) return 0;
  return Math.max(0, first.getBoundingClientRect().top + scrollY - innerHeight * 0.33);
})()`;
