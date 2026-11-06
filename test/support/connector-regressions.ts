import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActivityRecord, SessionDigest } from "../../shared/activity.js";
import { newCoHost } from "../../shared/cohost.js";
import type { Publication } from "../../shared/publications.js";
import type { Format, Post, Script, Suggestion, YouTubeUpload } from "../../shared/types.js";
import { youtubePublicationId } from "../../shared/publications.js";
import { getUpload, listUploads, setUpload } from "../../server/egress/youtube.js";
import { getConnection, loadProjects, publicConnection } from "../../server/projects.js";
import { inContext } from "../../server/context.js";
import * as store from "../../server/store.js";
import { query } from "../../server/db.js";
import { createProject, getProject, saveProject, sourceUsage } from "../../server/projects.js";
import { commitRecord, activityContext, activityView, saveRecord, setManualLink, setVisibility, summarizeRecord } from "../../server/ingress/sync.js";
import { newRecordKey, facetsFor } from "../../server/egress/bluesky.js";
import { getJob, listJobs } from "../../server/jobs.js";
import { statsReport } from "../../server/stats.js";
import { postsOverview } from "../../server/egress/overview.js";
import { refreshPublicationMetrics, startPublishJob, postPublications, approvePublication, assertAcyclic, cancelPublication, createPublication, deleteEgressConnection, deletePublication, getEgressConnection, listPublications, publicEgressConnection, publishDue, publishLateNow, recoverPublishing, saveEgressConnection, updatePublication } from "../../server/egress/publish.js";
import { evidenceSnapshot } from "../../server/verification.js";
import { acceptStoryDraft, discardStoryDraft, draftStory, listStoryDrafts, resolveProposedEdit, revertPost, runSessionReview, sameTitleSuggestion, sessionReviewInfo, sharedCommitsSuggestion, writeArticle, writeSocialText, generateScript } from "../../server/pipeline.js";
import type { runAgent } from "../../server/agent.js";

const emptyPost = (id: string, patch: Partial<Post> = {}): Post => ({ id, title: "Topic", createdAt: "2026-11-04T00:00:00.000Z", suggestionIds: [], materialIds: [], outputs: ["portrait"], outputDirs: [], outputStages: {}, brief: "", questions: [], scripts: {}, narration: {}, renders: {}, stage: "questions", ...patch });
const uploaded = (status: "scheduled" | "uploaded", publishAt?: string): YouTubeUpload => ({ connectionId: "c", videoId: "vid123", url: "https://www.youtube.com/shorts/vid123", status, publishAt, privacy: status === "uploaded" ? "public" : "private" });

/** A fake Bluesky server that remembers records by key, so a double post would show. */
function fakeBluesky() {
  const records = new Map<string, Record<string, unknown>>();
  const state = { fail: 0, loseAnswer: false, calls: 0, metricsCalls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (!url.includes("/xrpc/")) return original(input as string, init);
    state.calls++;
    if (url.includes("createSession")) return json({ accessJwt: "jwt", did: "did:plc:me", handle: "me.test" });
    if (url.includes("uploadBlob")) return json({ blob: { ref: "thumb" } });
    if (url.includes("getPosts")) { state.metricsCalls++; return json({ posts: [{ likeCount: 3, repostCount: 1, replyCount: 2 }] }); }
    if (url.includes("getRecord")) {
      const rkey = new URL(url).searchParams.get("rkey")!;
      return records.has(rkey) ? json({ uri: `at://did:plc:me/app.bsky.feed.post/${rkey}` }) : json({ error: "RecordNotFound" }, 400);
    }
    if (url.includes("createRecord")) {
      if (state.fail > 0) { state.fail--; return json({ error: "Down" }, 500); }
      const body = JSON.parse(String(init!.body));
      if (records.has(body.rkey)) return json({ error: "AlreadyExists" }, 400);
      records.set(body.rkey, body.record);
      if (state.loseAnswer) { state.loseAnswer = false; return json({ error: "Lost" }, 502); }
      return json({ uri: `at://did:plc:me/app.bsky.feed.post/${body.rkey}` });
    }
    return json({ error: "Unknown" }, 404);
  }) as typeof fetch;
  return { records, state, restore: () => { globalThis.fetch = original; } };
}

