import { test } from "node:test";
import assert from "node:assert/strict";
import { pageUrl } from "../server/capture/browser/index.js";
import { defaultPageDevice, newPageShot, pageShotMoves } from "../shared/types.js";

test("page URLs resolve against the target's base URL and must be http or https", () => {
  assert.equal(pageUrl({ baseUrl: "https://example.com/app/" }, "/pricing"), "https://example.com/pricing");
  assert.equal(pageUrl({ baseUrl: "https://example.com/app/" }, "docs#intro"), "https://example.com/app/docs#intro");
  assert.equal(pageUrl({ baseUrl: "" }, "https://other.example/x"), "https://other.example/x");
  assert.throws(() => pageUrl({ baseUrl: "" }, "/pricing"), /no base URL/);
  assert.throws(() => pageUrl({ baseUrl: "https://example.com" }, "file:///C:/secret.txt"), /Only http and https/);
  assert.throws(() => pageUrl({ baseUrl: "https://example.com" }, "  "), /Enter the page URL/);
});

test("a page shot moves only when it scrolls or zooms; the device follows the format by default", () => {
  const still = newPageShot("/");
  assert.equal(pageShotMoves(still), false);
  assert.equal(pageShotMoves({ ...still, scrollTo: "#features" }), true);
  assert.equal(pageShotMoves({ ...still, scrollFrom: 0, scrollTo: "0" }), false, "0 and \"0\" are the same position");
  assert.equal(pageShotMoves({ ...still, zoomTo: 1.5 }), true);
  assert.equal(defaultPageDevice("portrait"), "phone");
  assert.equal(defaultPageDevice("landscape"), "desktop");
});

test("the agent's page shots become page shots with pixel or selector scroll targets", async () => {
  const { normalizeScript } = await import("../server/pipeline.js");
  const blank = { description: "Pricing", target: "", motion: "still" as const, angle: "front" as const, distance: "medium" as const, materialId: "", layout: "none" as const, entrance: "drop" as const, heading: "", bullets: [], imageFrom: [] as string[] };
  const s = normalizeScript({ title: "T", metadata: { title: "T", description: "", tags: [] }, segments: [
    { narration: "a", onScreen: "", visual: { ...blank, type: "capture", targetId: "web", shotModel: "page", url: "/pricing", device: "phone", scrollTo: "#plans" } },
    { narration: "b", onScreen: "", visual: { ...blank, type: "capture", targetId: "web", shotModel: "page", url: "https://example.com", device: "", scrollTo: "1200" } },
  ] }, "portrait", []);
  assert.deepEqual(s.segments[0].visual, { type: "capture", targetId: "web", description: "Pricing", shot: { ...newPageShot("/pricing"), device: "phone", scrollTo: "#plans" } });
  assert.deepEqual(s.segments[1].visual, { type: "capture", targetId: "web", description: "Pricing", shot: { ...newPageShot("https://example.com"), device: undefined, scrollTo: 1200 } });
});

test("request header lines parse into names and values; malformed lines are skipped", async () => {
  const { parseHeaders, DEFAULT_PAGE_HEADERS } = await import("../shared/projects.js");
  assert.deepEqual(parseHeaders(DEFAULT_PAGE_HEADERS), { DNT: "1", "Sec-GPC": "1" });
  assert.deepEqual(parseHeaders(["X-Test:  a: b ", "no colon", ": empty name", "Bad Name: x"]), { "X-Test": "a: b" });
  assert.deepEqual(parseHeaders([]), {});
});

test("a page move starts after its delay, runs at its speed, and eases unless linear", async () => {
  const { pageMoveProgress } = await import("../shared/types.js");
  // No speed: the move spans the shot after the delay.
  assert.equal(pageMoveProgress({ delaySeconds: 2 }, 1, 6, 1000), 0);
  assert.equal(pageMoveProgress({ delaySeconds: 2 }, 4, 6, 1000), 0.5);
  assert.equal(pageMoveProgress({ delaySeconds: 2 }, 6, 6, 1000), 1);
  // 1000 px at 250 px/s takes 4 s: done at 4 s, then holds.
  assert.equal(pageMoveProgress({ scrollSpeed: 250, easing: "linear" }, 1, 6, 1000), 0.25);
  assert.equal(pageMoveProgress({ scrollSpeed: 250, easing: "linear" }, 5, 6, 1000), 1);
  // Too slow to finish: stops partway at the end of the shot.
  assert.equal(pageMoveProgress({ scrollSpeed: 100, easing: "linear" }, 6, 6, 1000), 0.6);
  // Smooth easing starts slower than linear and meets it in the middle.
  assert.ok(pageMoveProgress({}, 1, 6, 1000) < 1 / 6);
  assert.equal(pageMoveProgress({}, 3, 6, 1000), 0.5);
});
