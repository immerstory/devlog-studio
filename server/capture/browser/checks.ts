import { defaultPageDevice, type PageCheck, type PageShot, type Post } from "../../../shared/types.js";
import { DEFAULT_PAGE_HEADERS, parseHeaders } from "../../../shared/projects.js";
import { projectId } from "../../context.js";
import { throwIfCancelled } from "../../jobs.js";
import { getProject } from "../../projects.js";
import { getSuggestions, getValue, setValue } from "../../store.js";
import { pageUrl } from "./index.js";
import { checkPage, isSourceShot } from "./verify.js";
import { feedTexts, textNamesLink } from "../../ingress/feeds.js";

/** One check per page and the texts it looked for, so two shots of one page with different sentences keep their own. */
const key = (url: string, expect?: string, highlight?: string) => `pageCheck:${url}|${expect?.trim() ?? ""}|${highlight?.trim() ?? ""}`;

/** Keeps the latest check of a page, for the shot editor. */
export const savePageCheck = (check: PageCheck) => setValue(projectId(), key(check.url, check.expect, check.highlight), check);

/** The webpage shots of a script with their resolved addresses. Shots of a missing or invalid target are left out. */
function pageShots(post: Post, format: keyof Post["scripts"]) {
  const settings = getProject().settings;
  return (post.scripts[format]?.segments ?? []).flatMap((seg, index) => {
    const v = seg.visual;
    if (v.type !== "capture" || v.shot.model !== "page") return [];
    const target = settings.captureTargets.find((t) => t.id === (v.targetId ?? settings.defaultCaptureTargetId));
    if (target?.kind !== "browser") return [];
    try {
      return [{ segmentId: seg.id, index, url: pageUrl(target.config, v.shot.url), shot: v.shot as PageShot, target: target.config, device: (v.shot as PageShot).device ?? defaultPageDevice(format) }];
    } catch {
      return [];
    }
  });
}

/**
 * Source shots whose link the feed entries behind the post don't name. The link may still be right, but nobody
 * chose it: the script writer found or built it.
 */
async function unlistedShots(post: Post, shots: ReturnType<typeof pageShots>): Promise<Set<string>> {
  const texts = await feedTexts(projectId(), await getSuggestions(projectId(), post.suggestionIds));
  if (!texts.length) return new Set();
  return new Set(shots.filter((s) => isSourceShot(s.shot) && !texts.some((t) => textNamesLink(t, s.url))).map((s) => s.segmentId));
}

/** The latest check of each webpage shot of a script, by segment, and the source shots whose link the feed doesn't name. */
export async function pageChecks(post: Post, format: keyof Post["scripts"]): Promise<{ checks: Record<string, PageCheck | null>; unlisted: string[] }> {
  const shots = pageShots(post, format);
  const checks: Record<string, PageCheck | null> = {};
  for (const shot of shots) {
    checks[shot.segmentId] = (await getValue<PageCheck>(projectId(), key(shot.url, shot.shot.expect, shot.shot.highlight))) ?? null;
  }
  return { checks, unlisted: [...await unlistedShots(post, shots)] };
}

/** Opens every webpage shot's page without filming it, and keeps what each showed. */
export async function checkPostLinks(post: Post, format: keyof Post["scripts"], log: (line: string) => void) {
  const shots = pageShots(post, format);
  if (!shots.length) { log("This script has no webpage shots."); return { checked: 0, failed: 0 }; }
  let failed = 0;
  const unlisted = await unlistedShots(post, shots);
  for (const s of shots) {
    throwIfCancelled();
    log(`Segment ${s.index + 1}: ${s.url}`);
    const check = await checkPage(s.url, s.shot, { userAgent: s.target.userAgent, headers: parseHeaders(s.target.headers ?? DEFAULT_PAGE_HEADERS), device: s.device });
    await savePageCheck(check);
    if (check.ok) log(`  OK${check.title ? `: “${check.title}”` : ""}`);
    else { failed++; log(`  ${check.problem}`); }
    if (unlisted.has(s.segmentId)) log("  The feed entries behind this post don't name this link. Check that it is the article the segment cites.");
  }
  log(`${shots.length - failed} of ${shots.length} page(s) passed.`);
  return { checked: shots.length, failed };
}
