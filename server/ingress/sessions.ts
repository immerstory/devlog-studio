import { createReadStream, promises as fsp, type ReadStream } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { looksLikeOtherWork, sessionTitleOf, type ActivityRecord, type SessionDigest } from "../../shared/activity.js";
import type { CollectEvent, FileCursor, IngressConnector, SourceCandidate } from "./provider.js";
import { AGENT_RUN_MARKER } from "../agent.js";
import { localDate } from "./provider.js";
import { redact, shorten, withoutAbsolutePaths } from "./redact.js";

const run = promisify(execFile);
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const LISTS = { files: 200, commands: 60, prompts: 40, checks: 40 };
const PROMPT_LENGTH = 600;
/** Below this share of recognized lines, a log's format counts as unsupported. */
const MIN_RECOGNIZED = 0.1;
const MIN_LINES_FOR_FORMAT_CHECK = 200;
const CHECK_COMMAND = /\b(npm (run )?(test|build|lint|typecheck)|npx (tsc|vitest|jest|eslint)|pnpm (test|build)|yarn (test|build)|pytest|cargo (test|build|check)|go (test|build)|dotnet (test|build)|tsc\b|make\b|gradle\S* (test|build)|mvn (test|verify))/;
const GIT_COMMAND = /^git(?:\s+(?:-[cC]\s+(?:\S*'[^']*'|\S*"[^"]*"|\S+)|--\S+))*\s+(commit|push|merge|rebase|revert|cherry-pick|tag|checkout|switch|reset)\b(.*)$/;
/** The shell around an agent's command, such as `pwsh.exe -Command`. */
const SHELL_WRAPPER = /^\s*["']?(?:[^\n"']*[\\/])?(?:pwsh|powershell|bash|zsh|sh|cmd)(?:\.exe)?["']?\s+(?:-\S+\s+)*?(?:-Command|-lc|-c|\/c)\s+["']?/i;
const COMMAND_PREFIX = /^(?:[(&]\s*|timeout\s+\d+\s+|env\s+|[A-Za-z_]\w*=\S*\s+)+/;
/** A reply that quotes the agent. Only the developer's own words belong in a digest. */
const QUOTED_LINE = /^[ \t]*>.*$/gm;
/** Codex puts attached files in front of the developer's words. */
const ATTACHED_FILES = /^# Files (?:mentioned|pasted)\b[\s\S]*?(?:^## My request[^\n]*:[ \t]*\n?|$(?![\s\S]))/m;
const COMMIT_OUTPUT = /\[[^\]\n]*\s([0-9a-f]{7,40})\]\s/g;
const AGENT_RUN_START = "You help a solo developer turn daily progress on";
const TOOL_FOLDERS = [os.tmpdir(), path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".codex")];

/**
 * Streams a log's lines with their end offsets. Oversized lines are counted and skipped, and an unfinished last line
 * waits for the next run. Stopping early closes the file, and a read error reaches the caller instead of the process.
 */
export async function* readLines(file: string, startOffset = 0, opened?: (source: ReadStream) => void): AsyncGenerator<{ line?: Buffer; offset: number }> {
  const compressed = file.endsWith(".zst");
  const source = createReadStream(file, compressed ? {} : { start: startOffset });
  opened?.(source);
  const decompress = compressed ? zlib.createZstdDecompress() : undefined;
  // pipe() doesn't pass on an error or a close, in either direction.
  if (decompress) { source.on("error", (err) => decompress.destroy(err)); source.pipe(decompress); }
  let parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  let offset = compressed ? 0 : startOffset;
  try {
    for await (const chunk of (decompress ?? source) as AsyncIterable<Buffer>) {
      let at = 0;
      while (at < chunk.length) {
        const end = chunk.indexOf(10, at);
        const piece = chunk.subarray(at, end < 0 ? chunk.length : end);
        offset += piece.length + (end < 0 ? 0 : 1);
        if (!oversized) {
          size += piece.length;
          if (size > MAX_LINE_BYTES) { oversized = true; parts = []; } else parts.push(Buffer.from(piece));
        }
        if (end < 0) break;
        at = end + 1;
        yield oversized ? { offset } : { line: Buffer.concat(parts), offset };
        parts = [];
        size = 0;
        oversized = false;
      }
    }
  } finally {
    source.destroy();
    decompress?.destroy();
  }
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const inside = (root: string, p: string) => norm(p) === norm(root) || norm(p).startsWith(`${norm(root)}/`);

async function worktreeRoots(sourcePath: string): Promise<string[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: sourcePath, windowsHide: true }).catch(() => ({ stdout: "" }));
  return [sourcePath, ...stdout.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))];
}

