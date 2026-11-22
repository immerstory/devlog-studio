import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkPage, isSourceShot, lostPage, movedTo, readable } from "../server/capture/browser/verify.js";
import { displayLink, fitMiddle } from "../video/renderer.js";

test("a link has moved when it leads to another site or path", () => {
  assert.equal(movedTo("https://example.com/a/", "https://www.example.com/a"), undefined);
  assert.equal(movedTo("http://example.com/a", "https://example.com/a"), undefined);
  assert.equal(movedTo("https://example.com/2026/story", "https://example.com/"), "https://example.com/");
  assert.equal(movedTo("https://example.com/a", "https://other.com/a"), "https://other.com/a");
  assert.equal(lostPage("https://www.meta.com/quest/quest-3/", "https://www.meta.com/de/quest/quest-3/"), undefined, "a language path keeps the page");
  assert.equal(lostPage("https://example.com/2026/story", "https://example.com/de/"), "https://example.com/de/", "a homepage means the article is gone");
  assert.equal(lostPage("https://example.com/a", "https://other.com/a"), "https://other.com/a");
  assert.equal(isSourceShot({}), false);
  assert.equal(isSourceShot({ credit: "Outlet" }), true);
});

test("expected text matches regardless of case, spacing, quotes and dashes", () => {
  assert.ok(readable("“Pilot   Purgatory” — the #1 failure").includes(readable('"pilot purgatory" - the #1 failure')));
});

test("a link reads without protocol and www, and a long one is shortened in the middle", () => {
  assert.equal(displayLink("https://www.example.com/2026/07/16/story/"), "example.com/2026/07/16/story");
  const width = (s: string) => s.length;
  assert.equal(fitMiddle(width, "short", 10), "short");
  const cut = fitMiddle(width, "example.com/a-very-long-article-path", 20);
  assert.ok(cut.length <= 20 && cut.startsWith("example") && cut.includes("…") && cut.endsWith("path"));
});

test("a page check finds the headline, a missing page and a moved article", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/story") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Story</title><h1>Pilot Purgatory explained</h1>"); return; }
    if (req.url === "/moved") { res.writeHead(301, { Location: "/" }); res.end(); return; }
    const banner = (button: string) => `<title>Article</title><h1>Pilot Purgatory explained</h1><div id="cmp" role="dialog" style="position:fixed;inset:0;background:#fff">We use cookies to improve your experience. ${button}</div>`;
    if (req.url === "/consent") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(banner(`<button onclick="document.getElementById('cmp').remove()">Reject all</button><button>Accept all</button>`)); return; }
    if (req.url === "/notice") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<title>Article</title><h1>Pilot Purgatory explained</h1><aside class="privacy-banner" style="position:fixed;left:0;right:0;bottom:0;height:60vh;background:#222;color:#fff">By continuing you agree to our use of cookies. <button aria-label="Close">×</button></aside>`); return; }
    if (req.url === "/app") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<title>App</title><div id="scrollview" style="position:fixed;inset:0;overflow:auto"><h1>Pilot Purgatory explained</h1><p>${"Text. ".repeat(400)}</p><footer>Privacy Policy · Cookies</footer></div>`); return; }
    if (req.url === "/wall") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<title>Article</title><h1>Pilot Purgatory explained</h1><div id="sp_message_container_1" style="position:fixed;inset:0"><iframe srcdoc="Accept all, or reject and subscribe" style="width:100%;height:100%"></iframe></div>`); return; }
    if (req.url === "/paywall") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<title>Article</title><h1>Pilot Purgatory explained</h1><div class="meter" style="position:fixed;left:0;right:0;bottom:0;height:50vh;background:#5fe">Continue reading with a subscription. Start your trial.</div>`); return; }
    if (req.url === "/stuck") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(banner("<button>Accept all</button>")); return; }
    if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Home</title><p>Welcome</p>"); return; }
    res.writeHead(404, { "Content-Type": "text/html" }); res.end("<title>Not found</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await checkPage(`${base}/story`, { credit: "Outlet", expect: "pilot purgatory EXPLAINED" });
    assert.equal(ok.ok, true, ok.problem ?? "");
    assert.equal(ok.title, "Story");
    const wrong = await checkPage(`${base}/story`, { expect: "Another headline" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problem ?? "", /doesn't show “Another headline”/);
    const gone = await checkPage(`${base}/gone`, {});
    assert.match(gone.problem ?? "", /HTTP 404/);
    const moved = await checkPage(`${base}/moved`, { credit: "Outlet" });
    assert.match(moved.problem ?? "", /now leads to/);
    assert.equal((await checkPage(`${base}/moved`, {})).ok, true, "a redirect only fails a source shot");
    assert.equal((await checkPage(`${base}/consent`, { expect: "Pilot Purgatory" })).ok, true, "optional cookies are refused");
    assert.equal((await checkPage(`${base}/notice`, { expect: "Pilot Purgatory" })).ok, true, "a notice without a refuse button is hidden");
    assert.equal((await checkPage(`${base}/app`, { expect: "Pilot Purgatory" })).ok, true, "a page in a fixed container isn't a notice");
    assert.match((await checkPage(`${base}/wall`, { expect: "Pilot Purgatory" })).problem ?? "", /consent wall/, "a consent wall in a frame fails");
    assert.match((await checkPage(`${base}/paywall`, { expect: "Pilot Purgatory" })).problem ?? "", /paywall covers/, "a paywall fails and stays");
    assert.equal((await checkPage(`${base}/stuck`, { expect: "Pilot Purgatory" })).ok, true, "a dialog that only accepts is hidden, not answered");
  } finally {
    server.close();
  }
});

