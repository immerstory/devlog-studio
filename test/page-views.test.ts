import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkPage, littleText, lostAt, type PageMoment } from "../server/capture/browser/verify.js";
import { openPage } from "../server/capture/browser/render.js";
import type { PageLook } from "../server/capture/browser/look.js";

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
    const looks: unknown[] = [];
    const session = await openPage({ ...shot, url: `${base}/short-ad`, source: { expect: "Example Film", highlight: SENTENCE }, highlight: SENTENCE, onLook: (look) => looks.push(look) });
    try {
      assert.ok(await session.run<number>(`document.querySelectorAll(".devlog-highlight").length`) > 0);
    } finally {
      await session.close();
    }
    assert.deepEqual(looks, [], "a page that opens isn't looked at");
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
    const looks: Array<PageLook | undefined> = [];
    const onLook = (look: PageLook | undefined) => { looks.push(look); };
    await assert.rejects(openPage({ ...shot, url: `${base}/long-ad`, source: { expect: "Example Film", highlight: SENTENCE }, highlight: SENTENCE, onLook }), (err: Error) => {
      assert.equal(err.message, `The page doesn't show the sentence to highlight (“${SENTENCE}”). It was there when the page loaded, but not after the cookie choice. The page shows only: “Continue to Example in 5 seconds”.`);
      return true;
    });
    const check = await checkPage(`${base}/long-ad`, { highlight: SENTENCE }, { onLook });
    assert.match(check.problem ?? "", /It was there when the page loaded, but not after the cookie choice\./);
    assert.equal(looks.length, 2);
    for (const look of looks) {
      assert.equal(look?.text, "Continue to Example in 5 seconds");
      assert.equal(look?.pageUrl, `${base}/long-ad`);
      assert.equal(look?.title, "Box office: Example Film opens");
      assert.ok(isJpeg(look?.picture));
    }
  });
});

test("a sentence that only the title shows can't be highlighted, and a text that never appeared points at the link", async () => {
  await serving(async (base) => {
    const titleOnly = await checkPage(`${base}/title-only`, { highlight: SENTENCE });
    assert.equal(titleOnly.problem, `The page doesn't show the sentence to highlight (“${SENTENCE}”).`);
    await assert.rejects(openPage({ ...shot, url: `${base}/empty`, source: { expect: "Example Film" } }), /doesn't show “Example Film”\. The page shows no text\. Check the link and the expected text of this shot\.$/);
  });
});

test("a page that fails while it is filmed can be looked at on its paused clock, and an address that doesn't load can't", async () => {
  await serving(async (base) => {
    const session = await openPage({ ...shot, url: `${base}/plain` });
    try {
      await assert.rejects(session.scrollOf("#missing"), /Nothing on the page matches/);
      const look = await session.look();
      assert.match(look?.text ?? "", /47% of the weekend/);
      assert.ok(isJpeg(look?.picture));
    } finally {
      await session.close();
    }
  });
  const looks: unknown[] = [];
  // Nothing listens on the port once its server is closed.
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const { port } = closed.address() as AddressInfo;
  await new Promise((r) => closed.close(r));
  await assert.rejects(openPage({ ...shot, url: `http://127.0.0.1:${port}/`, onLook: (look) => looks.push(look) }));
  assert.deepEqual(looks, [undefined]);
});