/**
 * The Git commands and checks in an agent's shell line. An agent writes that line, and it can hold scripts, commit messages and
 * local paths, so a digest keeps only each command's name and short arguments. A word counts only at the start of a statement.
 */
export function commandsIn(line: string): { git: string[]; checks: string[] } {
  const statements = line.replace(SHELL_WRAPPER, "").split(/\r?\n|&&|\|\||[;|]/).map((s) => s.trim().replace(COMMAND_PREFIX, ""));
  const git: string[] = [], checks: string[] = [];
  for (const statement of statements) {
    const command = GIT_COMMAND.exec(statement);
    if (command) {
      const args = command[1] === "commit" ? "" : command[2].replace(/\s+-[a-zA-Z]*m\b.*$/, "").replace(/\s+--(\s.*)?$/, "").replace(/\s*\d?[<>].*$/, "").replace(/["']+\s*$/, "").trimEnd();
      git.push(`git ${command[1]}${args}`);
    }
    const check = CHECK_COMMAND.exec(statement);
    if (check?.index === 0 && !checks.includes(check[0])) checks.push(check[0]);
  }
  return { git, checks };
}

export interface SessionSource { id: string; label: string; roots: string[] }
const sourceFor = (sources: SessionSource[], cwd: string) => sources.find((s) => s.roots.some((r) => inside(r, cwd)));

/** One day of a session while its log is read. */
interface DayBuilder {
  digest: SessionDigest;
  firstAt: string;
  lastAt: string;
}
class SessionReader {
  days = new Map<string, DayBuilder>();
  source?: SessionSource;
  cwd?: string;
  branch?: string;
  repo?: string;
  title?: string;
  agentRun = false;
  firstPromptSeen = false;
  /** Commands waiting for their result, by tool call ID. */
  pending = new Map<string, string>();
  lines = 0;
  recognized = 0;
  skipped = 0;
  constructor(readonly tool: SessionDigest["tool"], public sessionId: string, readonly terms: string[]) {}

  day(at: string): DayBuilder {
    const date = localDate(at);
    let d = this.days.get(date);
    if (!d) {
      d = { digest: { tool: this.tool, sessionId: this.sessionId, activeMinutes: [], files: [], otherFiles: [], commands: [], commits: [], checks: [], prompts: [] }, firstAt: at, lastAt: at };
      this.days.set(date, d);
    }
    if (at < d.firstAt) d.firstAt = at;
    if (at > d.lastAt) d.lastAt = at;
    const t = new Date(at);
    const minute = t.getHours() * 60 + t.getMinutes();
    if (!d.digest.activeMinutes.includes(minute)) d.digest.activeMinutes.push(minute);
    return d;
  }
  /** Text from a log as a digest may store it. */
  safe(text: string) {
    return redact(withoutAbsolutePaths(text, this.source?.roots), this.terms);
  }
  prompt(at: string, text: string) {
    const clean = text.replace(/&#x20;/g, " ").replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, "[pasted]").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(ATTACHED_FILES, "").replace(QUOTED_LINE, "").trim();
    if (!clean || clean.startsWith("<")) return;
    // Wrapped context such as environment details comes first, so the first prompt is the first plain one.
    if (!this.firstPromptSeen) {
      this.firstPromptSeen = true;
      if (clean.startsWith(AGENT_RUN_MARKER) || clean.startsWith(AGENT_RUN_START)) this.agentRun = true;
    }
    if (clean.startsWith("This session is being continued")) return;
    const d = this.day(at).digest;
    if (d.prompts.length < LISTS.prompts) d.prompts.push(shorten(this.safe(clean), PROMPT_LENGTH));
  }
  file(at: string, file: string) {
    if (!this.source || !path.isAbsolute(file)) { if (this.source && file) this.addFile(at, file); return; }
    const root = this.source.roots.find((r) => inside(r, file));
    if (root) { this.addFile(at, path.relative(root, file).replace(/\\/g, "/")); return; }
    // A file outside the project's sources belongs to other work, so its path stays out. A tool's own scratch files say nothing.
    if (TOOL_FOLDERS.some((folder) => inside(folder, file))) return;
    const d = this.day(at).digest;
    const hash = crypto.createHash("sha256").update(norm(file)).digest("hex").slice(0, 10);
    if (d.otherFiles!.length < LISTS.files && !d.otherFiles!.includes(hash)) d.otherFiles!.push(hash);
  }
  private addFile(at: string, relative: string) {
    const d = this.day(at).digest;
    if (d.files.length < LISTS.files && !d.files.includes(relative)) d.files.push(relative);
  }
  command(at: string, command: string, output: string, ok: boolean | undefined) {
    const d = this.day(at).digest;
    const { git, checks } = commandsIn(command);
    for (const one of git) {
      const safe = shorten(this.safe(one), 160);
      if (d.commands.length < LISTS.commands && !d.commands.includes(safe)) d.commands.push(safe);
    }
    if (git.length) for (const m of output.matchAll(COMMIT_OUTPUT)) if (!d.commits.includes(m[1])) d.commits.push(m[1]);
    if (checks.length && ok !== undefined && d.checks.length < LISTS.checks) {
      const error = ok ? undefined : output.split(/\r?\n/).find((l) => /error|fail/i.test(l));
      d.checks.push({ command: checks.join(" + "), ok, error: error ? shorten(this.safe(error), 160) : undefined });
    }
  }
}

function records(reader: SessionReader, connector: string): ActivityRecord[] {
  if (!reader.source || reader.agentRun) return [];
  // A day with nothing to show is only a tool's own housekeeping.
  const days = [...reader.days].filter(([, d]) => d.digest.prompts.length || d.digest.files.length || d.digest.otherFiles!.length || d.digest.commands.length || d.digest.commits.length || d.digest.checks.length);
  return days.map(([date, d]) => {
    const digest = { ...d.digest, sessionTitle: reader.title ? shorten(reader.safe(reader.title), 90) : undefined, activeMinutes: d.digest.activeMinutes.sort((a, b) => a - b) };
    return {
      id: `${connector}:${reader.sessionId}:${date}`,
      connector,
      sourceId: reader.source!.id,
      kind: "session" as const,
      startedAt: d.firstAt,
      endedAt: d.lastAt,
      date,
      title: shorten(sessionTitleOf(digest), 90),
      summary: "",
      refs: { repo: reader.repo, branch: reader.branch, commits: digest.commits, files: digest.files, urls: [], issues: [] },
      visibility: looksLikeOtherWork(digest) ? ("excluded" as const) : ("private" as const),
      contentHash: "",
      detail: digest,
    };
  });
}

// ---------- Claude Code ----------

function readClaudeLine(r: SessionReader, o: Record<string, any>) {
  if (o.type === "custom-title" && typeof o.customTitle === "string") { r.title = o.customTitle; r.recognized++; return; }
  if (o.cwd && !r.cwd) r.cwd = o.cwd;
  if (o.gitBranch && o.gitBranch !== "HEAD") r.branch = o.gitBranch;
  const at = o.timestamp;
  if (typeof at !== "string") return;
  if (o.type !== "user" && o.type !== "assistant") { r.recognized++; return; }
  r.recognized++;
  const content = o.message?.content;
  if (o.type === "user" && !o.isMeta && !o.isSidechain && !o.isCompactSummary) {
    if (typeof content === "string") r.prompt(at, content);
    else if (Array.isArray(content) && !("toolUseResult" in o)) for (const b of content) if (b?.type === "text") r.prompt(at, b.text ?? "");
  }
  if (!Array.isArray(content)) { r.day(at); return; }
  for (const b of content) {
    if (b?.type === "tool_use") {
      const input = b.input ?? {};
      if (typeof input.file_path === "string" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) r.file(at, input.file_path);
      if (typeof input.command === "string" && /^(Bash|PowerShell)$/.test(b.name)) r.pending.set(b.id, input.command);
    } else if (b?.type === "tool_result" && r.pending.has(b.tool_use_id)) {
      const output = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("\n") : "";
      r.command(at, r.pending.get(b.tool_use_id)!, output, !b.is_error);
      r.pending.delete(b.tool_use_id);
    }
  }
  r.day(at);
}

// ---------- Codex ----------

function codexCommandText(command: unknown): string {
  if (Array.isArray(command)) return command.join(" ");
  return typeof command === "string" ? command : "";
}

function readCodexLine(r: SessionReader, o: Record<string, any>) {
  const at = o.timestamp;
  const p = o.payload;
  if (o.type === "session_meta" && p) {
    r.recognized++;
    r.cwd ??= p.cwd;
    // A subagent's work belongs to the session that started it, and a review thread adds nothing of its own.
    if (p.parent_thread_id) { r.sessionId = p.parent_thread_id; r.firstPromptSeen = true; }
    if (p.thread_source === "guardian_review") r.agentRun = true;
    if (p.git?.branch) r.branch = p.git.branch;
    if (p.git?.repository_url) r.repo = p.git.repository_url;
    return;
  }
  if (o.type === "turn_context" && p) { r.recognized++; r.cwd ??= p.cwd; return; }
  if (typeof at !== "string" || !p) return;
  if (o.type === "event_msg") {
    r.recognized++;
    if (p.type === "user_message" && typeof p.message === "string") r.prompt(at, p.message);
    if (p.type === "exec_command_end") r.command(at, codexCommandText(p.command), p.aggregated_output ?? p.stdout ?? "", p.exit_code === undefined ? undefined : p.exit_code === 0);
    if (p.type === "patch_apply_end" && p.changes && typeof p.changes === "object") for (const f of Object.keys(p.changes)) r.file(at, f);
    if (p.type === "item_completed" && p.item) {
      const it = p.item;
      if (it.type === "UserMessage") {
        const text = Array.isArray(it.content) ? it.content.map((c: { text?: string }) => c.text ?? "").join("\n") : typeof it.content === "string" ? it.content : "";
        r.prompt(at, text);
      }
      if (it.type === "CommandExecution") r.command(at, codexCommandText(it.command), it.aggregated_output ?? "", it.exit_code === undefined || it.exit_code === null ? undefined : it.exit_code === 0);
      if (it.type === "FileChange") {
        const changes = it.changes;
        const files = Array.isArray(changes) ? changes.map((c: { path?: string }) => c.path ?? "") : changes && typeof changes === "object" ? Object.keys(changes) : [];
        for (const f of files) if (f) r.file(at, f);
      }
    }
    r.day(at);
    return;
  }
  if (o.type === "response_item" || o.type === "token_usage_record" || o.type === "world_state" || o.type === "compacted") r.recognized++;
}

// ---------- Connectors ----------

interface LogFile { file: string; sessionId: string; connectorFile: string; mtimeMs: number; size: number }

async function walk(dir: string, match: (name: string) => boolean, out: string[] = []): Promise<string[]> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, match, out);
    else if (match(e.name)) out.push(full);
  }
  return out;
}