test("a page with a scroll-driven animation can be filmed", async () => {
  const { openPage } = await import("../server/capture/browser/render.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<style>@keyframes grow { from { width: 0 } to { width: 100% } } #bar { position: fixed; top: 0; height: 8px; background: red; animation: grow linear; animation-timeline: scroll(); }</style><div id="bar"></div><div style="height:4000px"></div>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-scroll-"));
  try {
    const session = await openPage({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, device: "desktop", output: { width: 640, height: 360 }, settleMs: 100, hide: [], log: () => {} });
    try {
      for (const y of [0, 1500]) await session.frame({ scrollY: y, zoom: 1, focusX: 0.5, focusY: 0.5 }, 33, path.join(dir, `f${y}.png`));
    } finally {
      await session.close();
    }
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ad rules hide ad slots but not the body or page wrappers that carry ad markers, and custom CSS overrides them", async () => {
  const { openPage } = await import("../server/capture/browser/render.js");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<body data-ad-unit="article" class="has-taboola"><div id="app" data-ad-unit="page"><main class="outbrain-enabled"><h1>Headline</h1>` +
        `<div id="slot" data-ad-unit="top">Ad</div><div id="widget" class="taboola-feed">Ad</div><div id="kept" class="advert">Content</div></main></div></body>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const session = await openPage({ url, device: "desktop", output: { width: 640, height: 360 }, settleMs: 50, hide: [], css: [".advert { display: block !important; }"], log: () => {} });
    try {
      const display = await session.run<Record<string, string>>(
        `Object.fromEntries([["body", document.body], ...["app", "slot", "widget", "kept"].map((id) => [id, document.getElementById(id)])].map(([k, el]) => [k, getComputedStyle(el).display]))`,
      );
      assert.equal(display.body, "block", "the body with ad markers stays visible");
      assert.equal(display.app, "block", "a wrapper around the page content stays visible");
      assert.equal(display.slot, "none", "an ad slot by attribute is hidden");
      assert.equal(display.widget, "none", "an ad widget by class is hidden");
      assert.equal(display.kept, "block", "custom CSS with the same selector overrides the ad rule");
    } finally {
      await session.close();
    }
  } finally {
    server.close();
  }
});

