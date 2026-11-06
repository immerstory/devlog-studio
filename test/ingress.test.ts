import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { collectSessions, commandsIn, digestHash, mergeDigests, readLines } from "../server/ingress/sessions.js";
import { redact, shorten, withoutAbsolutePaths } from "../server/ingress/redact.js";
import { correlate, threadsOf } from "../server/ingress/correlate.js";
import { collectForgejo, collectGithub, commitUrl, forgejoCall, githubRepo, parseRemote } from "../server/ingress/forge.js";
import { looksLikeOtherWork, sessionTitleOf } from "../shared/activity.js";
import { AGENT_RUN_MARKER } from "../server/agent.js";
import type { CollectEvent } from "../server/ingress/provider.js";
import type { ActivityRecord, SessionDigest } from "../shared/activity.js";

const home = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `ingress-${name}-`));
const SOURCE = path.join(os.tmpdir(), "project-source");
const sources = [{ id: "s1", label: "Game", roots: [SOURCE] }];
const at = (hour: number, minute = 0, day = 3) => new Date(2026, 10, day, hour, minute).toISOString();
const lines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const write = (file: string, text: string | Buffer) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

async function collect(generator: AsyncIterable<CollectEvent>) {
  const out = { records: [] as ActivityRecord[], unsupported: [] as string[], skipped: 0, cursor: undefined as any };
  for await (const e of generator) {
    if ("record" in e) out.records.push(e.record);
    else if ("unsupported" in e) out.unsupported.push(e.unsupported);
    else if ("skippedLines" in e) out.skipped += e.skippedLines;
    else out.cursor = e.cursor;
  }
  return out;
}
const digest = (r: ActivityRecord) => r.detail as SessionDigest;

