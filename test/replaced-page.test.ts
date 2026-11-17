import { test } from "node:test";
import assert from "node:assert/strict";
import { isReplacedPage, REPLACED_PAGE, retryReplacedPage, SCRIPT_FAILED } from "../server/capture/browser/replaced-page.js";

const detached = () => new Error("Attempted to use detached Frame 'D50B027E5E5909CBBE3A6A5F8409CD46'.");

test("the browser's errors about a gone document count as a replaced page", () => {
  assert.ok(isReplacedPage(detached()));
  assert.ok(isReplacedPage(new Error("Execution context was destroyed, most likely because of a navigation.")));
  assert.ok(isReplacedPage(new Error("Navigating frame was detached")), "a frame that detaches while it loads");
  assert.ok(!isReplacedPage(new Error("net::ERR_NAME_NOT_RESOLVED")));
});

test("a shot script that navigates fails at once with its own error", async () => {
  const error = new Error(`${SCRIPT_FAILED}Execution context was destroyed, most likely because of a navigation.`);
  assert.ok(!isReplacedPage(error));
  let calls = 0;
  await assert.rejects(retryReplacedPage(async () => { calls++; throw error; }, () => {}), { message: error.message });
  assert.equal(calls, 1);
});

test("a page replaced once is opened again", async () => {
  const lines: string[] = [];
  let calls = 0;
  const result = await retryReplacedPage(async () => { if (++calls === 1) throw detached(); return "session"; }, (l) => lines.push(l));
  assert.equal(result, "session");
  assert.equal(calls, 2);
  assert.deepEqual(lines, ["The page reloaded itself while it was being prepared. Opening it again…"]);
});

test("a page replaced twice fails with a message that says what to do", async () => {
  let calls = 0;
  await assert.rejects(retryReplacedPage(async () => { calls++; throw detached(); }, () => {}), { message: REPLACED_PAGE });
  assert.equal(calls, 2);
});

test("other errors fail at once and keep their message", async () => {
  let calls = 0;
  await assert.rejects(retryReplacedPage(async () => { calls++; throw new Error("net::ERR_NAME_NOT_RESOLVED"); }, () => {}), { message: "net::ERR_NAME_NOT_RESOLVED" });
  assert.equal(calls, 1);
});