async function claudeFiles(root: string): Promise<LogFile[]> {
  const base = path.join(root, ".claude", "projects");
  const files = await walk(base, (n) => n.endsWith(".jsonl"));
  return Promise.all(files.map(async (file) => {
    const stat = await fsp.stat(file);
    // A subagent's log lives in <session>/subagents/ and belongs to that session.
    const parts = path.relative(base, file).split(path.sep);
    const sessionId = parts.includes("subagents") ? parts[parts.indexOf("subagents") - 1] : path.basename(file, ".jsonl");
    return { file, sessionId, connectorFile: file, mtimeMs: stat.mtimeMs, size: stat.size };
  }));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
async function codexFiles(root: string): Promise<LogFile[]> {
  const files = [
    ...await walk(path.join(root, ".codex", "sessions"), (n) => n.startsWith("rollout-") && /\.jsonl(\.zst)?$/.test(n)),
    ...await walk(path.join(root, ".codex", "archived_sessions"), (n) => n.startsWith("rollout-") && /\.jsonl(\.zst)?$/.test(n)),
  ].sort();
  return Promise.all(files.map(async (file) => {
    const stat = await fsp.stat(file);
    return { file, sessionId: UUID.exec(path.basename(file))?.[0] ?? path.basename(file), connectorFile: file, mtimeMs: stat.mtimeMs, size: stat.size };
  }));
}

export async function* collectSessions(
  connector: "claude-sessions" | "codex-sessions",
  sources: SessionSource[],
  options: { root?: string; from?: string; cursor?: Record<string, FileCursor>; terms?: string[] },
): AsyncGenerator<CollectEvent> {
  const tool = connector === "claude-sessions" ? "claude" : "codex";
  const root = options.root ?? os.homedir();
  const files = tool === "claude" ? await claudeFiles(root) : await codexFiles(root);
  const cursor: Record<string, FileCursor> = { ...options.cursor };
  /** A split log's later parts start without their session's working directory. */
  const knownCwd = new Map<string, string>();
  const fromMs = options.from ? new Date(`${options.from}T00:00:00`).getTime() : 0;
  for (const f of files) {
    const seen = cursor[f.file];
    if (seen?.skip && seen.mtimeMs === f.mtimeMs) continue;
    if (seen && seen.size === f.size && seen.mtimeMs === f.mtimeMs) continue;
    if (f.mtimeMs < fromMs) continue;
    const reader = new SessionReader(tool, f.sessionId, options.terms ?? []);
    const start = seen && !f.file.endsWith(".zst") && !seen.skip && f.size > seen.size ? seen.offset : 0;
    // Resuming a log: its project is already known, and its first prompt was already seen.
    if (start) { reader.source = sources.find((s) => s.id === seen!.sourceId); reader.firstPromptSeen = true; reader.title = seen!.title; reader.branch = seen!.branch; reader.repo = seen!.repo; }
    let offset = start;
    let skip = false;
    const isSubagent = tool === "claude" && f.file.includes(`${path.sep}subagents${path.sep}`);
    if (isSubagent) reader.firstPromptSeen = true;
    for await (const { line, offset: end } of readLines(f.file, start)) {
      offset = end;
      reader.lines++;
      if (!line) { reader.skipped++; continue; }
      let o: Record<string, any>;
      try { o = JSON.parse(line.toString("utf8")); } catch { reader.skipped++; continue; }
      // The working directory decides: a log of other work is closed right here.
      const placed = () => {
        if (reader.source) return true;
        const cwd = reader.cwd ?? knownCwd.get(f.sessionId);
        if (!cwd) return true;
        knownCwd.set(f.sessionId, cwd);
        reader.source = sourceFor(sources, cwd);
        return !!reader.source;
      };
      // A Claude line carries its own directory, and cleaning that line's text needs the source's roots.
      if (tool === "claude" && typeof o.cwd === "string") reader.cwd ??= o.cwd;
      if (!placed()) { skip = true; break; }
      if (tool === "claude") readClaudeLine(reader, o); else readCodexLine(reader, o);
      if (!placed()) { skip = true; break; }
      if (reader.agentRun) { skip = true; break; }
    }
    if (skip || !reader.source) {
      cursor[f.file] = { size: f.size, mtimeMs: f.mtimeMs, offset: 0, skip: true };
      continue;
    }
    if (reader.lines >= MIN_LINES_FOR_FORMAT_CHECK && reader.recognized / reader.lines < MIN_RECOGNIZED) yield { unsupported: path.basename(f.file) };
    if (reader.skipped) yield { skippedLines: reader.skipped };
    for (const record of records(reader, connector)) {
      if (options.from && record.date < options.from) continue;
      yield { record };
    }
    cursor[f.file] = { size: f.size, mtimeMs: f.mtimeMs, offset, sourceId: reader.source.id, title: reader.title, branch: reader.branch, repo: reader.repo };
  }
  yield { cursor };
}

async function sessionSources(project: { sources: Array<{ id: string; label: string; path: string; archived?: boolean }> }): Promise<SessionSource[]> {
  return Promise.all(project.sources.filter((s) => !s.archived).map(async (s) => ({ id: s.id, label: s.label, roots: await worktreeRoots(s.path) })));
}

/** What each log's start says, so that opening the settings page doesn't read every log again. */
const logHeads = new Map<string, { mtimeMs: number; cwd?: string; agentRun: boolean }>();

async function logHead(f: LogFile, tool: SessionDigest["tool"]) {
  const known = logHeads.get(f.file);
  if (known?.mtimeMs === f.mtimeMs) return known;
  const reader = new SessionReader(tool, f.sessionId, []);
  let read = 0;
  try {
    for await (const { line } of readLines(f.file)) {
      if (++read > 200) break;
      if (!line) continue;
      try {
        const o = JSON.parse(line.toString("utf8"));
        if (tool === "claude") readClaudeLine(reader, o); else readCodexLine(reader, o);
      } catch { continue; }
      if (reader.cwd || reader.agentRun) break;
    }
  } catch {
    // A log that can't be read counts as no session, and the next look tries again.
    return { mtimeMs: f.mtimeMs, agentRun: false };
  }
  const head = { mtimeMs: f.mtimeMs, cwd: reader.cwd, agentRun: reader.agentRun };
  logHeads.set(f.file, head);
  return head;
}

/** Counts a project's sessions for a tool, reading only each log's start. */
async function discoverSessions(connector: "claude-sessions" | "codex-sessions", project: Parameters<typeof sessionSources>[0], root = os.homedir()): Promise<SourceCandidate[]> {
  const sources = await sessionSources(project);
  const files = connector === "claude-sessions" ? await claudeFiles(root) : await codexFiles(root);
  const tool = connector === "claude-sessions" ? "claude" : "codex";
  const sessions = new Set<string>();
  let newest = 0;
  for (const f of files) {
    const head = await logHead(f, tool);
    if (head.cwd && !head.agentRun && sourceFor(sources, head.cwd)) { sessions.add(f.sessionId); newest = Math.max(newest, f.mtimeMs); }
  }
  return [{ connector, label: connector === "claude-sessions" ? "Claude Code sessions" : "Codex sessions", detail: sessions.size ? `${sessions.size} session(s) in this project's sources, the latest from ${new Date(newest).toLocaleDateString()}` : "No sessions found in this project's sources", found: sessions.size }];
}

export function sessionConnector(connector: "claude-sessions" | "codex-sessions"): IngressConnector {
  return {
    id: connector,
    label: connector === "claude-sessions" ? "Claude Code sessions" : "Codex sessions",
    discover: (project) => discoverSessions(connector, project),
    async *collect(project, source, cursor, range) {
      yield* collectSessions(connector, await sessionSources(project), { from: range.from, cursor: cursor as Record<string, FileCursor> | undefined, terms: source?.redactTerms });
    },
  };
}

/** The hash a summary is valid for: everything in a digest except the summary itself. */
export function digestHash(digest: SessionDigest): string {
  const { aiSummary: _summary, ...rest } = digest;
  return crypto.createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 24);
}

