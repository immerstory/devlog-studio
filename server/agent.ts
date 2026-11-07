import type { CaptureTarget } from "../shared/projects.js";
import { getProject } from "./projects.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, CACHE_DIR, type AgentKind } from "./config.js";
import { CancelledError, currentJobSignal } from "./jobs.js";

export interface AgentRun<T> {
  output: T;
  agent: AgentKind;
  costUsd?: number;
}

type Log = (line: string) => void;

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(git status:*)"];

/**
 * Runs the configured agent CLI headless in the project's primary source, read-only, and returns
 * output that matches `schema`. The prompt goes through stdin to avoid Windows argv limits.
 */
interface AgentOptions {
  prompt: string;
  schema: object;
  agent?: AgentKind;
  /** Image files the agent should look at (material previews). */
  images?: string[];
  log?: Log;
}

/** Starts every prompt of this app's agent runs, so session ingress can leave those runs out of a project's activity. */
export const AGENT_RUN_MARKER = "[devlog-studio agent run]";

export async function runAgent<T>(opts: AgentOptions): Promise<AgentRun<T>> {
  const agent = opts.agent ?? config().agent.default;
  const marked = { ...opts, prompt: `${AGENT_RUN_MARKER}\n${opts.prompt}` };
  return agent === "codex" ? runCodex<T>(marked) : runClaude<T>(marked);
}

function spawnCollect(cmd: string, args: string[], stdin: string, log?: Log): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeoutMs = config().agent.timeoutMinutes * 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: getProject().settings.sources.find((s) => s.id === getProject().settings.primarySourceId)!.path, windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Agent timed out after ${config().agent.timeoutMinutes} min`));
    }, timeoutMs);
    // Cancelling the job ends the agent CLI.
    const signal = currentJobSignal();
    const onAbort = () => {
      clearTimeout(timer);
      child.kill();
      reject(new CancelledError());
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", () => signal?.removeEventListener("abort", onAbort));
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      for (const line of String(d).split("\n")) if (line.trim()) log?.(line.trim());
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(stdin);
  });
}

async function runClaude<T>(opts: AgentOptions): Promise<AgentRun<T>> {
  const c = config().agent.claude;
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(opts.schema),
    "--no-session-persistence",
    "--add-dir",
    CACHE_DIR,
    "--allowedTools",
    ...READ_ONLY_TOOLS,
    "--disallowedTools",
    "Edit",
    "Write",
    "NotebookEdit",
  ];
  for (const source of getProject().settings.sources.filter((s) => !s.archived && s.id !== getProject().settings.primarySourceId)) args.push("--add-dir", source.path);
  if (c.model) args.push("--model", c.model);
  opts.log?.(`claude: running (${opts.prompt.length} chars prompt)`);
  const { stdout, stderr, code } = await spawnCollect(c.executable, args, opts.prompt, opts.log);
  let parsed: { structured_output?: T; result?: string; is_error?: boolean; total_cost_usd?: number };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude exited ${code}: ${(stderr || stdout).slice(-2000)}`);
  }
  if (parsed.is_error || parsed.structured_output === undefined) {
    throw new Error(`claude returned no structured output: ${(parsed.result ?? stderr).slice(-2000)}`);
  }
  return { output: parsed.structured_output, agent: "claude", costUsd: parsed.total_cost_usd };
}