const claudeUser = (timestamp: string, text: string, extra: object = {}) => ({ type: "user", timestamp, cwd: SOURCE, gitBranch: "main", sessionId: "c1", message: { role: "user", content: text }, ...extra });
const claudeTool = (timestamp: string, id: string, name: string, input: object) => ({ type: "assistant", timestamp, cwd: SOURCE, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const claudeResult = (timestamp: string, id: string, content: string, is_error = false) => ({ type: "user", timestamp, cwd: SOURCE, toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

test("a Claude session becomes a digest of files, commands, commits, checks and prompts", async () => {
  const root = home("claude");
  const file = path.join(SOURCE, "src", "game.ts");
  write(path.join(root, ".claude", "projects", "encoded", "c1.jsonl"), lines([
    claudeUser(at(10), "Fix the bridge physics. <pasted_content id=\"1\">SECRET PASTE</pasted_content>"),
    { type: "custom-title", customTitle: "Bridge physics", sessionId: "c1" },
    claudeTool(at(10, 1), "t1", "Edit", { file_path: file, old_string: "SECRET OLD", new_string: "SECRET NEW" }),
    claudeTool(at(10, 2), "t2", "Edit", { file_path: path.join(path.parse(SOURCE).root, "other-project", "x.ts"), old_string: "a", new_string: "b" }),
    claudeTool(at(10, 3), "t3", "Bash", { command: "npm test" }),
    claudeResult(at(10, 4), "t3", "ERROR: 1 test failed\nSECRET OUTPUT", true),
    claudeTool(at(10, 5), "t4", "Bash", { command: 'git commit -m "fix"' }),
    claudeResult(at(10, 6), "t4", "[main abc1234] fix\n 1 file changed"),
    claudeTool(at(10, 7), "t5", "Bash", { command: "cat secrets.txt" }),
    claudeResult(at(10, 8), "t5", "SECRET FILE"),
    { type: "assistant", timestamp: at(10, 9), cwd: SOURCE, message: { content: [{ type: "thinking", thinking: "SECRET THOUGHT" }, { type: "text", text: "SECRET ANSWER" }] } },
  ]));
  const { records } = await collect(collectSessions("claude-sessions", sources, { root }));
  assert.equal(records.length, 1);
  const [r] = records;
  assert.equal(r.visibility, "private");
  assert.equal(r.title, "Bridge physics");
  assert.equal(r.refs.branch, "main");
  const d = digest(r);
  assert.deepEqual(d.files, ["src/game.ts"], "a file outside the project's sources stays out");
  assert.equal(d.otherFiles!.length, 1);
  assert.equal(JSON.stringify(d).includes("other-project"), false, "only a hash of another file is kept");
  assert.deepEqual(d.commits, ["abc1234"]);
  assert.deepEqual(d.commands, ["git commit"]);
  assert.deepEqual(d.checks, [{ command: "npm test", ok: false, error: "ERROR: 1 test failed" }]);
  assert.deepEqual(d.prompts, ["Fix the bridge physics. [pasted]"]);
  const spaced = home("spaced");
  write(path.join(spaced, ".claude", "projects", "e", "c1.jsonl"), lines([claudeUser(at(10), "Example:&#x20;a shop")]));
  assert.deepEqual(digest((await collect(collectSessions("claude-sessions", sources, { root: spaced }))).records[0]).prompts, ["Example: a shop"]);
  assert.equal(JSON.stringify(r).includes("SECRET"), false, "output, contents, thinking and pasted text stay out");
});

test("a Codex session reads both event forms, and a subagent's work joins its parent", async () => {
  const root = home("codex");
  const dir = path.join(root, ".codex", "sessions", "2026", "11", "03");
  const id = "01a1a7b1-a773-7100-8c42-98ecfb4d6983", child = "01a1a7b1-a773-7100-8c42-98ecfb4d6984";
  write(path.join(dir, `rollout-2026-11-03T10-00-00-${id}.jsonl`), lines([
    { type: "session_meta", timestamp: at(10), payload: { id, cwd: SOURCE, git: { branch: "dev", commit_hash: "f00", repository_url: "git@github.com:me/game.git" } } },
    { type: "event_msg", timestamp: at(10, 1), payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "<environment_context>skip</environment_context>" }] } } },
    { type: "event_msg", timestamp: at(10, 1), payload: { type: "user_message", message: "Build the shop" } },
    { type: "event_msg", timestamp: at(10, 2), payload: { type: "item_completed", item: { type: "CommandExecution", command: ["pwsh", "-Command", "npx tsc --noEmit"], exit_code: 0, aggregated_output: "SECRET" } } },
    { type: "event_msg", timestamp: at(10, 3), payload: { type: "item_completed", item: { type: "FileChange", changes: { [path.join(SOURCE, "shop.ts")]: { type: "update", unified_diff: "SECRET" } } } } },
    { type: "event_msg", timestamp: at(10, 4), payload: { type: "exec_command_end", command: ["git", "commit", "-m", "x"], exit_code: 0, aggregated_output: "[dev 1234567] x" } },
    { type: "response_item", timestamp: at(10, 5), payload: { type: "reasoning", summary: "SECRET" } },
  ]));
  write(path.join(dir, `rollout-2026-11-03T10-10-00-${child}.jsonl`), lines([
    { type: "session_meta", timestamp: at(10, 10), payload: { id: child, cwd: SOURCE, parent_thread_id: id } },
    { type: "event_msg", timestamp: at(10, 11), payload: { type: "item_completed", item: { type: "FileChange", changes: { [path.join(SOURCE, "child.ts")]: {} } } } },
  ]));
  const { records } = await collect(collectSessions("codex-sessions", sources, { root }));
  assert.ok(records.every((r) => digest(r).sessionId === id), "the subagent's record uses its parent's session");
  const main = records.find((r) => digest(r).prompts.length)!;
  assert.deepEqual(digest(main).prompts, ["Build the shop"]);
  assert.deepEqual(digest(main).files, ["shop.ts"]);
  assert.deepEqual(digest(main).commits, ["1234567"]);
  assert.equal(digest(main).checks[0].ok, true);
  assert.equal(main.refs.repo, "git@github.com:me/game.git");
  assert.equal(JSON.stringify(records).includes("SECRET"), false);
});

