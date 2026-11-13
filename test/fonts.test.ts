import { test } from "node:test";
import assert from "node:assert/strict";
import { drawsLetters, letterFamily } from "../server/render.js";
import { FONT_STACKS } from "../video/renderer.js";

test("the font stacks of a video's text draw letters on this machine", () => {
  for (const [name, stack] of Object.entries(FONT_STACKS)) assert.ok(drawsLetters(stack), `the ${name} stack draws no letters`);
});

test("a fallback family takes the first candidate that draws letters", () => {
  const draws = (font: string) => font !== "'Emoji'";
  assert.equal(letterFamily([undefined, "Emoji", "Sans", "Serif"], draws), "Sans");
  assert.equal(letterFamily(["Emoji"], draws), undefined);
});