export async function runConnectorRegressions(t: TestContext, remove: (id: string, files: boolean) => Promise<unknown>) {
  const pid = (await createProject({ name: "Connector test", sourcePath: process.cwd() })).id;
  const inProject = <T>(work: () => Promise<T>) => inContext({ projectId: pid }, work);
  const never = async () => false, always = async () => true;
  const sid = getProject(pid).settings.primarySourceId;

  await t.test("records appear per day, with notes and materials, and git-only evidence stays as it is", async () => {
    const commit = commitRecord({ sourceId: sid, sourceLabel: "S", hash: "abc1234def", date: new Date(2026, 10, 3, 10).toISOString(), subject: "Add the shop", body: "", files: [{ path: "shop.ts", added: 1, removed: 0 }], addedObjects: [] });
    await saveRecord(pid, commit);
    const view = await inProject(() => activityView({ from: "2026-11-03", to: "2026-11-03" }));
    assert.ok(view.records.some((r) => r.id === commit.id));
    await store.saveMaterial(pid, { id: "mat-activity", title: "Shop picture", createdAt: "2026-11-03T10:00:00.000Z", date: "2026-11-03", kind: "image", fileName: "a.png", contentType: "image/png", size: 1, key: "materials/a.png", thumbKey: "materials/a-t.png", previewKey: "materials/a-p.png", annotation: "", tags: [] } as never);
    const withMaterial = await inProject(() => activityView({ from: "2026-11-03", to: "2026-11-03" }));
    assert.deepEqual(withMaterial.records.find((r) => r.id === "material:mat-activity")?.detail, { thumbKey: "materials/a-t.png" });
    assert.equal(await inProject(() => activityContext(pid, emptyPost("x"))), "", "a project with only Git adds nothing to its agents' prompts");
    const evidence = await evidenceSnapshot(pid, emptyPost("x"));
    assert.equal("activity" in JSON.parse(evidence), false);
  });

  const session = (id: string, commits: string[], visibility: ActivityRecord["visibility"] = "private", aiSummary?: SessionDigest["aiSummary"]): ActivityRecord => ({
    id, connector: "claude-sessions", sourceId: "s", kind: "session", startedAt: new Date(2026, 10, 3, 9).toISOString(), endedAt: new Date(2026, 10, 3, 11).toISOString(), date: "2026-11-03", title: "Session", summary: "",
    refs: { commits, files: ["shop.ts"], urls: [], issues: [] }, visibility, contentHash: "",
    detail: { tool: "claude", sessionId: id, activeMinutes: [600], files: ["shop.ts"], commands: [], commits, checks: [], prompts: ["Make the shop PRIVATE-PROMPT"], aiSummary } satisfies SessionDigest,
  });

  await t.test("a session's other-work exclusion follows its digest until the developer chooses", async () => {
    const id = "claude-sessions:other:2026-11-03";
    const digestOf = (otherFiles: string[], files: string[]) => { const r = session(id, []); return { ...r, refs: { ...r.refs, files }, detail: { ...(r.detail as SessionDigest), files, otherFiles } }; };
    const stored = async () => (await inProject(() => activityView({ from: "2026-11-03", to: "2026-11-03" }))).records.find((r) => r.id === id)!;
    await saveRecord(pid, digestOf(["h1"], []));
    assert.equal((await stored()).visibility, "excluded");
    assert.match((await stored()).title, /Make the shop/, "the first prompt names an untitled session");
    await saveRecord(pid, digestOf([], ["a", "b", "c", "d", "e"]));
    assert.equal((await stored()).visibility, "private", "more edits inside the project bring it back");
    await inProject(() => setVisibility(id, "excluded"));
    await saveRecord(pid, digestOf([], ["f"]));
    assert.equal((await stored()).visibility, "excluded", "the developer's choice holds");
    await saveRecord(pid, { ...digestOf([], ["f"]), detail: { ...(digestOf([], ["f"]).detail as SessionDigest), prompts: ["Earlier"] } }, true);
    assert.deepEqual(((await stored()).detail as SessionDigest).prompts, ["Earlier"], "a log read from its start rebuilds the record");
    assert.equal((await stored()).visibility, "excluded", "and the developer's choice still holds");
    await query("DELETE FROM activity WHERE project_id = $1 AND id = $2", [pid, id]);
  });

  await t.test("a session informs a post's agents only through its summary, and an excluded one never does", async () => {
    await store.insertSuggestion(pid, { id: "sug-shop", title: "Shop", summary: "S", whyItMatters: "", highlights: "", workDate: "2026-11-03", hook: "", kind: "other", appeal: 3, recommendedFormat: "either", suggestedShots: [], materialIds: [], createdAt: "2026-11-04T00:00:00.000Z", status: "approved", sources: { commits: [`${sid}:abc1234def`], files: [], notes: [] } } as never);
    const post = emptyPost("ep-activity", { suggestionIds: ["sug-shop"] });
    await store.savePost(pid, post);
    const sessionId = "claude-sessions:one:2026-11-03";
    await saveRecord(pid, session(sessionId, ["abc1234"]));
    await inProject(() => setVisibility(sessionId, "private"));
    assert.equal(await inProject(() => activityContext(pid, post)), "", "without a summary, a session adds nothing");

    const agent = (async (opts: { prompt: string }) => {
      assert.match(opts.prompt, /PRIVATE-PROMPT/, "the summary run reads the digest");
      return { agent: "claude", output: { attempted: "Built a shop UI", failed: "Prices overflowed", changedCourse: "", shipped: "The shop" } };
    }) as unknown as typeof runAgent;
    await inProject(() => summarizeRecord(sessionId, () => {}, agent, "claude"));
    let calls = 0;
    await inProject(() => summarizeRecord(sessionId, () => {}, (async () => { calls++; return {}; }) as unknown as typeof runAgent, "claude"));
    assert.equal(calls, 0, "an unchanged digest reuses its summary");

    const context = await inProject(() => activityContext(pid, post));
    assert.match(context, /Prices overflowed/);
    assert.match(context, /Don't quote them/);
    assert.doesNotMatch(context, /PRIVATE-PROMPT/, "prompts stay out of what writers read");
    const before = await evidenceSnapshot(pid, post);
    assert.match(before, /Prices overflowed/, "the co-host's check sees the same background");

    await inProject(() => setManualLink(`git:${sid}:abc1234def`, sessionId, true));
    assert.equal(await inProject(() => activityContext(pid, post)), "", "a split removes the session from the thread");
    await query("DELETE FROM activity_links WHERE project_id = $1", [pid]);
    await inProject(() => setManualLink(`git:${sid}:abc1234def`, sessionId, false));
    assert.match(await inProject(() => activityContext(pid, post)), /Prices overflowed/);

    await inProject(() => setVisibility(sessionId, "excluded"));
    assert.equal(await inProject(() => activityContext(pid, post)), "", "an excluded session reaches no agent");
    await assert.rejects(inProject(() => setVisibility(sessionId, "public")), /stay private or excluded/);
    await assert.rejects(inProject(() => summarizeRecord(sessionId, () => {}, agent, "claude")), /excluded/);
  });

  const blueskyConnection = await saveEgressConnection({ connector: "bluesky", name: "Test account", config: { handle: "me.test" }, secrets: { appPassword: "test-app-password" } });

  await t.test("a session review adds topics and evidence, and changes existing text only through an accepted edit", async () => {
    const WEEK = { from: "2026-10-12", to: "2026-10-18" };
    const reviewed = (id: string, visibility: ActivityRecord["visibility"] = "private") => ({ ...session(id, [], visibility), date: "2026-10-14" });
    await saveRecord(pid, reviewed("claude-sessions:review:2026-10-14"));
    await saveRecord(pid, { ...reviewed("claude-sessions:review-excluded:2026-10-14", "excluded"), visibilityChosen: true });
    const add = async (id: string, title: string, status: Suggestion["status"]) => store.insertSuggestion(pid, { id, createdAt: "2026-10-14T00:00:00Z", workDate: "2026-10-14", title, hook: "Old hook", summary: "Old summary", whyItMatters: "Old why", kind: "other", appeal: 3, recommendedFormat: "either", sources: { commits: [], files: [], notes: [] }, materialIds: [], suggestedShots: [], highlights: "Mine", status });
    await add("sr-open", "Open topic", "proposed");
    await add("sr-covered", "Covered topic", "approved");
    await add("sr-used", "Used topic", "used");
    await add("sr-dismissed", "Dismissed topic", "dismissed");
    const session_id = "claude-sessions:review:2026-10-14";
    const raw = (title: string) => ({ title, duplicateOf: "", hook: "New", summary: title, whyItMatters: "", kind: "story", appeal: 3, recommendedFormat: "short", workDate: "2026-10-14", commits: [], files: [], notes: [], materials: [], suggestedShots: [], sessions: [session_id, "claude-sessions:foreign:2026-10-14"] });
    const edit = (suggestionId: string) => ({ suggestionId, hook: "New hook", summary: "New summary", whyItMatters: "New why", reason: "The sessions show the real difficulty.", commits: [], sessions: [session_id] });
    let calls = 0;
    const writer = (async ({ prompt }: { prompt: string }) => {
      calls++;
      const evidence = JSON.parse(fs.readFileSync(/JSON file: ([^\r\n]+)/.exec(prompt)![1], "utf8"));
      assert.deepEqual(evidence.sessions.map((s: { id: string }) => s.id), [session_id], "an excluded session stays out");
      assert.ok(evidence.existingSuggestions.some((s: { id: string; status: string }) => s.id === "sr-dismissed" && s.status === "dismissed"));
      return { agent: "claude", output: {
        covered: [{ suggestionId: "sr-covered", commits: [], sessions: [session_id] }, { suggestionId: "sr-dismissed", commits: [], sessions: [session_id] }, { suggestionId: "unknown", commits: [], sessions: [] }],
        edits: [edit("sr-open"), edit("sr-used"), edit("sr-dismissed")],
        suggestions: [raw("A failed experiment"), raw("dismissed TOPIC"), raw("A failed experiment")],
      } };
    }) as unknown as typeof runAgent;
    await inProject(() => runSessionReview(WEEK.from, WEEK.to, false, () => {}, undefined, writer));
    const byId = async () => new Map((await store.listSuggestions(pid)).map((s) => [s.id, s]));
    let saved = await byId();
    assert.deepEqual(saved.get("sr-covered")!.sources.sessions, [session_id]);
    assert.equal(saved.get("sr-covered")!.proposedEdit, undefined);
    assert.equal(saved.get("sr-dismissed")!.status, "dismissed");
    assert.equal(saved.get("sr-dismissed")!.proposedEdit, undefined);
    assert.equal(saved.get("sr-dismissed")!.sources.sessions, undefined);
    assert.equal(saved.get("sr-used")!.proposedEdit, undefined);
    assert.deepEqual(saved.get("sr-used")!.sources.sessions, [session_id]);
    const open = saved.get("sr-open")!;
    assert.equal(open.summary, "Old summary", "a proposed edit leaves the text alone");
    assert.equal(open.proposedEdit?.summary, "New summary");
    const added = [...saved.values()].filter((s) => s.fromSessionReview);
    assert.equal(added.length, 1, "a repeat within one answer and a dismissed topic add nothing");
    assert.equal(added[0].title, "A failed experiment");
    assert.equal(added[0].status, "proposed");
    assert.deepEqual(added[0].sources.sessions, [session_id], "only sessions from the evidence count");

    await inProject(() => runSessionReview(WEEK.from, WEEK.to, false, () => {}, undefined, writer));
    assert.equal(calls, 1, "a reviewed week isn't paid for twice");
    assert.deepEqual((await inProject(sessionReviewInfo)).processedWeeks, [WEEK.from]);

    await inProject(() => resolveProposedEdit("sr-open", true));
    saved = await byId();
    assert.equal(saved.get("sr-open")!.summary, "New summary");
    assert.equal(saved.get("sr-open")!.highlights, "Mine", "the developer's highlights stay");
    assert.equal(saved.get("sr-open")!.proposedEdit, undefined);

    await inProject(() => runSessionReview(WEEK.from, WEEK.to, true, () => {}, undefined, writer));
    assert.equal(calls, 2);
    assert.equal([...(await byId()).values()].filter((s) => s.fromSessionReview).length, 1, "reviewing a week again repeats nothing");
    await inProject(() => resolveProposedEdit("sr-open", false));
    saved = await byId();
    assert.equal(saved.get("sr-open")!.summary, "New summary", "ignoring leaves the text");
    assert.equal(saved.get("sr-open")!.proposedEdit, undefined);
  });


  await t.test("a story draft changes nothing until it is accepted, and then replaces only what was chosen", async () => {
    const add = (id: string, title: string, status: Suggestion["status"], extra: Partial<Suggestion> = {}) => store.insertSuggestion(pid, { id, createdAt: "2026-09-14T00:00:00Z", workDate: "2026-09-14", title, hook: "h", summary: "s", whyItMatters: "w", kind: "story", appeal: 3, recommendedFormat: "short", sources: { commits: [], files: [], notes: [] }, materialIds: ["mat-activity"], suggestedShots: [], highlights: "", status, ...extra });
    await add("st-retell", "Old angle", "proposed", { publishDate: "2026-12-01" });
    await add("st-overlap", "Overlap", "approved");
    await add("st-keep", "Keep me", "proposed");
    await add("st-used", "In a post", "used", { postId: "some-post" });
    await add("st-dismissed", "Dismissed", "dismissed");
    const session_id = "claude-sessions:story:2026-09-15";
    await saveRecord(pid, { ...session(session_id, []), date: "2026-09-15" });
    await saveRecord(pid, { ...session("claude-sessions:story-excluded:2026-09-15", [], "excluded"), date: "2026-09-15", visibilityChosen: true });
    let prompt = "";
    const writer = (async (opts: { prompt: string }) => {
      prompt = opts.prompt;
      const evidence = JSON.parse(fs.readFileSync(/JSON file: ([^\r\n]+)/.exec(opts.prompt)![1], "utf8"));
      assert.deepEqual(evidence.sessions.map((x: { id: string }) => x.id), [session_id], "an excluded session stays out");
      assert.equal(evidence.retell.id, "st-retell");
      assert.equal(evidence.existingSuggestions.find((x: { id: string }) => x.id === "st-used").inPost, true);
      assert.ok(Array.isArray(evidence.posts));
      return { agent: "claude", output: {
        suggestion: { title: "New angle", duplicateOf: "", hook: "New hook", summary: "New summary", whyItMatters: "New why", kind: "tech", appeal: 4, recommendedFormat: "short", workDate: "2030-01-01", commits: ["not-a-commit"], files: ["a.cs"], notes: [], materials: ["unknown-material"], sessions: [session_id, "unknown-session"] },
        absorbs: [{ suggestionId: "st-overlap", reason: "Same story" }, { suggestionId: "st-keep", reason: "Close" }, { suggestionId: "st-used", reason: "Published" }, { suggestionId: "st-dismissed", reason: "Gone" }, { suggestionId: "unknown", reason: "?" }, { suggestionId: "st-retell", reason: "Agent says" }],
        related: [{ title: "A post", reason: "Told before" }],
        leftOut: [{ item: "A finding", reason: "Off topic" }],
        unsupported: ["The old footage"],
        shots: [{ description: "Capture this", materialId: "" }, { description: "Invented material", materialId: "unknown-material" }],
      } };
    }) as unknown as typeof runAgent;
    const before = await store.listSuggestions(pid);
    const id = await inProject(() => draftStory({ description: "I lost the footage", from: "2026-09-01", to: "2026-09-30", retellId: "st-retell", commits: [], notes: ["A ticked note"], materialIds: [] }, () => {}, undefined, writer));
    assert.match(prompt, /I lost the footage/);
    assert.deepEqual(await store.listSuggestions(pid), before, "writing a draft changes no suggestion");
    const [draft] = await inProject(listStoryDrafts);
    assert.equal(draft.id, id);
    assert.deepEqual(draft.absorbs.map((a) => a.suggestionId), ["st-retell", "st-overlap", "st-keep"], "the retold one comes first, and only open suggestions without a post can be replaced");
    assert.deepEqual(draft.related.map((r) => r.title), ["A post", "In a post"]);
    assert.equal(draft.suggestion.workDate, "2026-09-14", "a date outside the period falls back to the retold suggestion's");
    assert.deepEqual(draft.suggestion.sources.commits, []);
    assert.deepEqual(draft.suggestion.sources.sessions, [session_id]);
    assert.deepEqual(draft.suggestion.sources.notes, ["A ticked note"]);
    assert.deepEqual(draft.suggestion.materialIds, []);
    assert.deepEqual(draft.shots, [{ description: "Capture this" }, { description: "Invented material" }]);
    assert.equal(draft.suggestion.highlights, "I lost the footage");

    const created = await inProject(() => acceptStoryDraft(id, ["st-retell", "st-overlap", "st-dismissed"]));
    assert.deepEqual(created.mergedFrom, ["st-retell", "st-overlap"]);
    assert.equal(created.publishDate, "2026-12-01");
    assert.deepEqual(created.materialIds, [], "replaced suggestions' materials don't carry over");
    const saved = new Map((await store.listSuggestions(pid)).map((x) => [x.id, x]));
    assert.equal(saved.get(created.id)!.title, "New angle");
    assert.equal(saved.get("st-retell")!.status, "merged");
    assert.equal(saved.get("st-overlap")!.status, "merged");
    assert.equal(saved.get("st-keep")!.status, "proposed");
    assert.equal(saved.get("st-dismissed")!.status, "dismissed");
    assert.deepEqual(await inProject(listStoryDrafts), []);
    await assert.rejects(inProject(() => acceptStoryDraft(id, [])), /no longer exists/);

    const plain = await inProject(() => draftStory({ description: "Another", from: "2026-09-01", to: "2026-09-30", commits: [], notes: [], materialIds: [] }, () => {}, undefined, (async () => ({ agent: "claude", output: { suggestion: { title: "Alone", duplicateOf: "", hook: "", summary: "", whyItMatters: "", kind: "story", appeal: 1, recommendedFormat: "short", workDate: "2026-09-20", commits: [], files: [], notes: [], materials: [], sessions: [] }, absorbs: [], related: [], leftOut: [], unsupported: [], shots: [] } })) as unknown as typeof runAgent));
    const count = (await store.listSuggestions(pid)).length;
    await inProject(() => discardStoryDraft(plain));
    assert.deepEqual(await inProject(listStoryDrafts), []);
    assert.equal((await store.listSuggestions(pid)).length, count, "discarding adds nothing");
    await store.saveMaterial(pid, { ...(await store.getMaterials(pid, ["mat-activity"]))[0], id: "mat-story" });
    const again = await inProject(() => draftStory({ description: "Once more", from: "2026-09-01", to: "2026-09-30", commits: [], notes: [], materialIds: ["mat-activity", "mat-story"] }, () => {}, undefined, (async () => ({ agent: "claude", output: { suggestion: { title: "Alone", duplicateOf: "", hook: "", summary: "", whyItMatters: "", kind: "story", appeal: 1, recommendedFormat: "short", workDate: "2026-09-20", commits: [], files: [], notes: [], materials: [], sessions: [] }, absorbs: [], related: [], leftOut: [], unsupported: [], shots: [{ description: "Have it", materialId: "mat-story" }] } })) as unknown as typeof runAgent));
    assert.deepEqual((await inProject(listStoryDrafts))[0].shots, [{ description: "Have it", materialId: "mat-story" }]);
    await store.deleteMaterial(pid, "mat-story");
    const alone = await inProject(() => acceptStoryDraft(again, []));
    assert.equal(alone.mergedFrom, undefined);
    assert.deepEqual(alone.materialIds, ["mat-activity"], "ticked materials stay, and a material deleted since the draft is dropped");
    assert.equal((await store.listSuggestions(pid)).length, count + 1, "accepting without replacing touches nothing else");
  });
  await t.test("an identical title is a repeat, and shared commits only hint at one", () => {
    const base = { createdAt: "", workDate: "2026-10-14", hook: "", summary: "", whyItMatters: "", kind: "other" as const, appeal: 3, recommendedFormat: "either" as const, materialIds: [], suggestedShots: [], highlights: "" };
    const live: Suggestion = { ...base, id: "live", title: "Live", status: "proposed", sources: { commits: ["s:aaaaaaa1111", "s:bbbbbbb2222"], files: [], notes: [] } };
    const gone: Suggestion = { ...base, id: "gone", title: "Gone", status: "dismissed", sources: { commits: ["s:ccccccc3333"], files: [], notes: [] } };
    const merged: Suggestion = { ...base, id: "merged", title: "Live", status: "merged", sources: { commits: [], files: [], notes: [] } };
    const list = [merged, gone, live];
    assert.equal(sameTitleSuggestion({ title: " live " }, list)?.id, "live", "a live suggestion wins over a merged one");
    assert.equal(sameTitleSuggestion({ title: "Other" }, list), undefined);
    assert.equal(sharedCommitsSuggestion({ commits: ["s:aaaaaaa1111", "s:ddddddd4444"] }, list)?.id, "live");
    assert.equal(sharedCommitsSuggestion({ commits: ["s:ccccccc"] }, list)?.id, "gone");
    assert.equal(sharedCommitsSuggestion({ commits: ["s:aaaaaaa1111", "s:ddddddd4444", "s:eeeeeee5555"] }, list), undefined);
    assert.equal(sharedCommitsSuggestion({ commits: [] }, list), undefined);
    const wide: Suggestion = { ...base, id: "wide", title: "Wide", status: "proposed", sources: { commits: Array.from({ length: 10 }, (_, i) => `s:fff${i}fff${i}fff`), files: [], notes: [] } };
    assert.equal(sharedCommitsSuggestion({ commits: ["s:fff1fff1fff", "s:fff2fff2fff"] }, [wide]), undefined, "a small story inside a wide suggestion is its own topic");
  });

  await t.test("a source nothing depends on can be deleted, with what was read from it", async () => {
    const before = getProject(pid).settings;
    const extra = { id: "source-extra", label: "Accident", path: process.cwd(), contentGlobs: [] };
    await saveProject(pid, { ...before, sources: [...before.sources, extra] });
    await saveRecord(pid, commitRecord({ sourceId: extra.id, sourceLabel: "Accident", hash: "feed1234", date: new Date(2026, 10, 3, 10).toISOString(), subject: "From the accident", body: "", files: [], addedObjects: [] }));
    await store.setValue(pid, "snapshot", { [extra.id]: { commit: "x", takenAt: "t", dirty: {} }, [before.primarySourceId]: { commit: "y", takenAt: "t", dirty: {} } });
    await store.setValue(pid, "activityCursor:claude", { from: "2026-11-01", cursor: { "a.jsonl": { sourceId: extra.id, size: 1, mtimeMs: 1, offset: 1 }, "b.jsonl": { sourceId: before.primarySourceId, size: 1, mtimeMs: 1, offset: 1 } } });

    await saveProject(pid, before);
    assert.deepEqual(getProject(pid).settings.sources.map((s) => s.id), before.sources.map((s) => s.id));
    const view = await inProject(() => activityView({ from: "2026-11-03", to: "2026-11-03" }));
    assert.equal(view.records.some((r) => r.title === "From the accident"), false);
    assert.deepEqual(Object.keys((await store.getSnapshot(pid))!), [before.primarySourceId]);
    assert.deepEqual(Object.keys((await store.getValue<{ cursor: object }>(pid, "activityCursor:claude"))!.cursor), ["b.jsonl"]);

    await saveProject(pid, { ...before, sources: [...before.sources, extra] });
    await store.insertSuggestion(pid, { id: "sug-accident", title: "Cited", summary: "", whyItMatters: "", highlights: "", workDate: "2026-11-03", hook: "", kind: "other", appeal: 1, recommendedFormat: "either", suggestedShots: [], materialIds: [], createdAt: "2026-11-04T00:00:00.000Z", status: "proposed", sources: { commits: [`${extra.id}:feed1234`], files: [], notes: [] } } as never);
    assert.equal((await sourceUsage(pid))[extra.id], 1);
    await assert.rejects(saveProject(pid, before), /archive it instead/);
    await saveProject(pid, { ...before, sources: [...before.sources, { ...extra, archived: true }] });
    await query("DELETE FROM suggestions WHERE id = 'sug-accident'");
    await saveProject(pid, before);
    assert.equal((await sourceUsage(pid))[extra.id], undefined);
  });

  await t.test("connection secrets stay on the server and survive an edit without them", async () => {
    const shown = publicEgressConnection(blueskyConnection);
    assert.equal("secrets" in shown, false);
    assert.deepEqual(shown.secretsSet, ["appPassword"]);
    await saveEgressConnection({ id: blueskyConnection.id, connector: "bluesky", name: "Renamed", config: { handle: "me.test" }, secrets: { appPassword: "" } });
    assert.equal((await getEgressConnection(blueskyConnection.id)).secrets!.appPassword, "test-app-password");
  });

  const bluesky = async (postId: string, patch: Partial<Pick<Publication, "dependsOn" | "publishAt">> = {}, text = "A new shop. {{youtube.url}}") =>
    inProject(() => createPublication(postId, { connector: "bluesky", connectionId: blueskyConnection.id, content: { text, title: "Shop" }, ...patch }));
  const cleanupPublications = async (posts: string[]) => { for (const postId of posts) await query("DELETE FROM publications WHERE post_id = $1", [postId]); };
  const stateOf = async (id: string) => (await inProject(() => listPublications(pid))).find((p) => p.id === id)!;
  const youtubeDep = [{ publicationId: youtubePublicationId("ep-wait", "portrait"), when: "public" as const }];

  await t.test("a YouTube upload is a publication: listed for its post, closed to other routes", async () => {
    await store.savePost(pid, emptyPost("ep-yt", { outputs: ["portrait", "landscape"] }));
    const listed = await inProject(() => postPublications("ep-yt"));
    assert.deepEqual(listed.map((p) => [p.connector, p.content.videoFormat, p.state]), [["youtube", "portrait", "draft"], ["youtube", "landscape", "draft"]], "each video has a row before it uploads");
    assert.equal((await inProject(() => listPublications(pid, "ep-yt"))).length, 0, "those rows aren't stored until needed");
    await assert.rejects(inProject(() => createPublication("ep-yt", { connector: "youtube", connectionId: blueskyConnection.id })), /Final step/);
    const id = youtubePublicationId("ep-yt", "portrait");
    await bluesky("ep-yt", { dependsOn: [{ publicationId: id, when: "public" }] }, "Soon {{youtube.url}}");
    assert.equal((await stateOf(id)).connector, "youtube", "waiting for an upload stores its row");
    await assert.rejects(inProject(() => approvePublication(id)), /Final step/);
    await setUpload(pid, "ep-yt", "portrait", uploaded("uploaded"));
    assert.equal((await stateOf(id)).state, "published");
    assert.equal((await stateOf(id)).id, id);
    await assert.rejects(inProject(() => createPublication("ep-yt", { connector: "bluesky", connectionId: blueskyConnection.id, dependsOn: [{ publicationId: youtubePublicationId("ep-other", "portrait"), when: "public" }] })), /no longer exists/);
  });

  await t.test("a dependent waits for its video to be public, then fills in the link", async () => {
    const fake = fakeBluesky();
    try {
      const future = new Date(Date.now() + 3600_000).toISOString();
      await store.savePost(pid, emptyPost("ep-wait"));
      const p = await bluesky("ep-wait", { dependsOn: youtubeDep });
      await inProject(() => publishDue({ youtubeIsPublic: always }));
      assert.equal((await stateOf(p.id)).state, "draft", "a draft doesn't move");
      await inProject(() => approvePublication(p.id));
      await inProject(() => publishDue({ youtubeIsPublic: always }));
      assert.equal((await stateOf(p.id)).state, "waiting", "no upload yet");

      await setUpload(pid, "ep-wait", "portrait", uploaded("scheduled", future));
      await inProject(() => publishDue({ youtubeIsPublic: always }));
      assert.equal((await stateOf(p.id)).state, "waiting", "uploaded isn't public while the publish time is ahead");

      await setUpload(pid, "ep-wait", "portrait", uploaded("scheduled", new Date(Date.now() - 60_000).toISOString()));
      await inProject(() => publishDue({ youtubeIsPublic: never }));
      assert.equal((await stateOf(p.id)).state, "waiting", "the platform has the last word");
      assert.equal(fake.records.size, 0);

      await inProject(() => publishDue({ youtubeIsPublic: always }));
      const done = await stateOf(p.id);
      assert.equal(done.state, "published");
      assert.match(done.result!.url!, /^https:\/\/bsky\.app\/profile\/me\.test\/post\//);
      const [record] = [...fake.records.values()] as Array<{ text: string; facets: Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ uri: string }> }>; embed: { external: { uri: string; title: string } } }>;
      assert.equal(record.text, "A new shop. https://www.youtube.com/shorts/vid123");
      assert.equal(record.embed.external.uri, "https://www.youtube.com/shorts/vid123");
      assert.equal(record.embed.external.title, "Shop");
      assert.equal(record.facets[0].features[0].uri, "https://www.youtube.com/shorts/vid123");
    } finally { fake.restore(); }
  });

  await t.test("publishing runs as a task, which reports what happened", async () => {
    const fake = fakeBluesky();
    const done = async (id: string) => { for (let i = 0; i < 200; i++) { const j = getJob(id); if (j && j.status !== "running") return j; await new Promise((r) => setTimeout(r, 25)); } throw new Error("task didn't finish"); };
    try {
      await store.savePost(pid, emptyPost("ep-job"));
      const ok = await bluesky("ep-job", {}, "Task text");
      const job = await inProject(async () => startPublishJob(await approvePublication(ok.id)));
      assert.equal(job.kind, "publish");
      const finished = await done(job.id);
      assert.equal(finished.status, "done");
      assert.ok(finished.log.some((l) => l.includes("Publishing to Bluesky")), "the task says what it does");
      assert.ok(finished.log.some((l) => l.includes("Published: https://bsky.app/")), "and where it went");
      assert.equal((await stateOf(ok.id)).state, "published");

      await store.savePost(pid, emptyPost("ep-job-fail"));
      const bad = await bluesky("ep-job-fail", {}, "Fails");
      fake.state.fail = 1;
      const failing = await done((await inProject(async () => startPublishJob(await approvePublication(bad.id)))).id);
      assert.equal(failing.status, "failed", "a publication that fails fails its task");
      assert.match(failing.error ?? "", /Bluesky 500/);

      await store.savePost(pid, emptyPost("ep-job-wait"));
      const waits = await bluesky("ep-job-wait", { dependsOn: [{ publicationId: youtubePublicationId("ep-job-wait", "portrait"), when: "public" }] }, "Later");
      const waited = await done((await inProject(async () => startPublishJob(await approvePublication(waits.id)))).id);
      assert.equal(waited.status, "done");
      assert.ok(waited.log.some((l) => l.includes("waiting until")), "a waiting publication says so");

      await store.savePost(pid, emptyPost("ep-job-tick"));
      const ticked = await bluesky("ep-job-tick", {}, "From the scheduler");
      await inProject(() => approvePublication(ticked.id));
      await inProject(() => publishDue({ asJobs: true }));
      for (let i = 0; i < 200 && (await stateOf(ticked.id)).state !== "published"; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal((await stateOf(ticked.id)).state, "published", "the scheduler's sends are tasks too");
      assert.ok(listJobs().some((j) => j.kind === "publish" && j.log.some((l) => l.includes("Published")) && j.subject?.endsWith("ep-job-tick")));
      await cleanupPublications(["ep-job-wait"]);
    } finally { fake.restore(); }
  });

  await t.test("published rows show what went out, and numbers go to the statistics", async () => {
    const fake = fakeBluesky();
    try {
      await store.savePost(pid, emptyPost("ep-details", { renders: { portrait: { package: { title: "Video title", description: "", tags: [] } } } }));
      await setUpload(pid, "ep-details", "portrait", { ...uploaded("uploaded"), videoId: "vid-details", uploadedAt: "2026-11-02T10:00:00.000Z", captions: true });
      const row = (await inProject(() => postPublications("ep-details"))).find((p) => p.connector === "youtube")!;
      assert.equal(row.result!.title, "Video title");
      assert.equal((await stateOf(row.id)).result!.title, undefined, "the title stays with the render");

      const text = await bluesky("ep-details", {}, "Numbers text");
      await inProject(() => approvePublication(text.id));
      await inProject(() => publishDue());
      assert.equal((await stateOf(text.id)).result!.sentText, "Numbers text");
      assert.equal(fake.state.metricsCalls, 0, "publishing doesn't read numbers");

      await inProject(() => refreshPublicationMetrics());
      await new Promise((r) => setTimeout(r, 5));
      await inProject(() => refreshPublicationMetrics());
      assert.equal(fake.state.metricsCalls >= 2, true);
      const report = await inProject(() => statsReport());
      const post = report.items.find((p) => p.id === text.id)!;
      assert.equal(post.platform, "Bluesky");
      assert.equal(post.title, "Numbers text");
      assert.equal(post.series.length, 2, "each refresh adds to the history");
      assert.deepEqual({ ...post.series[1], t: "" }, { t: "", likes: 3, reposts: 1, comments: 2 }, "replies count as comments, and a platform without views has none");
      assert.equal((await stateOf(text.id)).state, "published");
      await query("INSERT INTO video_stats VALUES ('vid-details', now(), 52, 7, 2)");
      const merged = await inProject(() => statsReport());
      const video = merged.items.find((p) => p.id === "vid-details")!;
      assert.equal(video.platform, "YouTube Short");
      assert.equal(video.title, "Video title");
      assert.deepEqual({ ...video.series[0], t: "" }, { t: "", views: 52, likes: 7, comments: 2 });
      assert.ok(merged.items.some((p) => p.platform === "Bluesky"), "both platforms share one list");
    } finally { fake.restore(); }
  });

  await t.test("the posts overview shows each post's destinations and what needs attention", async () => {
    const overviewOf = async (id: string) => (await inProject(() => postsOverview())).find((p) => p.id === id)!;
    await store.savePost(pid, emptyPost("ep-ov", { title: "Overview", outputs: ["portrait", "article"], suggestionIds: [], stage: "script", publishDate: "2026-12-01" }));
    let row = await overviewOf("ep-ov");
    assert.deepEqual([row.title, row.stage, row.publishDate, row.outputs], ["Overview", "script", "2026-12-01", ["portrait", "article"]]);
    assert.deepEqual(row.destinations.map((d) => [d.name, d.state]), [["YouTube Short", "Not uploaded"]], "a video goes to YouTube before it's uploaded");
    assert.deepEqual(row.attention, [], "nothing is wrong yet");

    await setUpload(pid, "ep-ov", "portrait", { connectionId: "c", status: "failed", error: "Quota" });
    row = await overviewOf("ep-ov");
    assert.deepEqual(row.destinations.map((d) => d.state), ["Failed"]);
    assert.deepEqual(row.attention, ["YouTube Short failed"]);
    await setUpload(pid, "ep-ov", "portrait", { ...uploaded("uploaded") });
    row = await overviewOf("ep-ov");
    assert.deepEqual(row.destinations.map((d) => [d.state, d.url]), [["Published", "https://www.youtube.com/shorts/vid123"]]);
    assert.deepEqual(row.attention, []);

    const late = await bluesky("ep-ov", { publishAt: new Date(Date.now() - 30 * 3600_000).toISOString() }, "Late");
    await inProject(() => approvePublication(late.id));
    await inProject(() => publishDue());
    assert.deepEqual((await overviewOf("ep-ov")).attention, ["Bluesky missed its publish time"]);
    await inProject(() => cancelPublication(late.id));
    assert.deepEqual((await overviewOf("ep-ov")).attention, [], "a cancelled publication needs nothing");

    const first = await bluesky("ep-ov", {}, "First");
    const second = await bluesky("ep-ov", { dependsOn: [{ publicationId: first.id, when: "published" }] }, "Second");
    await inProject(() => approvePublication(second.id));
    await inProject(() => cancelPublication(first.id));
    await inProject(() => publishDue());
    assert.deepEqual((await overviewOf("ep-ov")).attention, ["Bluesky needs a new decision"]);

    await saveProject(pid, { ...getProject(pid).settings, narration: { ...getProject(pid).settings.narration, voiceId: "narrator-voice" }, coHost: { ...newCoHost(), name: "Robin", voiceId: "cohost-voice" } });
    const script: Script = { format: "portrait", title: "T", metadata: { title: "T", description: "", tags: [] }, segments: [] };
    await store.savePost(pid, emptyPost("ep-ov-cohost", { presentation: { portrait: "coHost" }, scripts: { portrait: script } }));
    assert.deepEqual((await overviewOf("ep-ov-cohost")).attention, ["Co-host lines in the Short need a check"]);
    await store.savePost(pid, emptyPost("ep-ov-no-script", { presentation: { portrait: "coHost" } }));
    assert.deepEqual((await overviewOf("ep-ov-no-script")).attention, [], "without a script there's nothing to check");
    await cleanupPublications(["ep-ov"]);
  });

  await t.test("a retry can't post twice", async () => {
    const fake = fakeBluesky();
    try {
      await store.savePost(pid, emptyPost("ep-retry"));
      const p = await bluesky("ep-retry", {}, "Hello");
      await inProject(() => approvePublication(p.id));
      fake.state.loseAnswer = true;
      await inProject(() => publishDue());
      const answered = await stateOf(p.id);
      assert.equal(answered.state, "published", "a lost answer is recovered through the record key");
      assert.equal(fake.records.size, 1);

      await store.savePost(pid, emptyPost("ep-retry-2"));
      const q = await bluesky("ep-retry-2", {}, "Again");
      await inProject(() => approvePublication(q.id));
      fake.state.fail = 1;
      await inProject(() => publishDue());
      assert.equal((await stateOf(q.id)).state, "failed");
      await inProject(() => approvePublication(q.id));
      await inProject(() => publishDue());
      assert.equal((await stateOf(q.id)).state, "published");
      assert.equal(fake.records.size, 2);
      await inProject(() => publishDue());
      assert.equal(fake.records.size, 2, "another pass sends nothing");

      // A crash while publishing.
      await store.savePost(pid, emptyPost("ep-crash"));
      const r = await bluesky("ep-crash", {}, "Crash");
      await inProject(() => approvePublication(r.id));
      await query("UPDATE publications SET data = jsonb_set(data, '{state}', '\"publishing\"') WHERE id = $1", [r.id]);
      await inProject(recoverPublishing);
      assert.equal((await stateOf(r.id)).state, "approved", "Bluesky can safely go again");
      await inProject(() => publishDue());
      assert.equal((await stateOf(r.id)).state, "published");

      const linkedin = await saveEgressConnection({ connector: "linkedin", name: "Me", config: { clientId: "x" }, secrets: {} });
      await store.savePost(pid, emptyPost("ep-crash-li"));
      const li = await inProject(() => createPublication("ep-crash-li", { connector: "linkedin", connectionId: linkedin.id, content: { text: "Hi" } }));
      await inProject(() => approvePublication(li.id));
      await query("UPDATE publications SET data = jsonb_set(data, '{state}', '\"publishing\"') WHERE id = $1", [li.id]);
      await inProject(recoverPublishing);
      const stopped = await stateOf(li.id);
      assert.equal(stopped.state, "failed", "LinkedIn can't tell, so the developer decides");
      assert.match(stopped.result!.error!, /may already be there/);
    } finally { fake.restore(); }
  });

  await t.test("an edit clears only that approval, and validation blocks approval", async () => {
    await store.savePost(pid, emptyPost("ep-edit"));
    const a = await bluesky("ep-edit", {}, "First text");
    const b = await bluesky("ep-edit", { dependsOn: [{ publicationId: a.id, when: "published" }] }, "Second text");
    await inProject(() => approvePublication(a.id));
    await inProject(() => approvePublication(b.id));
    await inProject(() => updatePublication(a.id, { content: { text: "Changed" } }));
    assert.equal((await stateOf(a.id)).state, "draft");
    assert.equal((await stateOf(a.id)).approvedHash, undefined);
    assert.equal((await stateOf(b.id)).state, "approved", "the dependent keeps its own approval");
    await inProject(() => updatePublication(a.id, { content: { text: "x".repeat(301) } }));
    await assert.rejects(inProject(() => approvePublication(a.id)), /over Bluesky's 300/);
    await assert.rejects(inProject(() => deletePublication(a.id)), /waits for this one/);
    await assert.rejects(inProject(() => updatePublication(a.id, { dependsOn: [{ publicationId: b.id, when: "published" }] })), /wait for each other/);
    assert.throws(() => assertAcyclic([{ id: "a", dependsOn: [{ publicationId: "missing", when: "public" }] }]), /no longer exists/);
  });

  await t.test("a cancelled dependency moves its dependents back to draft", async () => {
    await store.savePost(pid, emptyPost("ep-cancel"));
    const a = await bluesky("ep-cancel", {}, "First");
    const b = await bluesky("ep-cancel", { dependsOn: [{ publicationId: a.id, when: "published" }] }, "Second");
    await inProject(() => approvePublication(b.id));
    await inProject(() => cancelPublication(a.id));
    await inProject(() => publishDue());
    const moved = await stateOf(b.id);
    assert.equal(moved.state, "draft");
    assert.match(moved.result!.error!, /was cancelled/);
  });

  await t.test("a missed time publishes within the limit and asks beyond it", async () => {
    const fake = fakeBluesky();
    try {
      await store.savePost(pid, emptyPost("ep-late"));
      const hours = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();
      const recent = await bluesky("ep-late", { publishAt: hours(2) }, "Recent");
      const old = await bluesky("ep-late", { publishAt: hours(30) }, "Old");
      const ahead = await bluesky("ep-late", { publishAt: new Date(Date.now() + 3600_000).toISOString() }, "Ahead");
      for (const p of [recent, old, ahead]) await inProject(() => approvePublication(p.id));
      await inProject(() => publishDue());
      assert.equal((await stateOf(recent.id)).state, "published");
      assert.equal((await stateOf(old.id)).state, "late");
      assert.equal((await stateOf(ahead.id)).state, "scheduled");
      await inProject(() => publishLateNow(old.id));
      await inProject(() => publishDue());
      assert.equal((await stateOf(old.id)).state, "published");
      assert.equal(fake.records.size, 2);
    } finally { fake.restore(); }
  });

  await t.test("the co-host check blocks a co-hosted video on every destination", async () => {
    const settings = getProject(pid).settings;
    await saveProject(pid, { ...settings, narration: { ...settings.narration, voiceId: "narrator-voice" }, coHost: { ...newCoHost(), name: "Robin", voiceId: "cohost-voice" } });
    const script = (format: Format): Script => ({ format, title: "T", metadata: { title: "T", description: "", tags: [] }, segments: [] });
    await store.savePost(pid, emptyPost("ep-gate", { presentation: { portrait: "coHost" }, scripts: { portrait: script("portrait") }, renders: { portrait: { final: "x" } } }));
    const linkedin = await saveEgressConnection({ connector: "linkedin", name: "Gate", config: { personUrn: "urn:li:person:me" }, secrets: { accessToken: "token" } });
    const p = await inProject(() => createPublication("ep-gate", { connector: "linkedin", connectionId: linkedin.id, content: { text: "Video", videoFormat: "portrait" } }));
    await inProject(() => approvePublication(p.id));
    await inProject(() => publishDue());
    const blocked = await stateOf(p.id);
    assert.equal(blocked.state, "failed");
    assert.match(blocked.result!.error!, /Check the co-host lines/);
  });

  const articleAgent = (async (opts: { schema: { properties: Record<string, unknown> } }) => {
    if ("changes" in opts.schema.properties) return { agent: "claude", output: { body: "## Shop\n\nA reviewed body about the shop.", changes: ["Explained a term"] } };
    return { agent: "claude", output: { title: "Building the shop!", summary: "How the shop came together.", tags: ["shop"], body: "## Shop\n\nA body about the shop.\n\n{{image:missing}}", images: [{ id: "missing", alt: "Nope" }], coverId: "missing" } };
  }) as unknown as typeof runAgent;

  await t.test("the article writer uses the read-through, drops unknown pictures and slugs the title", async () => {
    await store.savePost(pid, emptyPost("ep-article", { suggestionIds: ["sug-shop"] }));
    await inProject(() => writeArticle("ep-article", () => {}, "claude", articleAgent));
    const post = await store.loadPost(pid, "ep-article");
    assert.ok(post.outputs.includes("article"));
    const draft = post.article!.draft!;
    assert.equal(draft.slug, "building-the-shop");
    assert.equal(draft.coverId, undefined);
    assert.doesNotMatch(draft.body, /\{\{image:missing\}\}/);
  });

  await t.test("an article exports to a folder, and a dependent links to it", async () => {
    const fake = fakeBluesky();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "article-folder-"));
    try {
      const folder = await saveEgressConnection({ connector: "folder", name: "Local", config: { path: dir }, secrets: {} });
      const article = await inProject(() => createPublication("ep-article", { connector: "folder", connectionId: folder.id }));
      const text = await inProject(() => createPublication("ep-article", { connector: "bluesky", connectionId: blueskyConnection.id, dependsOn: [{ publicationId: article.id, when: "public" }], content: {} }));
      await inProject(() => writeSocialText(text.id, () => {}, "claude", (async (o: { prompt: string }) => { assert.match(o.prompt, /A link to the article is added/); return { agent: "claude", output: { text: "Wrote about the shop." } }; }) as unknown as typeof runAgent));
      assert.equal((await stateOf(text.id)).content.text, "Wrote about the shop. {{article.url}}");

      await inProject(() => approvePublication(article.id));
      await inProject(() => approvePublication(text.id));
      await inProject(() => publishDue());
      const file = path.join(dir, "building-the-shop", "article.md");
      assert.match(fs.readFileSync(file, "utf8"), /title: "Building the shop!"[\s\S]*A reviewed body/);
      assert.equal((await stateOf(article.id)).state, "published");
    } finally { fake.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t.test("a git site gets a commit on its own branch, and its checkout stays untouched", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "article-site-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test"); git("config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "README.md"), "site");
    git("add", "-A"); git("commit", "-qm", "init");
    fs.writeFileSync(path.join(repo, "uncommitted.txt"), "work in progress");
    try {
      const site = await saveEgressConnection({ connector: "git-site", name: "Site", config: { repoPath: repo, contentDir: "content/blog" }, secrets: {} });
      const p = await inProject(() => createPublication("ep-article", { connector: "git-site", connectionId: site.id }));
      await inProject(() => approvePublication(p.id));
      await inProject(() => publishDue());
      const done = await stateOf(p.id);
      assert.equal(done.state, "published", done.result?.error ?? "");
      assert.equal(git("branch", "--show-current"), "main", "the checkout stays on its branch");
      assert.equal(fs.readFileSync(path.join(repo, "uncommitted.txt"), "utf8"), "work in progress");
      assert.equal(fs.existsSync(path.join(repo, "content")), false, "the article isn't in the checkout");
      assert.match(git("show", "devlog/building-the-shop:content/blog/building-the-shop.md"), /A reviewed body/);
      assert.equal(git("worktree", "list").split("\n").length, 1, "the temporary worktree is gone");
      assert.equal(git("remote"), "", "nothing was pushed");
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

  await t.test("a post that went out can't be turned back, and a connection in use stays", async () => {
    await assert.rejects(inProject(() => revertPost("ep-late", async () => {})), /already been published/);
    await store.savePost(pid, emptyPost("ep-keep"));
    const other = await saveEgressConnection({ connector: "bluesky", name: "Busy", config: { handle: "b.test" }, secrets: {} });
    const p = await inProject(() => createPublication("ep-keep", { connector: "bluesky", connectionId: other.id, content: { text: "x" } }));
    await assert.rejects(deleteEgressConnection(other.id), /hasn't gone out/);
    await inProject(() => deletePublication(p.id));
    await deleteEgressConnection(other.id);
  });

  await t.test("a co-hosted script's prompt still carries its rules after the connector wiring", async () => {
    const written: string[] = [];
    await store.savePost(pid, emptyPost("ep-prompt", { presentation: { portrait: "coHost" }, suggestionIds: ["sug-shop"] }));
    const stop = Object.assign(new Error("stop"), {});
    await assert.rejects(inProject(async () => generateScript(await store.loadPost(pid, "ep-prompt"), "portrait", () => {}, "claude", (async (o: { prompt: string }) => { written.push(o.prompt); throw stop; }) as unknown as typeof runAgent)));
    assert.match(written[0], /You are Robin/);
  });

  assert.ok(newRecordKey().length === 13);
  assert.deepEqual(facetsFor("héllo https://a.test/x").map((f) => f.index), [{ byteStart: 7, byteEnd: 23 }]);
  for (const row of await query<{ id: string }>("SELECT id FROM egress_connections")) await query("DELETE FROM egress_connections WHERE id = $1", [row.id]);
  await remove(pid, false);
}