test("compressed logs read the same as plain ones", async () => {
  const root = home("zst");
  const id = "01a1a7b1-a773-7100-8c42-98ecfb4d6985";
  write(path.join(root, ".codex", "archived_sessions", `rollout-${id}.jsonl.zst`), zlib.zstdCompressSync(lines([
    { type: "session_meta", timestamp: at(9), payload: { id, cwd: SOURCE } },
    { type: "event_msg", timestamp: at(9, 1), payload: { type: "user_message", message: "From the archive" } },
  ])));
  const { records } = await collect(collectSessions("codex-sessions", sources, { root }));
  assert.deepEqual(digest(records[0]).prompts, ["From the archive"]);
});

test("this app's own agent runs, other projects and housekeeping sessions add nothing", async () => {
  const root = home("skip");
  const base = path.join(root, ".claude", "projects", "encoded");
  write(path.join(base, "agent.jsonl"), lines([claudeUser(at(11), `${AGENT_RUN_MARKER}\nWrite a script`)]));
  write(path.join(base, "older-agent.jsonl"), lines([claudeUser(at(11), "You help a solo developer turn daily progress on a game")]));
  write(path.join(base, "other.jsonl"), lines([{ ...claudeUser(at(11), "Other work"), cwd: path.join(os.tmpdir(), "another-project") }]));
  write(path.join(base, "empty.jsonl"), lines([{ type: "system", timestamp: at(11), cwd: SOURCE }, { type: "assistant", timestamp: at(11, 1), cwd: SOURCE, message: { content: [{ type: "text", text: "hi" }] } }]));
  const { records, cursor } = await collect(collectSessions("claude-sessions", sources, { root }));
  assert.deepEqual(records, []);
  assert.equal(cursor[path.join(base, "other.jsonl")].skip, true);
});

test("a session across midnight splits by local day", async () => {
  const root = home("midnight");
  write(path.join(root, ".claude", "projects", "e", "c1.jsonl"), lines([claudeUser(at(23, 50, 3), "Late"), claudeUser(at(0, 10, 4), "Early")]));
  const { records } = await collect(collectSessions("claude-sessions", sources, { root }));
  assert.deepEqual(records.map((r) => r.date).sort(), ["2026-11-03", "2026-11-04"]);
  assert.equal(new Set(records.map((r) => r.id)).size, 2);
});

test("a growing log resumes where it stopped, and an unchanged one isn't read again", async () => {
  const root = home("resume");
  const file = path.join(root, ".claude", "projects", "e", "c1.jsonl");
  write(file, lines([claudeUser(at(10), "First")]));
  const first = await collect(collectSessions("claude-sessions", sources, { root }));
  assert.deepEqual(digest(first.records[0]).prompts, ["First"]);
  const again = await collect(collectSessions("claude-sessions", sources, { root, cursor: first.cursor }));
  assert.deepEqual(again.records, []);
  fs.appendFileSync(file, lines([claudeUser(at(10, 5), "Second")]));
  const later = await collect(collectSessions("claude-sessions", sources, { root, cursor: first.cursor }));
  assert.deepEqual(digest(later.records[0]).prompts, ["Second"]);
  assert.equal(later.records[0].sourceId, "s1");
  const merged = mergeDigests(digest(first.records[0]), digest(later.records[0]));
  assert.deepEqual(merged.prompts, ["First", "Second"]);
  assert.equal(digestHash(mergeDigests(merged, merged)), digestHash(merged), "merging twice changes nothing");
});