test("a page that can't scroll is unlocked, however the lock is set, and a page with its own scroller keeps its layout", async () => {
  const { openPage } = await import("../server/capture/browser/render.js");
  const { HIDE_NOTICES } = await import("../server/capture/browser/verify.js");
  const content = `<h1>Headline</h1><div style="height:4000px"></div>`;
  const dialog = `<div role="dialog" aria-modal="true" style="position:fixed;inset:20% 10%;background:#fff">We use cookies</div>`;
  const pages: Record<string, string> = {
    // A fixed body that keeps the scroll position in its offset, set with !important as consent tools do.
    "/fixed": `<html class="dialog-open"><style>.dialog-open body { overflow: hidden !important; position: fixed !important; top: -1200px; left: 0; right: 0; }</style><body>${content}${dialog}</body></html>`,
    // The overflow shorthand and a full height on both the root and the body.
    "/shorthand": `<html class="modal-open"><style>html.modal-open, html.modal-open body { overflow: hidden; height: 100%; }</style><body>${content}${dialog}</body></html>`,
    // An overlay the notice detection doesn't find, which the shot hides with a selector.
    "/selector": `<style>body { overflow: hidden; height: 100vh; }</style><body>${content}<div id="overlay">Subscribe to read on</div></body>`,
    // A phone layout: a fixed body with its own scroller, and a small cookie banner.
    "/app": `<style>body { margin: 0; position: fixed; inset: 0; overflow: hidden; }</style><body><div id="scroller" style="height:100%;overflow-y:auto">${content}</div>` +
      `<div class="cookie-banner" style="position:fixed;bottom:0;left:0;right:0">This site uses cookies</div></body>`,
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html>${pages[req.url ?? ""] ?? ""}`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = (path: string, hide: string[] = []) => openPage({ url: base + path, device: "desktop", output: { width: 640, height: 360 }, settleMs: 50, hide, log: () => {} });
  const scrollsTo = (y: number) => `(window.scrollTo(0, ${y}), window.scrollY)`;
  try {
    const fixed = await open("/fixed");
    try {
      assert.equal(await fixed.run<number>(scrollsTo(2000)), 2000);
      // The site's script locks the page again at 1500, keeping that position in the body's offset.
      await fixed.run(`(window.scrollTo(0, 0), Object.assign(document.body.style, { position: "fixed", overflow: "hidden", top: "-1500px" }), true)`);
      assert.equal(await fixed.run<number>(scrollsTo(2000)), 0, "the page is locked again");
      await fixed.run(HIDE_NOTICES);
      assert.equal(await fixed.run<number>("window.scrollY"), 1500, "the next pass unlocks it and brings the kept position back");
      assert.equal(await fixed.run<number>(scrollsTo(2000)), 2000);
    } finally {
      await fixed.close();
    }
    for (const [path, hide] of [["/shorthand", []], ["/selector", ["#overlay"]]] as const) {
      const page = await open(path, [...hide]);
      try {
        assert.equal(await page.run<number>(scrollsTo(2000)), 2000, `${path} scrolls`);
      } finally {
        await page.close();
      }
    }
    const app = await open("/app");
    try {
      assert.deepEqual(await app.run<string[]>(`[getComputedStyle(document.body).position, getComputedStyle(document.body).overflowY]`), ["fixed", "hidden"]);
    } finally {
      await app.close();
    }
  } finally {
    server.close();
  }
});

test("a highlighted sentence is found across elements and marked word by word on the page clock", async () => {
  const { openPage } = await import("../server/capture/browser/render.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<p style="font:20px sans-serif">${"Filler text. ".repeat(200)}</p><p style="font:20px sans-serif">She said: “The <b>headset</b> rarely   decides — the demo does.” Then more.</p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-highlight-"));
  try {
    const session = await openPage({ url, device: "desktop", output: { width: 640, height: 360 }, settleMs: 50, hide: [], highlight: '"the headset rarely decides - the demo does."', log: () => {} });
    try {
      const sizes = async () => session.run<string[]>(`[...document.querySelectorAll(".devlog-highlight")].map((s) => getComputedStyle(s).backgroundSize)`);
      assert.equal((await sizes()).length, 8, "every word and the dash are marked");
      await session.frame({ scrollY: 0, zoom: 1, focusX: 0.5, focusY: 0.5 }, 33, path.join(dir, "a.png"));
      assert.match((await sizes())[0], /^0%/, "the marker hasn't started on the first frame");
      for (let i = 0; i < 60; i++) await session.frame({ scrollY: 0, zoom: 1, focusX: 0.5, focusY: 0.5 }, 33, path.join(dir, "b.png"));
      assert.ok((await sizes()).every((s) => s.startsWith("100%")), "after two seconds every word is marked");
      assert.ok(await session.run<number>((await import("../server/capture/browser/highlight.js")).highlightScroll) > 0, "the view moves to the sentence");
    } finally {
      await session.close();
    }
    await assert.rejects(openPage({ url, device: "desktop", output: { width: 640, height: 360 }, settleMs: 50, hide: [], highlight: "A sentence that isn't there", log: () => {} }), /doesn't show the sentence/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("light text on a dark page gets a solid marker and turns dark", async () => {
  const { openPage } = await import("../server/capture/browser/render.js");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<body style="background:#111;color:oklch(0.92 0.01 258);font:20px sans-serif"><p>Google settled it by editing one sentence.</p></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const session = await openPage({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, device: "desktop", output: { width: 640, height: 360 }, settleMs: 50, hide: [], highlight: "editing one sentence", log: () => {} });
    try {
      for (let i = 0; i < 60; i++) await session.frame({ scrollY: 0, zoom: 1, focusX: 0.5, focusY: 0.5 }, 33, `${process.env.TEMP ?? "/tmp"}/devlog-solid.png`);
      // A pixel of each word's colour, so any colour format compares as RGB.
      const colors = await session.run<number[]>(`[...document.querySelectorAll(".devlog-highlight-solid")].map((s) => {
        const c = document.createElement("canvas").getContext("2d");
        c.fillStyle = getComputedStyle(s).color;
        c.fillRect(0, 0, 1, 1);
        return c.getImageData(0, 0, 1, 1).data[0];
      })`);
      assert.equal(colors.length, 3);
      assert.ok(colors.every((red) => red < 40), colors.join(", "));
    } finally {
      await session.close();
    }
  } finally {
    server.close();
  }
});
