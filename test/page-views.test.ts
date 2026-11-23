import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkPage, littleText, lostAt, type PageMoment } from "../server/capture/browser/verify.js";
import { openPage } from "../server/capture/browser/render.js";
import { PageTrace } from "../server/capture/browser/trace.js";
import { previewShot } from "../server/capture/browser/preview.js";
import { newPageShot } from "../shared/types.js";

const SENTENCE = "Large screens take 47% of the weekend.";
const article = `<title>Box office: Example Film opens</title><main id="article"><h1>Example Film opens</h1><p>${"Filler text. ".repeat(60)}</p><p>${SENTENCE}</p></main>`;
/** A cookie dialog whose refuse button puts an ad in the article's place, for `ms` milliseconds or for good. */
const adAfterCookies = (ms?: number) => `${article}<div id="ad" style="display:none">Continue to Example in 5 seconds</div>
  <div id="cmp" style="position:fixed;inset:60% 0 0;background:#fff">We use cookies. <button onclick="refused()">Reject all</button></div>
  <script>
    const show = (id, on) => document.getElementById(id).style.display = on ? "block" : "none";
    function refused() { show("cmp", false); show("article", false); show("ad", true); ${ms === undefined ? "" : `setTimeout(() => { show("ad", false); show("article", true); }, ${ms});`} }
  </script>`;
// The short ad lasts longer than the wait for a reload after the cookie choice.
const pages: Record<string, string> = {
  "/plain": article,
  "/short-ad": adAfterCookies(7000),
  "/long-ad": adAfterCookies(),
  "/title-only": `<title>${SENTENCE}</title><p>${"Filler text. ".repeat(60)}</p>`,
  "/empty": "<title>Empty</title>",
  "/tab": `<title>Tabs</title><p>${"Filler text. ".repeat(60)}</p><p id="tab" style="display:none">${SENTENCE}</p>`,
};