test("oversized lines are counted and skipped, and an unknown format is reported", async () => {
  const root = home("odd");
  const big = "x".repeat(5 * 1024 * 1024);
  write(path.join(root, ".claude", "projects", "e", "big.jsonl"), `${lines([claudeUser(at(10), "Before")])}${JSON.stringify({ type: "user", blob: big })}\n${lines([claudeUser(at(10, 1), "After")])}`);
  const big1 = await collect(collectSessions("claude-sessions", sources, { root }));
  assert.equal(big1.skipped, 1);
  assert.deepEqual(digest(big1.records[0]).prompts, ["Before", "After"]);

  const other = home("format");
  const rows = Array.from({ length: 250 }, (_, i) => ({ type: "future-format", cwd: SOURCE, data: i }));
  write(path.join(other, ".claude", "projects", "e", "new.jsonl"), lines(rows));
  const unknown = await collect(collectSessions("claude-sessions", sources, { root: other }));
  assert.equal(unknown.unsupported.length, 1);
});

test("the reader leaves a line without its newline for the next run", async () => {
  const file = path.join(home("partial"), "log.jsonl");
  write(file, 'one\ntwo-unfinished');
  const seen: Array<string | undefined> = [];
  let offset = 0;
  for await (const l of readLines(file)) { seen.push(l.line?.toString()); offset = l.offset; }
  assert.deepEqual(seen, ["one"]);
  assert.equal(offset, 4);
});

test("a digest keeps a command's name and short arguments, not the agent's whole shell line", () => {
  const pwsh = "C:\\Users\\dev\\.cache\\pwsh.exe -Command";
  assert.deepEqual(commandsIn(`${pwsh} git push origin main`), { git: ["git push origin main"], checks: [] });
  assert.deepEqual(commandsIn(`${pwsh} git -c user.name='Some Dev' -c user.email=a@b.c commit -m 'SECRET MESSAGE'`), { git: ["git commit"], checks: [] });
  assert.deepEqual(commandsIn('cd /d/work && SP="/tmp/x"; python "$SP/a.py" </dev/null | cut -c1-200; npx tsc --noEmit -p . 2>&1 | head -6; timeout 70 npm test'), { git: [], checks: ["npx tsc", "npm test"] });
  assert.deepEqual(commandsIn("@'\nfrom pathlib import Path\nprint('run pytest and git push later')\n'@ | python -"), { git: [], checks: [] });
  assert.deepEqual(commandsIn('git checkout -- src/a.ts'), { git: ["git checkout"], checks: [] });
  assert.deepEqual(commandsIn('git tag -a v1 -m "SECRET" 2>&1'), { git: ["git tag -a v1"], checks: [] });
});

test("absolute paths leave a digest: a project's become relative, and others become a mark", async () => {
  const roots = ["D:\\work\\game"];
  assert.equal(withoutAbsolutePaths("see D:\\work\\game\\src\\a.ts and D:/work/game/src/b.ts and /d/work/game/c.ts", roots), "see src\\a.ts and src/b.ts and c.ts");
  assert.equal(withoutAbsolutePaths("D:\\work\\game2\\a.ts", roots), "[path]");
  assert.equal(withoutAbsolutePaths('open "C:\\Users\\dev\\notes.md", /home/dev/x and /c/Users/dev/y'), 'open "[path]", [path] and [path]');
  assert.equal(withoutAbsolutePaths("and/or src/a.ts https://example.test/home/x"), "and/or src/a.ts https://example.test/home/x");

  const root = home("paths");
  write(path.join(root, ".claude", "projects", "e", "c1.jsonl"), lines([
    claudeUser(at(10), `Look at ${path.join(SOURCE, "src", "game.ts")} and C:\\Users\\dev\\private.md`),
    claudeTool(at(10, 1), "t1", "Bash", { command: "npm test" }),
    claudeResult(at(10, 2), "t1", "error in C:\\Users\\dev\\private.md", true),
  ]));
  const { records } = await collect(collectSessions("claude-sessions", sources, { root }));
  const d = digest(records[0]);
  assert.equal(d.prompts[0], `Look at ${path.join("src", "game.ts")} and [path]`);
  assert.equal(d.checks[0].error, "error in [path]");
});

