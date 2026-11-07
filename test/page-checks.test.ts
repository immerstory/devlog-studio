import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkPage, isSourceShot, movedTo, readable } from "../server/capture/browser/verify.js";
import { displayLink, fitMiddle } from "../video/renderer.js";

test("a link has moved when it leads to another site or path", () => {
  assert.equal(movedTo("https://example.com/a/", "https://www.example.com/a"), undefined);
  assert.equal(movedTo("http://example.com/a", "https://example.com/a"), undefined);
  assert.equal(movedTo("https://example.com/2026/story", "https://example.com/"), "https://example.com/");
  assert.equal(movedTo("https://example.com/a", "https://other.com/a"), "https://other.com/a");
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
