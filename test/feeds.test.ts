import { test } from "node:test";
import assert from "node:assert/strict";
import { FEED_TEXT_LIMIT, feedRecord, textNamesLink, type FeedDetail } from "../server/ingress/feeds.js";
import { isFeedCommit, matchesGlob } from "../server/discovery.js";

const BRIEF = `📻 XR DAILY BRIEF — Friday, July 17, 2026\r\n\r\n🔥 TOP SIGNALS\r\n\r\n1. [HIGH] A headline\r\n   Source: Someone — Outlet (https://example.com/a-story/) — Jul 16, 2026\r\n`;

test("a feed entry takes its date from the file name, its title from the first line and the links from the text", () => {
  const r = feedRecord({ id: "source-1" }, "briefs/xr-daily-brief-2026-07-17.txt", "abc123", BRIEF, "2026-07-18T08:00:00+02:00");
  assert.equal(r.id, "feed:source-1:briefs/xr-daily-brief-2026-07-17.txt");
  assert.equal(r.kind, "feed");
  assert.equal(r.date, "2026-07-17");
  assert.equal(r.title, "📻 XR DAILY BRIEF — Friday, July 17, 2026");
  assert.deepEqual(r.refs.urls, ["https://example.com/a-story/"]);
  assert.equal((r.detail as FeedDetail).text.includes("\r"), false);
});

test("a feed entry without a date in its name uses its commit's day, and long text is cut", () => {
  const r = feedRecord({ id: "s" }, "news.txt", "b", "x".repeat(FEED_TEXT_LIMIT + 10), "2026-07-18T08:00:00+02:00");
  assert.equal(r.date, "2026-07-18");
  assert.equal((r.detail as FeedDetail).text.length, FEED_TEXT_LIMIT);
  assert.equal((r.detail as FeedDetail).truncated, true);
});

test("a commit that changes only feed files is the feed's delivery", () => {
  assert.equal(matchesGlob("xr-daily-brief-2026-07-17.txt", ["xr-daily-brief-*.txt"]), true);
  assert.equal(matchesGlob("archive/xr-daily-brief-2026-07-17.txt", ["xr-daily-brief-*.txt"]), true);
  assert.equal(isFeedCommit([{ path: "xr-daily-brief-2026-07-17.txt" }], ["xr-daily-brief-*.txt"]), true);
  assert.equal(isFeedCommit([{ path: "xr-daily-brief-2026-07-17.txt" }, { path: "README.md" }], ["xr-daily-brief-*.txt"]), false);
  assert.equal(isFeedCommit([{ path: "xr-daily-brief-2026-07-17.txt" }], []), false);
  assert.equal(isFeedCommit([], ["*.txt"]), false);
});

test("a text names a link with or without its protocol and www", () => {
  const brief = "Source: vr.org original (Jordan Kuo, vr.org/articles/google-play-audio-glasses); also https://www.example.com/a/b/";
  assert.equal(textNamesLink(brief, "https://vr.org/articles/google-play-audio-glasses"), true);
  assert.equal(textNamesLink(brief, "https://example.com/a/b"), true);
  assert.equal(textNamesLink(brief, "https://opensource.googleblog.com/2026/11/"), false);
});