test("a reply keeps the developer's words and drops the agent's text it quotes", async () => {
  const root = home("quoted");
  write(path.join(root, ".claude", "projects", "e", "c1.jsonl"), lines([
    claudeUser(at(10), "> Please close Unity when convenient.\n> I'll wait.\n\nClosed"),
    claudeUser(at(10, 1), "First point.\n> A quoted line\nSecond point, where a > b."),
    claudeUser(at(10, 2), "> Only a quote"),
  ]));
  const { records } = await collect(collectSessions("claude-sessions", sources, { root }));
  assert.deepEqual(digest(records[0]).prompts, ["Closed", "First point. Second point, where a > b."]);
});

test("Codex's list of attached files stays out of a prompt", async () => {
  const root = home("attached");
  const attached = (request: string) => ({ timestamp: at(10), type: "event_msg", payload: { type: "user_message", message: `# Files mentioned by the user:\n\n## shot.png: C:/Users/dev/shot.png\n\nImage attached: true\n\n${request}` } });
  const id = "01a1a7b1-a773-7100-8c42-98ecfb4d6985";
  write(path.join(root, ".codex", "sessions", "2026", "11", "03", `rollout-2026-11-03T10-00-00-${id}.jsonl`), lines([
    { timestamp: at(10), type: "session_meta", payload: { id, cwd: SOURCE } },
    attached("## My request for Codex:\nMove the button."),
    attached(""),
    { timestamp: at(10, 1), type: "event_msg", payload: { type: "user_message", message: "A plain request." } },
  ]));
  const { records } = await collect(collectSessions("codex-sessions", sources, { root }));
  assert.deepEqual(digest(records[0]).prompts, ["Move the button.", "A plain request."]);
});

test("redaction removes planted secrets and keeps commit hashes", () => {
  const secrets = [
    "sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz012345", "github_pat_abcdefghijklmnopqrstuvwxyz", "xoxb-1234567890-abcdef", "AKIAABCDEFGHIJKLMNOP",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl", "Bearer abcdefghijklmnopqrstuvwx", "https://user:hunter2@example.com/repo", "password=hunter2", 'API_KEY: "hunter2"', "MY_SECRET_TOKEN=hunter2",
  ];
  for (const s of secrets) assert.equal(/hunter2|abcdefghijkl|AKIA/.test(redact(`run with ${s} now`)), false, s);
  const hash = "0123456789abcdef0123456789abcdef01234567";
  assert.ok(redact(`commit ${hash}`).includes(hash));
  assert.equal(redact("Project Falcon launch", ["project falcon"]), "[redacted] launch");
  assert.equal(shorten("a  b\n c", 10), "a b c");
});

const record = (id: string, patch: Partial<ActivityRecord> = {}): ActivityRecord => ({ id, connector: "git", sourceId: "s1", kind: "commit", startedAt: at(10), endedAt: at(10), date: "2026-11-03", title: id, summary: "", refs: { commits: [], files: [], urls: [], issues: [] }, visibility: "public", contentHash: "", ...patch });
const refs = (patch: Partial<ActivityRecord["refs"]>) => ({ commits: [], files: [], urls: [], issues: [], ...patch });

