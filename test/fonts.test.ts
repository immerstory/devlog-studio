import { test } from "node:test";
import assert from "node:assert/strict";
import { drawsLetters, GENERIC_FAMILIES, letterFamily } from "../server/render.js";

test("every generic family that videos use draws letters on this machine", () => {
  for (const family of GENERIC_FAMILIES) assert.ok(drawsLetters(family), `${family} draws no letters`);
});

test("a generic family without letters takes the first candidate that draws them", () => {
  const draws = (font: string) => font !== "'Emoji'";
  assert.equal(letterFamily([undefined, "Emoji", "Sans", "Serif"], draws), "Sans");
  assert.equal(letterFamily(["Emoji"], draws), undefined);
});
