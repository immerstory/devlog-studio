import { describe, test } from "node:test";
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
  "/gone": adAfterCookies(),
  "/title-only": `<title>${SENTENCE}</title><p>${"Filler text. ".repeat(60)}</p>`,
  "/empty": "<title>Empty</title>",
  "/tab": `<title>Tabs</title><p>${"Filler text. ".repeat(60)}</p><p id="tab" style="display:none">${SENTENCE}</p>`,
};

/** Serves the pages for one test. */
async function serving(work: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url! in pages && req.url !== "/gone" ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
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

// The tests mostly wait for pages, so they run side by side.
describe("page views", { concurrency: 4 }, () => {
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
      const checking = checkPage(`${base}/short-ad`, { expect: "Example Film", highlight: SENTENCE });
      const trace = new PageTrace({ expect: "Example Film", highlight: SENTENCE });
      const session = await openPage({ ...shot, url: `${base}/short-ad`, source: { expect: "Example Film", highlight: SENTENCE }, highlight: SENTENCE, trace });
      try {
        assert.ok(await session.run<number>(`document.querySelectorAll(".devlog-highlight").length`) > 0);
      } finally {
        await session.close();
      }
      const check = await checking;
      assert.equal(check.ok, true, check.problem ?? "");
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
      const checking = checkPage(`${base}/long-ad`, { highlight: SENTENCE }, { trace: traces[1] });
      await assert.rejects(openPage({ ...shot, url: `${base}/long-ad`, source: { expect: "Example Film", highlight: SENTENCE }, highlight: SENTENCE, trace: traces[0] }), (err: Error) => {
        assert.equal(err.message, `The page doesn't show the sentence to highlight (“${SENTENCE}”). It was there when the page loaded, but not after the cookie choice. The page shows only: “Continue to Example in 5 seconds”.`);
        return true;
      });
      const check = await checking;
      assert.equal(check.lost, true);
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
      const checking = checkPage(`${base}/title-only`, { highlight: SENTENCE }, { trace });
      await assert.rejects(openPage({ ...shot, url: `${base}/empty`, source: { expect: "Example Film" } }), /doesn't show “Example Film”\. The page shows no text\. Check the link and the expected text of this shot\.$/);
      const titleOnly = await checking;
      assert.deepEqual(trace.steps.map((s) => s.highlightFound), [false, false]);
      assert.equal(titleOnly.problem, `The page doesn't show the sentence to highlight (“${SENTENCE}”).`);
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
    <div id="top" class="ad-slot"><script>var code;</script><div class="ad-slot">Buy now</div></div><div class="advert"></div><div class="advert"></div><script class="advert"></script><div class="promo">Promo</div><div class="promo">Promo</div><div class="teaser">Teaser</div>
    <div id="cmp" class="cookie-banner" style="position:fixed;bottom:0;left:0;right:0">This site uses cookies</div>`;
    await serving(async (base) => {
      const trace = new PageTrace({});
      const css = [".other-page { color: red; }", "@namespace svg url(http://www.w3.org/2000/svg); svg|circle { color: red; } .missing { color: red; } h1 { color: blue; } h1:hover { color: red; } p::before { content: ''; } @media (min-width: 1px) { .inner { color: red; } } @media (max-width: 1px) { .unseen { color: red; } }"];
      const session = await openPage({ ...shot, url: `${base}/busy`, hide: [".promo", ".gone", "p[", ":not(.a", ".teaser"], css, script: `document.title = "Scripted";`, trace });
      const display = await session.run<string[]>(`[".promo", ".teaser"].map((s) => getComputedStyle(document.querySelector(s)).display)`);
      await session.close();
      assert.deepEqual(display, ["none", "none"], "an invalid selector doesn't stop the ones after it");
      assert.deepEqual(trace.steps.map((s) => [s.name, s.notes]), [
        ["loaded", ["HTTP 200"]],
        ["hidden", ["Hid notices and messages: div#cmp.cookie-banner “This site uses cookies”", "Hid ads: div#top.ad-slot “Buy now”, 2 × div.advert", "Hide “.promo” matches 2 elements", "Hide “.gone” matches nothing", "Hide “p[” isn't a valid CSS selector", "Hide “:not(.a” isn't a valid CSS selector", "Hide “.teaser” matches 1 element"]],
        ["styled", ["Added the target's CSS", "Added the shot's CSS", "CSS “.missing” matches nothing", "CSS “.inner” matches nothing", "Ran the script"]],
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
      const length = { frames: 60, fps: 30 };
      const ok = await previewShot(target, { ...newPageShot("/long"), scrollTo: 99_999, zoomTo: 1.5, settleMs: 0 }, "landscape", length, () => {}, noCheck);
      assert.equal(ok.problem, undefined);
      assert.equal(ok.trace.url, `${base}/long`);
      assert.deepEqual(ok.trace.steps.map((s) => s.name), ["loaded", "start", "end"]);
      const [, start, end] = ok.trace.steps;
      assert.deepEqual(start.notes, ["Scrolled to 0 px"]);
      assert.match(end.notes[0], /^Scrolled to \d+ px; the page ends before 99999 px$/);
      assert.equal(end.notes[1], "Zoom 1.5");
      assert.deepEqual(await color(start.picture), { size: [1920, 1080], pixel: [0, 0, 1] });
      assert.deepEqual(await color(end.picture), { size: [1920, 1080], pixel: [1, 0, 0] });
      const still = await previewShot(target, { ...newPageShot("/long"), settleMs: 0 }, "landscape", length, () => {}, noCheck);
      assert.deepEqual(still.trace.steps.map((s) => s.name), ["loaded", "start"], "a still has one frame");
      const missing = await previewShot(target, { ...newPageShot("/long"), scrollTo: "#missing", settleMs: 0 }, "landscape", length, () => {}, noCheck);
      assert.equal(missing.problem, "Nothing on the page matches “#missing”.");
      assert.equal(missing.trace.steps.at(-1)?.name, "failed");
    });
  });

  test("a problem other than a missing text doesn't count as a lost text", async () => {
    await serving(async (base) => {
      const check = checkPage(`${base}/gone`, { credit: "Outlet", expect: "Large screens" });
      await assert.rejects(openPage({ ...shot, url: `${base}/gone`, source: { credit: "Outlet", expect: "Large screens" } }), { message: "The page answered HTTP 404. Check the link and the expected text of this shot." });
      assert.equal((await check).lost, undefined);
    });
  });

  test("a look at a page that hangs ends within its time, and a cancelled run isn't looked at", async () => {
    await serving(async (base) => {
      const trace = new PageTrace({});
      const session = await openPage({ ...shot, url: `${base}/plain`, realtime: true, trace });
      try {
        await session.run("setTimeout(() => { for (;;); }, 0)");
        const started = Date.now();
        await trace.step(session.page, "styled");
        // Far from the 30 seconds of the protocol, so a slow machine passes too.
        assert.ok(Date.now() - started < 20_000, `${Date.now() - started} ms`);
        assert.deepEqual(trace.steps.map((s) => s.name), ["loaded"]);
      } finally {
        await session.close();
      }
      const { cancelJob, getJob, startJob } = await import("../server/jobs.js");
      const cancelled = new PageTrace({});
      const job = await startJob("test", "page-views", async () => {
        // The job's work starts before startJob returns the job.
        await new Promise((r) => setImmediate(r));
        cancelJob(job.id);
        await openPage({ ...shot, url: `${base}/plain`, script: "throw new Error('broken')", trace: cancelled });
      });
      while (getJob(job.id)!.status === "running") await new Promise((r) => setTimeout(r, 100));
      assert.equal(getJob(job.id)!.status, "cancelled");
      assert.equal(cancelled.failed, false);
    });
  });

  /** A page whose answers the test chooses. */
  const fakePage = (evaluate: (expression: string) => Promise<unknown>, screenshot: () => Promise<unknown>) =>
    ({ url: () => "https://example.com/", evaluate, screenshot }) as unknown as import("puppeteer-core").Page;
  const never = () => new Promise<never>(() => {});

  test("a step without a picture in time leaves the later steps of its run without pictures", async () => {
    let pictures = 0;
    const page = fakePage(async () => ({ title: "", text: "Text" }), () => { pictures++; return never(); });
    const trace = new PageTrace({});
    await trace.step(page, "loaded");
    await trace.step(page, "hidden");
    assert.equal(pictures, 1);
    assert.deepEqual(trace.steps.map((s) => [s.name, s.text, s.picture]), [["loaded", "Text", undefined], ["hidden", "Text", undefined]]);
  });

  test("a page that doesn't answer is asked once until its run fails or starts over", async () => {
    let asked = 0;
    const page = fakePage(() => { asked++; return never(); }, never);
    const trace = new PageTrace({});
    await trace.step(page, "loaded");
    await trace.step(page, "hidden");
    assert.deepEqual(await trace.notes(async () => { asked++; return ["Note"]; }), []);
    assert.equal(asked, 1);
    await trace.fail(page);
    assert.equal(asked, 2);
    trace.start();
    assert.deepEqual(await trace.notes(async () => ["Note"]), ["Note"]);
  });

  test("a note that takes long is left out, and the others stay", async () => {
    const { hiddenNotes } = await import("../server/capture/browser/hidden.js");
    const page = fakePage(async (expression) => (expression.includes('data-devlog="ads"') ? never() : expression.includes('data-devlog="hide"') ? [2] : ["div#cookies"]), never);
    const started = Date.now();
    assert.deepEqual(await hiddenNotes(page, [".promo"]), ["Hid notices and messages: div#cookies", "Hide “.promo” matches 2 elements"]);
    assert.ok(Date.now() - started < 20_000, `${Date.now() - started} ms`);
  });

  test("a preview takes its frames from the same path as a capture and plays the page in between", async () => {
    // Counts page time, shows an element only once it was on screen, and opens a notice after a second.
    pages["/timer"] = `<!doctype html><title>Timer</title><p id="count">0</p><div style="height:3000px"></div><p id="seen" style="height:400px"></p><div style="height:3000px"></div><script>
      let n = 0; setInterval(() => { document.getElementById("count").textContent = ++n; }, 50);
      new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) document.getElementById("seen").textContent = "Seen on the way"; }).observe(document.getElementById("seen"));
      setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div role="dialog" aria-modal="true" style="position:fixed;inset:20%">Take our survey</div>'), 1000);
    </script>`;
    const { shotPath } = await import("../server/capture/browser/index.js");
    const fake = { run: async <T>() => 0 as T, scrollOf: async (v: number | string) => Number(v) };
    const shown = await shotPath(fake, { ...newPageShot("/"), scrollTo: 900, zoomFrom: 1, zoomTo: 2 }, { frames: 61, fps: 30 });
    assert.deepEqual([shown.frames, shown.seconds, await shown.frame(0), await shown.frame(60)], [61, 2, { scrollY: 0, zoom: 1, focusX: 0.5, focusY: 0.5, rasterZoom: 2 }, { scrollY: 900, zoom: 2, focusX: 0.5, focusY: 0.5, rasterZoom: 2 }]);
    await serving(async (base) => {
      const preview = (realtime: boolean) => previewShot({ baseUrl: base }, { ...newPageShot("/timer"), scrollTo: 5500, settleMs: 0, realtime }, "landscape", { frames: 16, fps: 5 }, () => {}, async () => {});
      for (const { trace, problem } of await Promise.all([preview(false), preview(true)])) {
        assert.equal(problem, undefined);
        assert.deepEqual(trace.steps.map((s) => s.name), ["loaded", "start", "end"]);
        const counts = trace.steps.slice(1).map((s) => parseInt(s.text, 10));
        assert.ok(counts[1] - counts[0] >= 40, `the page plays for the three seconds of the shot: ${counts.join(" to ")}`);
        assert.match(trace.steps.at(-1)!.text, /Seen on the way/, "content that shows up on the way is on the page");
        assert.doesNotMatch(trace.steps.at(-1)!.text, /survey/, "a notice that opens on the way is hidden");
      }
    });
  });
});