test("correlation links by commit, by time and files, and only suggests by day", () => {
  const full = "abc1234def5678abc1234def5678abc1234def56";
  const commit = record("commit", { refs: refs({ commits: [full], files: ["a.ts"] }) });
  const session = record("session", { kind: "session", visibility: "private", connector: "claude-sessions", startedAt: at(9), endedAt: at(11), refs: refs({ commits: ["abc1234"], files: ["a.ts"] }) });
  const pull = record("pull", { kind: "pullRequest", connector: "github", sourceId: "github:me/game", refs: refs({ commits: [full] }) });
  const nearby = record("nearby", { startedAt: at(11, 10), endedAt: at(11, 10), refs: refs({ commits: ["1111111"], files: ["a.ts"] }) });
  const sameDay = record("same-day", { startedAt: at(20), endedAt: at(20), refs: refs({ commits: ["2222222"], files: ["z.ts"] }) });
  const excluded = record("excluded", { kind: "session", visibility: "excluded", refs: refs({ commits: ["abc1234"] }) });
  const links = correlate([commit, session, pull, nearby, sameDay, excluded]);
  const strength = (a: string, b: string) => links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))?.strength;
  assert.equal(strength("commit", "session"), "exact");
  assert.equal(strength("commit", "pull"), "exact");
  assert.equal(strength("session", "nearby"), "strong");
  assert.equal(strength("session", "same-day"), "weak");
  assert.equal(strength("commit", "excluded"), undefined, "an excluded record gets no links");
  const groups = threadsOf([commit, session, pull, nearby, sameDay], links).map((t) => t.recordIds.sort().join());
  assert.ok(groups.includes("commit,nearby,pull,session"));
  assert.ok(groups.includes("same-day"), "a weak link never groups");
});

test("a developer's split and join hold against computed links", () => {
  const a = record("a"), b = record("b"), c = record("c");
  const threads = threadsOf([a, b, c], [
    { a: "a", b: "b", strength: "exact", reason: "" },
    { a: "a", b: "b", strength: "manual", reason: "", split: true },
    { a: "b", b: "c", strength: "manual", reason: "" },
  ]);
  assert.deepEqual(threads.map((t) => t.recordIds.sort().join()).sort(), ["a", "b,c"]);
});