/** Serves the pages for one test. */
async function serving(work: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url! in pages ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pages[req.url!] ?? "<title>Not found</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const shot = { device: "desktop" as const, output: { width: 640, height: 360 }, settleMs: 50, hide: [], log: () => {} };
const isJpeg = (b?: Buffer) => !!b && b[0] === 0xff && b[1] === 0xd8;

test("a message names the moment a missing text was lost and quotes a page that shows little", () => {
  const moments: PageMoment[] = [{ when: "when the page loaded", title: "", text: "Story" }, { when: "after the cookie choice", title: "", text: "Ad" }];
  const shows = (text: string) => (p: { text: string }) => p.text === text;
  assert.equal(lostAt(moments, shows("Story")), " It was there when the page loaded, but not after the cookie choice.");
  assert.equal(lostAt(moments, shows("Ad")), " It was there after the cookie choice, but not a moment later.");
  assert.equal(lostAt(moments, shows("Other")), "");
  assert.equal(littleText({ title: "", text: " " }), " The page shows no text.");
  assert.equal(littleText({ title: "", text: "Please\n  wait" }), " The page shows only: “Please wait”.");
  assert.match(littleText({ title: "", text: "x".repeat(200) }), /x{120}…”\.$/);
  assert.equal(littleText({ title: "", text: "x".repeat(500) }), "");
});

test("a sentence to highlight that an ad hides for a moment is waited for", async () => {
  await serving(async (base) => {
    const check = await checkPage(`${base}/short-ad`, { expect: "Example Film", highlight: SENTENCE });
    assert.equal(check.ok, true, check.problem ?? "");
    const trace = new PageTrace({ expect: "Example Film", highlight: SENTENCE });
    const session = await openPage({ ...shot, url: `${base}/short-ad`, source: { expect: "Example Film", highlight: SENTENCE }, highlight: SENTENCE, trace });
    try {
      assert.ok(await session.run<number>(`document.querySelectorAll(".devlog-highlight").length`) > 0);
    } finally {
      await session.close();
    }
    assert.equal(trace.failed, false);
    assert.deepEqual(trace.steps.map((s) => [s.name, s.found, s.highlightFound]), [["loaded", true, true], ["cookies", true, false]], "each step tells whether the page shows the texts; the title counts for the expected text only");
  });
});

test("a sentence that a shot's script reveals late is waited for", async () => {
  await serving(async (base) => {
    const session = await openPage({ ...shot, url: `${base}/tab`, script: `setTimeout(() => { document.getElementById("tab").style.display = "block"; }, 2000);`, source: { highlight: SENTENCE }, highlight: SENTENCE });
    try {
      assert.ok(await session.run<number>(`document.querySelectorAll(".devlog-highlight").length`) > 0);
    } finally {
      await session.close();
    }
  });
});

test("a failed page comes with what the browser showed and when the text was lost", async () => {
  await serving(async (base) => {
    const traces = [new PageTrace({ highlight: SENTENCE }), new PageTrace({ highlight: SENTENCE })];
    await assert.rejects(openPage({ ...shot, url: `${base}/long-ad`, source: { expect: "Example Film", highlight: SENTENCE }, highlight: SENTENCE, trace: traces[0] }), (err: Error) => {
      assert.equal(err.message, `The page doesn't show the sentence to highlight (“${SENTENCE}”). It was there when the page loaded, but not after the cookie choice. The page shows only: “Continue to Example in 5 seconds”.`);
      return true;
    });
    const check = await checkPage(`${base}/long-ad`, { highlight: SENTENCE }, { trace: traces[1] });
    assert.match(check.problem ?? "", /It was there when the page loaded, but not after the cookie choice\./);
    for (const trace of traces) {
      assert.ok(trace.failed);
      assert.deepEqual(trace.steps.map((s) => s.name), ["loaded", "cookies", "failed"]);
      assert.deepEqual(trace.steps.map((s) => s.notes), [["HTTP 200"], ["Clicked “Reject all”"], []]);
      assert.ok(trace.steps.every((s) => isJpeg(s.picture)));
      const look = trace.steps.at(-1);
      assert.equal(look?.text, "Continue to Example in 5 seconds");
      assert.equal(look?.pageUrl, `${base}/long-ad`);
      assert.equal(look?.title, "Box office: Example Film opens");
      assert.ok(isJpeg(look?.picture));
    }
  });
});

test("a sentence that only the title shows can't be highlighted, and a text that never appeared points at the link", async () => {
  await serving(async (base) => {
    const trace = new PageTrace({ highlight: SENTENCE });
    const titleOnly = await checkPage(`${base}/title-only`, { highlight: SENTENCE }, { trace });
    assert.deepEqual(trace.steps.map((s) => s.highlightFound), [false, false]);
    assert.equal(titleOnly.problem, `The page doesn't show the sentence to highlight (“${SENTENCE}”).`);
    await assert.rejects(openPage({ ...shot, url: `${base}/empty`, source: { expect: "Example Film" } }), /doesn't show “Example Film”\. The page shows no text\. Check the link and the expected text of this shot\.$/);
  });
});

test("a page that fails while it is filmed can be looked at on its paused clock, and an address that doesn't load can't", async () => {
  await serving(async (base) => {
    const trace = new PageTrace({});
    const session = await openPage({ ...shot, url: `${base}/plain`, trace });
    try {
      await assert.rejects(session.scrollOf("#missing"), /Nothing on the page matches/);
      assert.match((await session.read()).text, /47% of the weekend/);
      await session.fail();
      const look = trace.steps.at(-1);
      assert.equal(look?.name, "failed");
      assert.match(look?.text ?? "", /47% of the weekend/);
      assert.ok(isJpeg(look?.picture));
    } finally {
      await session.close();
    }
  });
  const trace = new PageTrace({});
  // Nothing listens on the port once its server is closed.
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const { port } = closed.address() as AddressInfo;
  await new Promise((r) => closed.close(r));
  await assert.rejects(openPage({ ...shot, url: `http://127.0.0.1:${port}/`, trace }));
  assert.deepEqual(trace.steps, []);
});

test("a step names what was hidden, selectors that match nothing, and the CSS and script that ran", async () => {
  pages["/busy"] = `<title>Busy</title><div style="display:none !important" id="own">Own</div><main><h1>Headline</h1><p>${"Filler text. ".repeat(60)}</p></main>
    <div id="top" class="ad-slot"><script>var code;</script><div class="ad-slot">Buy now</div></div><div class="advert"></div><div class="advert"></div><script class="advert"></script><div class="promo">Promo</div><div class="promo">Promo</div>
    <div id="cmp" class="cookie-banner" style="position:fixed;bottom:0;left:0;right:0">This site uses cookies</div>`;
  await serving(async (base) => {
    const trace = new PageTrace({});
    const css = [".missing { color: red; } h1 { color: blue; } h1:hover { color: red; } p::before { content: ''; }", ""];
    const session = await openPage({ ...shot, url: `${base}/busy`, hide: [".promo", ".gone", "p["], css, script: `document.title = "Scripted";`, trace });
    await session.close();
    assert.deepEqual(trace.steps.map((s) => [s.name, s.notes]), [
      ["loaded", ["HTTP 200"]],
      ["hidden", ["Hid notices and messages: div#cmp.cookie-banner “This site uses cookies”", "Hid ads: div#top.ad-slot “Buy now”, 2 × div.advert", "Hide “.promo” matches 2 elements", "Hide “.gone” matches nothing", "Hide “p[” isn't a valid CSS selector"]],
      ["styled", ["Added CSS", "CSS “.missing” matches nothing", "Ran the script"]],
    ]);
    assert.equal(trace.steps.at(-1)!.title, "Scripted");
  });
});

test("a page whose body is hidden shows no text", async () => {
  pages["/hidden"] = `<title>Hidden</title><body style="display:none"><script>var code = "${SENTENCE}";</script><p>${SENTENCE}</p></body>`;
  await serving(async (base) => {
    const trace = new PageTrace({ highlight: SENTENCE });
    const check = await checkPage(`${base}/hidden`, { highlight: SENTENCE }, { trace });
    assert.match(check.problem ?? "", /The page shows no text\.$/);
    assert.deepEqual(trace.steps.map((s) => [s.text, s.highlightFound]), [["", false], ["", false]]);
  });
});

test("a page that is opened again starts its trace over", () => {
  const trace = new PageTrace({});
  trace.add("loaded", { pageUrl: "https://example.com/", title: "", text: "" });
  trace.start();
  assert.deepEqual(trace.steps, []);
});

test("a preview takes the first and the last frame, and names the problem that would fail the capture", async () => {
  pages["/long"] = `<!doctype html><title>Long</title><style>body { margin: 0 }</style><div style="height:2000px;background:#00f"></div><div id="end" style="height:2000px;background:#f00">End</div>`;
  await serving(async (base) => {
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const color = async (picture?: Buffer) => {
      const image = await loadImage(picture!);
      const ctx = createCanvas(image.width, image.height).getContext("2d");
      ctx.drawImage(image, 0, 0);
      return { size: [image.width, image.height], pixel: [...ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data.slice(0, 3)].map((v) => (v > 127 ? 1 : 0)) };
    };
    const target = { baseUrl: base };
    const noCheck = async () => {};
    const ok = await previewShot(target, { ...newPageShot("/long"), scrollTo: 99_999, zoomTo: 1.5, settleMs: 0 }, "landscape", 4, () => {}, noCheck);
    assert.equal(ok.problem, undefined);
    assert.equal(ok.trace.url, `${base}/long`);
    assert.deepEqual(ok.trace.steps.map((s) => s.name), ["loaded", "start", "end"]);
    const [, start, end] = ok.trace.steps;
    assert.deepEqual(start.notes, ["Scrolled to 0 px"]);
    assert.match(end.notes[0], /^Scrolled to \d+ px; the page ends before 99999 px$/);
    assert.equal(end.notes[1], "Zoom 1.5");
    assert.deepEqual(await color(start.picture), { size: [1920, 1080], pixel: [0, 0, 1] });
    assert.deepEqual(await color(end.picture), { size: [1920, 1080], pixel: [1, 0, 0] });
    const still = await previewShot(target, { ...newPageShot("/long"), settleMs: 0 }, "landscape", 4, () => {}, noCheck);
    assert.deepEqual(still.trace.steps.map((s) => s.name), ["loaded", "start"], "a still has one frame");
    const missing = await previewShot(target, { ...newPageShot("/long"), scrollTo: "#missing", settleMs: 0 }, "landscape", 4, () => {}, noCheck);
    assert.equal(missing.problem, "Nothing on the page matches “#missing”.");
    assert.equal(missing.trace.steps.at(-1)?.name, "failed");
  });
});