async function runCodex<T>(opts: AgentOptions): Promise<AgentRun<T>> {
  const c = config().agent.codex;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-codex-"));
  const schemaFile = path.join(tmp, "schema.json");
  const outFile = path.join(tmp, "out.json");
  fs.writeFileSync(schemaFile, JSON.stringify(opts.schema));
  const args = [
    ...c.args,
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
  ];
  if (c.model) args.push("-m", c.model);
  for (const img of (opts.images ?? []).slice(0, 12)) args.push("-i", img);
  args.push("-");
  opts.log?.(`codex: running (${opts.prompt.length} chars prompt)`);
  try {
    const { stderr, code } = await spawnCollect(c.executable, args, opts.prompt, opts.log);
    if (!fs.existsSync(outFile)) throw new Error(`codex exited ${code}: ${stderr.slice(-2000)}`);
    return { output: JSON.parse(fs.readFileSync(outFile, "utf8")) as T, agent: "codex" };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- schemas (strict: every property required, no extras; valid for both CLIs) ----------

const str = { type: "string" };
const strArr = { type: "array", items: str };
const obj = <T extends Record<string, object>>(properties: T) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const SUGGESTION_FIELDS = {
  title: str,
  duplicateOf: str,
  hook: str,
  summary: str,
  whyItMatters: str,
  kind: { type: "string", enum: ["feature", "map", "art", "fix", "tech", "story", "news", "other"] },
  appeal: { type: "integer", minimum: 1, maximum: 5 },
  recommendedFormat: { type: "string", enum: ["short", "long", "either"] },
  workDate: str,
  commits: strArr,
  files: strArr,
  notes: strArr,
  materials: strArr,
  suggestedShots: strArr,
};

export const SUGGESTIONS_SCHEMA = obj({
  suggestions: { type: "array", items: obj(SUGGESTION_FIELDS) },
});

export const SESSION_REVIEW_SCHEMA = obj({
  covered: { type: "array", items: obj({ suggestionId: str, commits: strArr, sessions: strArr }) },
  edits: { type: "array", items: obj({ suggestionId: str, hook: str, summary: str, whyItMatters: str, reason: str, commits: strArr, sessions: strArr }) },
  suggestions: { type: "array", items: obj({ ...SUGGESTION_FIELDS, sessions: strArr }) },
});

const { suggestedShots: _shots, ...STORY_FIELDS } = SUGGESTION_FIELDS;

export const STORY_DRAFT_SCHEMA = obj({
  suggestion: obj({ ...STORY_FIELDS, sessions: strArr }),
  absorbs: { type: "array", items: obj({ suggestionId: str, reason: str }) },
  related: { type: "array", items: obj({ title: str, reason: str }) },
  leftOut: { type: "array", items: obj({ item: str, reason: str }) },
  unsupported: strArr,
  shots: { type: "array", items: obj({ description: str, materialId: str }) },
});

export const QUESTIONS_SCHEMA = obj({
  questions: { type: "array", items: obj({ question: str, why: str }) },
});

export const REVIEW_SCHEMA = obj({
  edits: { type: "array", items: obj({ index: { type: "integer" }, narration: str, reason: str }) },
});

const SCRIPT_SCHEMA = obj({
  title: str,
  segments: {
    type: "array",
    items: obj({
      narration: str,
      onScreen: str,
      visual: obj({
        type: { type: "string", enum: ["editor", "material", "slide"] },
        description: str,
        target: str,
        motion: { type: "string", enum: ["still", "orbit", "push", "pan", "turn", "rise"] },
        angle: { type: "string", enum: ["front", "three-quarter", "side", "high", "top", "low"] },
        distance: { type: "string", enum: ["close", "medium", "wide"] },
        materialId: str,
        layout: { type: "string", enum: ["title", "bullets", "image", "compare", "stack", "outro", "none"] },
        entrance: { type: "string", enum: ["drop", "slide"] },
        heading: str,
        bullets: strArr,
        imageFrom: strArr,
      }),
    }),
  },
  metadata: obj({ title: str, description: str, tags: strArr }),
});

export const ARTICLE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "summary", "tags", "body", "images", "coverId"],
  properties: {
    title: { type: "string" }, summary: { type: "string" }, tags: { type: "array", items: { type: "string" } }, body: { type: "string" },
    images: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "alt"], properties: { id: { type: "string" }, alt: { type: "string" } } } },
    coverId: { type: "string" },
  },
};
export const ARTICLE_REVIEW_SCHEMA = { type: "object", additionalProperties: false, required: ["body", "changes"], properties: { body: { type: "string" }, changes: { type: "array", items: { type: "string" } } } };
export const SOCIAL_TEXT_SCHEMA = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } };

const COHOST_EDIT = {
  type: "object", additionalProperties: false, required: ["segment", "turn", "text", "reason"],
  properties: { segment: { type: "integer" }, turn: { type: "integer" }, text: { type: "string" }, reason: { type: "string" } },
};
/** Changed lines of a co-hosted script, by segment and turn index. */
export const TURN_EDITS_SCHEMA = { type: "object", additionalProperties: false, required: ["edits"], properties: { edits: { type: "array", items: COHOST_EDIT } } };

export const VERIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["turnId", "claim", "source", "supported", "reason"],
        properties: { turnId: { type: "string" }, claim: { type: "string" }, source: { type: "string", enum: ["evidence", "answer", "developerTurn", "none"] }, supported: { type: "boolean" }, reason: { type: "string" } },
      },
    },
  },
};

export function scriptSchema(targets: CaptureTarget[], coHosted = false) {
  const schema = structuredClone(SCRIPT_SCHEMA);
  if (coHosted) {
    const segment = schema.properties.segments.items;
    const fields = segment.properties as Record<string, object>;
    delete fields.narration;
    fields.turns = { type: "array", items: { type: "object", additionalProperties: false, required: ["speaker", "text"], properties: { speaker: { type: "string", enum: ["developer", "coHost"] }, text: { type: "string" } } } };
    segment.required = Object.keys(fields);
  }
  const visual = schema.properties.segments.items.properties.visual;
  visual.properties.type.enum = targets.length ? ["capture", "material", "slide"] : ["material", "slide"];
  const properties = visual.properties as Record<string, object>;
  properties.targetId = { type: "string", enum: ["", ...targets.map((t) => t.id)] };
  const models = [...new Set(targets.map((t) => (t.kind === "browser" ? "page" : "scene")))];
  properties.shotModel = { type: "string", enum: [...models, ""] };
  // Page shots of browser targets: which page, which device, and where it scrolls to.
  properties.url = { type: "string" };
  properties.device = { type: "string", enum: ["phone", "desktop", ""] };
  properties.scrollTo = { type: "string" };
  properties.credit = { type: "string" };
  properties.expectText = { type: "string" };
  properties.highlightText = { type: "string" };
  visual.required = Object.keys(properties);
  return schema;
}