test("GitHub records carry their commits and follow the repository's visibility", async () => {
  const calls: string[] = [];
  const api = async (p: string) => {
    calls.push(p);
    if (p === "/repos/me/game") return { private: true };
    if (p.includes("/pulls/7/commits")) return [{ sha: "abc1234" }];
    if (p.includes("/pulls?")) return [{ number: 7, title: "Shop", body: "Fixes #3", state: "closed", html_url: "https://github.com/me/game/pull/7", created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-03T10:00:00Z", merged_at: "2026-11-03T10:00:00Z", closed_at: "2026-11-03T10:00:00Z", head: { ref: "shop" } }];
    if (p.includes("/issues?")) return [{ number: 7, title: "PR shown as issue", pull_request: {}, updated_at: "2026-11-03T10:00:00Z", created_at: "2026-11-03T10:00:00Z", state: "closed", html_url: "" }, { number: 3, title: "Shop crash", body: null, state: "open", html_url: "https://github.com/me/game/issues/3", created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-03T10:00:00Z", closed_at: null }];
    if (p.includes("/releases")) return [{ tag_name: "v1", name: "One", body: "", html_url: "https://github.com/me/game/releases/v1", published_at: "2026-11-03T10:00:00Z", draft: false }, { tag_name: "v2", name: "", body: "", html_url: "", published_at: null, draft: true }];
    return [];
  };
  const { records } = await collect(collectGithub("me/game", "2026-11-01", api));
  assert.deepEqual(records.map((r) => r.kind), ["pullRequest", "issue", "release"]);
  assert.ok(records.every((r) => r.visibility === "private"));
  assert.deepEqual(records[0].refs.commits, ["abc1234"]);
  assert.deepEqual(records[0].refs.issues, ["3"]);
  assert.ok(calls.some((c) => c.includes("since=2026-11-01")));
  assert.equal(githubRepo("git@github.com:acme/widget.git\n"), "acme/widget");
  assert.equal(githubRepo("https://github.com/me/game"), "me/game");
  assert.equal(githubRepo("ssh://git@forge.example.com:2222/acme/game.git"), undefined);
});

test("a session that edits mostly elsewhere starts excluded, and a tool's scratch files don't count", async () => {
  const root = home("other");
  const elsewhere = (n: number) => path.join(path.parse(SOURCE).root, "other-project", `${n}.ts`);
  const scratch = path.join(os.tmpdir(), "scratchpad", "notes.py");
  write(path.join(root, ".claude", "projects", "e", "devlog.jsonl"), lines([claudeUser(at(10), "Plan the tool"), claudeTool(at(10, 1), "t1", "Edit", { file_path: elsewhere(1) }), claudeTool(at(10, 2), "t2", "Write", { file_path: elsewhere(2) })]));
  write(path.join(root, ".claude", "projects", "e", "game.jsonl"), lines([claudeUser(at(11), "Fix the bridge"), claudeTool(at(11, 1), "t1", "Edit", { file_path: path.join(SOURCE, "bridge.ts") }), claudeTool(at(11, 2), "t2", "Write", { file_path: scratch })]));
  write(path.join(root, ".claude", "projects", "e", "scratch.jsonl"), lines([claudeUser(at(12), "Only scratch"), claudeTool(at(12, 1), "t1", "Write", { file_path: scratch })]));
  const { records } = await collect(collectSessions("claude-sessions", sources, { root }));
  const byPrompt = (p: string) => records.find((r) => digest(r).prompts.includes(p))!;
  assert.equal(byPrompt("Plan the tool").visibility, "excluded");
  assert.equal(digest(byPrompt("Plan the tool")).otherFiles!.length, 2);
  assert.equal(byPrompt("Fix the bridge").visibility, "private");
  assert.equal(digest(byPrompt("Fix the bridge")).otherFiles!.length, 0);
  assert.equal(byPrompt("Only scratch").visibility, "private", "scratch files say nothing about the session's topic");
  assert.equal(looksLikeOtherWork({ files: ["a"], otherFiles: ["1", "2", "3"] }), false, "a quarter inside still counts as this project");
  assert.equal(looksLikeOtherWork({ files: ["a"], otherFiles: ["1", "2", "3", "4", "5"] }), true);
  assert.equal(looksLikeOtherWork({ files: [] }), false, "a session without edits can't be told apart");
});

test("a session's title is its own title or its first request", () => {
  assert.equal(sessionTitleOf({ tool: "claude", sessionTitle: "Named", prompts: ["First"] }), "Named");
  assert.equal(sessionTitleOf({ tool: "codex", prompts: ["First"] }), "First");
  assert.equal(sessionTitleOf({ tool: "codex", prompts: [] }), "Codex session");
});

test("remotes parse across forms, and only github.com counts as GitHub", () => {
  assert.deepEqual(parseRemote("ssh://git@forge.example.com:2222/acme/game.git\n"), { host: "forge.example.com", repo: "acme/game" });
  assert.deepEqual(parseRemote("git@codeberg.org:me/game.git"), { host: "codeberg.org", repo: "me/game" });
  assert.deepEqual(parseRemote("https://forge.example.test/me/game"), { host: "forge.example.test", repo: "me/game" });
  assert.equal(parseRemote("not a remote"), undefined);
  assert.equal(githubRepo("https://github.com.example.test/me/game"), undefined);
});

test("commit links use the remote's web address, without its port or credentials", () => {
  assert.equal(commitUrl("ssh://git@forge.example.com:2222/acme/game.git\n", "abc1234"), "https://forge.example.com/acme/game/commit/abc1234");
  assert.equal(commitUrl("git@github.com:me/game.git", "abc1234"), "https://github.com/me/game/commit/abc1234");
  assert.equal(commitUrl("https://user:SECRET@forge.example.test/me/game.git", "abc1234"), "https://forge.example.test/me/game/commit/abc1234");
  assert.equal(commitUrl("", "abc1234"), undefined);
});

test("Forgejo records use its API, and its pull requests link by commit", async () => {
  const calls: string[] = [];
  const api = async (p: string) => {
    calls.push(p);
    if (p === "/repos/me/game") return { private: true };
    if (p.includes("/pulls/7/commits")) return [{ sha: "abc1234def" }];
    if (p.includes("/pulls?")) return [{ number: 7, title: "Shop", body: "", state: "closed", html_url: "u", created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-03T10:00:00Z", merged_at: "2026-11-03T10:00:00Z", closed_at: null, head: { ref: "shop" } }];
    if (p.includes("/issues?")) return [{ number: 3, title: "Crash", body: null, state: "open", html_url: "u", created_at: "2026-11-02T10:00:00Z", updated_at: "2026-11-03T10:00:00Z", closed_at: null }];
    return [];
  };
  const { records } = await collect(collectForgejo("me/game", "2026-11-01", api));
  assert.deepEqual(records.map((r) => r.id), ["forgejo:me/game:pull:7", "forgejo:me/game:issue:3"]);
  assert.ok(records.every((r) => r.visibility === "private" && r.connector === "forgejo"));
  assert.ok(calls.some((c) => c.includes("sort=recentupdate") && c.includes("limit=50")));
  assert.ok(calls.some((c) => c.includes("type=issues") && c.includes("since=2026-11-01")));
  const commit = record("commit", { refs: refs({ commits: ["abc1234def5678"] }) });
  assert.equal(correlate([commit, records[0]]).find((l) => l.strength === "exact")?.reason, "Both name commit abc1234d");
});

test("a Forgejo call authenticates with the token, and its errors don't repeat it", async () => {
  const original = globalThis.fetch;
  let header = "";
  let answer = 200;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    header = (init.headers as Record<string, string>).Authorization;
    assert.equal(url, "https://forge.test/api/v1/repos/me/game");
    return new Response("{}", { status: answer });
  }) as typeof fetch;
  try {
    const call = forgejoCall("https://forge.test/", "secret-token");
    await call("/repos/me/game");
    assert.equal(header, "token secret-token");
    answer = 401;
    await assert.rejects(call("/repos/me/game"), (e: Error) => /refused this token/.test(e.message) && !e.message.includes("secret-token"));
  } finally { globalThis.fetch = original; }
});

test("prompts keep up to 600 characters, and a longer copy replaces a stored shorter one", async () => {
  const root = home("long");
  const long = `Start ${"word ".repeat(200)}`.trim();
  write(path.join(root, ".claude", "projects", "e", "c1.jsonl"), lines([claudeUser(at(10), long)]));
  const { records } = await collect(collectSessions("claude-sessions", sources, { root }));
  const stored = digest(records[0]).prompts[0];
  assert.equal(stored.length, 600);
  assert.ok(stored.endsWith("…"));
  assert.ok(records[0].title.length <= 90, "a title stays short for lists");
  const older = { ...digest(records[0]), prompts: [`${long.slice(0, 159)}…`, "Another"] };
  assert.deepEqual(mergeDigests(older, digest(records[0])).prompts, [stored, "Another"], "the longer copy keeps the shorter one's place");
});

test("stopping a log early closes its file, for plain and compressed logs alike", async () => {
  const dir = home("close");
  const rows = lines([{ a: 1 }, { a: 2 }, { a: 3 }]);
  const plain = path.join(dir, "log.jsonl"), compressed = path.join(dir, "log.jsonl.zst");
  write(plain, rows);
  write(compressed, zlib.zstdCompressSync(rows));
  for (const file of [plain, compressed]) {
    let source: fs.ReadStream | undefined;
    for await (const { line } of readLines(file, 0, (s) => { source = s; })) { assert.ok(line); break; }
    assert.equal(source!.destroyed, true, file);
  }
});

test("a log that can't be read fails its reader, and doesn't take the process down", async () => {
  const missing = path.join(home("missing"), "gone.jsonl.zst");
  await assert.rejects(async () => { for await (const _ of readLines(missing)) { /* nothing to read */ } }, /ENOENT/);
});
