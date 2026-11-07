import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActivityRecord } from "../../shared/activity.js";
import type { Source } from "../../shared/projects.js";
import type { Suggestion } from "../../shared/types.js";
import { projectId } from "../context.js";
import { activeSources, matchesGlob } from "../discovery.js";
import { getValue, setValue } from "../store.js";
import type { DateRange } from "./provider.js";
import { localDate } from "./provider.js";
import { shorten } from "./redact.js";
import { listRecords, saveRecord } from "./sync.js";

const run = promisify(execFile);
const git = async (source: Source, args: string[]) => (await run("git", args, { cwd: source.path, maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;

/** Characters of one entry that are stored and reach an agent. */
export const FEED_TEXT_LIMIT = 64_000;
const URL = /https?:\/\/[^\s)>\]"']+/g;
const DATE_IN_NAME = /(\d{4}-\d{2}-\d{2})/;

export interface FeedDetail {
  path: string;
  /** Git blob of the text at the time it was read. */
  blob: string;
  text: string;
  truncated?: boolean;
}

export const feedRecordId = (sourceId: string, path: string) => `feed:${sourceId}:${path}`;

/** One entry as an activity record. The date comes from the file name, else from its latest commit. */
export function feedRecord(source: Pick<Source, "id">, path: string, blob: string, raw: string, committedAt: string): ActivityRecord {
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const date = DATE_IN_NAME.exec(path.split("/").pop() ?? "")?.[1] ?? localDate(committedAt);
  const detail: FeedDetail = { path, blob, text: text.slice(0, FEED_TEXT_LIMIT), ...(text.length > FEED_TEXT_LIMIT ? { truncated: true } : {}) };
  return {
    id: feedRecordId(source.id, path),
    connector: "feed",
    sourceId: source.id,
    kind: "feed",
    startedAt: committedAt,
    endedAt: committedAt,
    date,
    title: shorten(lines[0] ?? path, 120),
    summary: shorten(lines.slice(1).join(" "), 400),
    refs: { commits: [], files: [path], urls: [...new Set(text.match(URL) ?? [])].slice(0, 40), issues: [] },
    visibility: "public",
    contentHash: "",
    detail,
  };
}

/** Committed files of the source that match its feed globs, with their blobs. */
async function feedFiles(source: Source): Promise<Array<{ path: string; blob: string }>> {
  const tree = await git(source, ["ls-tree", "-r", "-z", "HEAD"]);
  return tree.split("\0").filter(Boolean).flatMap((entry) => {
    const [meta, path] = entry.split("\t");
    const [, type, blob] = meta.split(" ");
    return type === "blob" && matchesGlob(path, source.feedGlobs ?? []) ? [{ path, blob }] : [];
  });
}

/**
 * Reads the committed feed files of every source that has feed globs. A file is read again only when its blob changes,
 * and a file dated before the range is left out.
 */
export async function syncFeeds(range: DateRange, log: (line: string) => void = () => {}): Promise<{ records: number; errors: string[] }> {
  const pid = projectId();
  let records = 0;
  const errors: string[] = [];
  for (const source of activeSources().filter((s) => s.feedGlobs?.length)) {
    const key = `activityCursor:feed:${source.id}`;
    const blobs = (await getValue<{ blobs: Record<string, string> }>(pid, key))?.blobs ?? {};
    let count = 0;
    try {
      for (const file of await feedFiles(source)) {
        if (blobs[file.path] === file.blob) continue;
        const nameDate = DATE_IN_NAME.exec(file.path.split("/").pop() ?? "")?.[1];
        if (nameDate && nameDate < range.from) continue;
        const committedAt = (await git(source, ["log", "-1", "--format=%aI", "--", file.path])).trim() || new Date().toISOString();
        if (!nameDate && localDate(committedAt) < range.from) continue;
        const text = await git(source, ["cat-file", "blob", file.blob]);
        await saveRecord(pid, feedRecord(source, file.path, file.blob, text, committedAt));
        blobs[file.path] = file.blob;
        count++;
      }
    } catch (err) {
      const message = `Feed ${source.label}: ${(err as Error).message}`;
      errors.push(message);
      log(message);
    }
    await setValue(pid, key, { blobs });
    log(`Feed ${source.label}: ${count} new or changed entr${count === 1 ? "y" : "ies"}.`);
    records += count;
  }
  return { records, errors };
}

/** The texts of the feed entries behind some topics. */
export async function feedTexts(pid: string, suggestions: Array<Pick<Suggestion, "sources">>): Promise<string[]> {
  const ids = new Set(suggestions.flatMap((s) => s.sources.feeds ?? []));
  if (!ids.size) return [];
  return (await listRecords(pid)).filter((r) => ids.has(r.id)).map((r) => (r.detail as FeedDetail).text);
}

const bareLink = (url: string) => url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[/#?]+$/, "").toLowerCase();
/** True when a text names the link, with or without its protocol and "www.". */
export const textNamesLink = (text: string, url: string) => !!bareLink(url) && text.toLowerCase().replace(/https?:\/\//g, "").replace(/\bwww\./g, "").includes(bareLink(url));

/** The text of the feed entries behind a post's topics, with the rules for using it. Empty when no topic comes from a feed. */
export async function feedContext(pid: string, suggestions: Array<Pick<Suggestion, "sources">>): Promise<string> {
  const ids = new Set(suggestions.flatMap((s) => s.sources.feeds ?? []));
  if (!ids.size) return "";
  const entries = (await listRecords(pid)).filter((r) => ids.has(r.id) && r.visibility !== "excluded");
  if (!entries.length) return "";
  return `News feed entries behind these topics, compiled by the author:
- The entry's analysis, drafts and comment suggestions are the author's own words. You may use them.
- Facts and quotes from the cited articles belong to their publishers. Summarize them, name the outlet and the author, and quote at most one short sentence per source.
- Leave out internal notes: reminders, tagging ideas, people to contact, and notes about how the entry was made.
- Write only about the items the topics cover.

${entries.map((r) => `--- Feed entry of ${r.date} (${(r.detail as FeedDetail).path}) ---\n${(r.detail as FeedDetail).text}`).join("\n\n")}`;
}
