import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadDismissed, pruneDismissed, saveDismissed } from "../web/dismissed-jobs.js";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.assign(globalThis, {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  });
});

test("hidden tasks survive a reload", () => {
  saveDismissed(new Set(["job-a", "job-b"]));
  assert.deepEqual([...loadDismissed()].sort(), ["job-a", "job-b"]);
});

test("unreadable storage hides nothing", () => {
  store.set("devlog.dismissedJobs", "{not json");
  assert.equal(loadDismissed().size, 0);
  store.set("devlog.dismissedJobs", JSON.stringify({ id: "job-a" }));
  assert.equal(loadDismissed().size, 0);
});

test("pruning drops tasks the server no longer lists and keeps the set when nothing goes", () => {
  const hidden = new Set(["job-a", "job-b"]);
  assert.equal(pruneDismissed(hidden, new Set(["job-a", "job-b", "job-c"])), hidden);
  assert.deepEqual([...pruneDismissed(hidden, new Set(["job-b"]))], ["job-b"]);
});
