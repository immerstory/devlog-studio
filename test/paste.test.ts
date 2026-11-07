import { test } from "node:test";
import assert from "node:assert/strict";
import { pastedMedia } from "../web/paste";

const now = new Date(2026, 10, 7, 14, 32, 5);

test("a pasted screenshot takes its name from the time of the paste", () => {
  const [file] = pastedMedia([new File(["x"], "image.png", { type: "image/png" })], now);
  assert.equal(file.name, "Pasted 2026-11-07 14-32-05.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 1);
});

test("a pasted file without a name gets its extension from its type", () => {
  const [file] = pastedMedia([new File(["x"], "", { type: "image/webp" })], now);
  assert.equal(file.name, "Pasted 2026-11-07 14-32-05.webp");
});

test("a file copied from a folder keeps its name", () => {
  const [file] = pastedMedia([new File(["x"], "city at night.png", { type: "image/png" })], now);
  assert.equal(file.name, "city at night.png");
});

test("a paste keeps images and videos and drops other files", () => {
  const files = [new File(["x"], "notes.txt", { type: "text/plain" }), new File(["x"], "clip.mp4", { type: "video/mp4" })];
  assert.deepEqual(pastedMedia(files, now).map((file) => file.name), ["clip.mp4"]);
});
