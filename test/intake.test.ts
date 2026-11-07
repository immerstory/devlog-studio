import { test } from "node:test";
import assert from "node:assert/strict";
import { isDue, isIntakeTime, lastSlot, nextSlot, reviewWeeks } from "../server/intake.js";
import { weeksBetween } from "../server/pipeline.js";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

test("intake times are HH:MM on a 24-hour clock", () => {
  for (const ok of ["00:00", "06:30", "23:59"]) assert.equal(isIntakeTime(ok), true);
  for (const bad of ["24:00", "6:30", "06:60", "", undefined, 630]) assert.equal(isIntakeTime(bad), false);
});

test("the last and next slot follow the local time of day", () => {
  assert.deepEqual(lastSlot("06:00", at(2026, 11, 7, 5, 59)), at(2026, 11, 6, 6));
  assert.deepEqual(lastSlot("06:00", at(2026, 11, 7, 6, 0)), at(2026, 11, 7, 6));
  assert.deepEqual(nextSlot("06:00", at(2026, 11, 7, 6, 0)), at(2026, 11, 8, 6));
  assert.deepEqual(nextSlot("06:00", at(2026, 11, 7, 5, 0)), at(2026, 11, 7, 6));
  assert.deepEqual(lastSlot("06:00", at(2026, 3, 1, 5)), at(2026, 2, 28, 6));
});

test("a day runs once, and missed days add one run", () => {
  assert.equal(isDue("06:00", undefined, at(2026, 11, 7, 7)), false);
  assert.equal(isDue("06:00", { day: "2026-11-06" }, at(2026, 11, 7, 5)), false);
  assert.equal(isDue("06:00", { day: "2026-11-06" }, at(2026, 11, 7, 6)), true);
  assert.equal(isDue("06:00", { day: "2026-11-07" }, at(2026, 11, 7, 23)), false);
  // A later time on a day that already ran doesn't run again.
  assert.equal(isDue("22:00", { day: "2026-11-07" }, at(2026, 11, 7, 23)), false);
  assert.equal(isDue("06:00", { day: "2026-10-01" }, at(2026, 11, 7, 6)), true);
});

test("a catch-up waits for a scheduled time within the hour", () => {
  const ranAWeekAgo = { day: "2026-10-31" };
  assert.equal(isDue("18:00", ranAWeekAgo, at(2026, 11, 7, 16, 59)), true);
  assert.equal(isDue("18:00", ranAWeekAgo, at(2026, 11, 7, 17, 0)), false);
  assert.equal(isDue("18:00", ranAWeekAgo, at(2026, 11, 7, 17, 59)), false);
  assert.equal(isDue("18:00", ranAWeekAgo, at(2026, 11, 7, 18, 0)), true);
  // Shortly after midnight, the next time of 00:30 is within the hour.
  assert.equal(isDue("00:30", { day: "2026-11-05" }, at(2026, 11, 7, 0, 0)), false);
});

test("the review covers the four complete weeks before this one", () => {
  // Saturday 7 November 2026; this week starts on Monday 2 November.
  const weeks = reviewWeeks(at(2026, 11, 7, 6));
  assert.deepEqual(weeks, { from: "2026-10-05", to: "2026-11-01" });
  assert.deepEqual(weeksBetween(weeks.from, weeks.to).map((w) => w.from), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.deepEqual(reviewWeeks(at(2026, 11, 2, 6)), { from: "2026-10-05", to: "2026-11-01" });
  assert.deepEqual(reviewWeeks(at(2026, 11, 1, 6)), { from: "2026-09-28", to: "2026-10-25" });
});
