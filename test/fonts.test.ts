import { test } from "node:test";
import assert from "node:assert/strict";
import { drawsLetters, letterFamily } from "../server/render.js";
import { FONT_STACKS } from "../video/renderer.js";
import { BUMPER_ANIMATIONS, type BumperSetup } from "../video/bumpers.js";
import "../video/extensions.js";
import { createCanvas } from "@napi-rs/canvas";

test("the font stacks of a video's text draw letters on this machine", () => {
  for (const [name, stack] of Object.entries(FONT_STACKS)) assert.ok(drawsLetters(stack), `the ${name} stack draws no letters`);
});

test("a fallback family takes the first candidate that draws letters", () => {
  const draws = (font: string) => font !== "'Emoji'";
  assert.equal(letterFamily([undefined, "Emoji", "Sans", "Serif"], draws), "Sans");
  assert.equal(letterFamily(["Emoji"], draws), undefined);
});

test("the title card draws its text on this machine", async () => {
  const setup = { platform: {}, params: { text: "Hello" }, placement: "intro", durationInFrames: 90, fps: 30, width: 320, height: 180, portrait: false, title: "Title" };
  const draw = await BUMPER_ANIMATIONS["title-card"].prepare(setup as unknown as BumperSetup);
  const canvas = createCanvas(320, 180);
  const ctx = canvas.getContext("2d");
  draw(ctx as unknown as CanvasRenderingContext2D, 45);
  const pixels = ctx.getImageData(0, 0, 320, 180).data;
  let light = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 128) light++;
  assert.ok(light > 50, "the title's letters are drawn");
});
