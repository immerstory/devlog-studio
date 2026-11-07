import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_RULES, imagePrompt } from "../server/imagegen.js";

test("an image prompt drops the recording instruction and keeps the rules", () => {
  const prompt = imagePrompt("To record (vertical): a row of headsets in a charging case on a booth counter.", "portrait");
  assert.ok(prompt.startsWith("a row of headsets in a charging case"));
  assert.match(prompt, /vertical 9:16/);
  assert.ok(prompt.includes(IMAGE_RULES));
  assert.match(imagePrompt("Record vertically: a desk", "landscape"), /^a desk[\s\S]*horizontal 16:9/);
  assert.match(imagePrompt("A plain description", "portrait"), /^A plain description/);
});