/** A prompt stored at a shorter length gives way when the same prompt arrives longer, and keeps its place in the order. */
function withoutShorterCopies(prompts: string[]) {
  const longest = (p: string) => (p.endsWith("…") ? prompts.find((q) => q !== p && q.startsWith(p.slice(0, -1))) ?? p : p);
  return [...new Set(prompts.map(longest))];
}

/** Combines a stored day with newly read lines of the same day. Sets, so repeated reading is harmless. */
export function mergeDigests(a: SessionDigest, b: SessionDigest): SessionDigest {
  const union = <T>(x: T[], y: T[]) => [...new Set([...x, ...y])];
  const checks = [...a.checks];
  for (const c of b.checks) if (!checks.some((k) => k.command === c.command && k.ok === c.ok)) checks.push(c);
  return {
    ...a,
    sessionTitle: b.sessionTitle ?? a.sessionTitle,
    activeMinutes: union(a.activeMinutes, b.activeMinutes).sort((x, y) => x - y),
    files: union(a.files, b.files).slice(0, LISTS.files),
    otherFiles: union(a.otherFiles ?? [], b.otherFiles ?? []).slice(0, LISTS.files),
    commands: union(a.commands, b.commands).slice(0, LISTS.commands),
    commits: union(a.commits, b.commits),
    checks: checks.slice(0, LISTS.checks),
    prompts: withoutShorterCopies(union(a.prompts, b.prompts)).slice(0, LISTS.prompts),
  };
}
