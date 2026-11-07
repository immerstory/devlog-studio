/** public can be quoted, private can only inform, and excluded never reaches an agent. */
export type ActivityVisibility = "public" | "private" | "excluded";
export type ActivityKind = "commit" | "workingChange" | "session" | "pullRequest" | "issue" | "release" | "note" | "material" | "feed";

export interface ActivityRefs {
  repo?: string;
  branch?: string;
  commits: string[];
  files: string[];
  urls: string[];
  issues: string[];
}

/** One piece of work on one local day, in the shape every ingress connector produces. */
export interface ActivityRecord {
  /** Stable: connector, source and native ID. */
  id: string;
  connector: string;
  sourceId: string;
  kind: ActivityKind;
  startedAt: string;
  endedAt: string;
  /** The local calendar day. */
  date: string;
  title: string;
  summary: string;
  refs: ActivityRefs;
  visibility: ActivityVisibility;
  /** The developer set the visibility, so it no longer follows the automatic rule. */
  visibilityChosen?: boolean;
  /** A change makes dependent summaries and checks out of date. */
  contentHash: string;
  /** Connector-specific data; never raw logs. */
  detail?: unknown;
}

/** What a session day leaves behind. Tool output, file contents, thinking and pasted text stay out. */
export interface SessionDigest {
  tool: "claude" | "codex";
  sessionId: string;
  sessionTitle?: string;
  /** Minutes of the day with activity; a set, so reading a line twice changes nothing. */
  activeMinutes: number[];
  files: string[];
  /** Hashes of edited files outside the project's sources: enough to count them, without naming other work. */
  otherFiles?: string[];
  commands: string[];
  commits: string[];
  checks: Array<{ command: string; ok: boolean; error?: string }>;
  /** The developer's prompts, shortened and redacted. */
  prompts: string[];
  /** Agent summary, valid while its hash matches the digest. */
  aiSummary?: SessionSummary;
}

export interface SessionSummary {
  attempted: string;
  failed: string;
  changedCourse: string;
  shipped: string;
  digestHash: string;
  createdAt: string;
}

/** An image the developer sent to a coding agent. Only an image the developer adds becomes a material and reaches an agent. */
export interface SessionImage {
  /** From the content's hash, so one image is stored once per project. */
  id: string;
  createdAt: string;
  /** Local day of the message. */
  date: string;
  /** Time of the message. */
  at: string;
  tool: SessionDigest["tool"];
  sessionId: string;
  /** The activity record of the session's day. */
  recordId: string;
  sourceId: string;
  sessionTitle?: string;
  title: string;
  /** The message's words, cleaned and redacted like a digest's prompts. */
  message: string;
  status: "inbox" | "dismissed" | "added";
  materialId?: string;
  /** The session counted as other work when the image was read. */
  otherWork?: boolean;
  fileName: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  key: string;
  thumbKey: string;
  previewKey: string;
}

/** A configured activity source of a project. Git sources are implicit. */
export interface ActivitySource {
  id: string;
  connector: "claude-sessions" | "codex-sessions" | "github" | "forgejo";
  enabled: boolean;
  /** Terms removed from digests, such as unannounced feature names. */
  redactTerms?: string[];
  /** A session source also collects the images the developer sent to the agent. They wait in an inbox until the developer decides. */
  importImages?: boolean;
  /** owner/name, for a forge. */
  repo?: string;
  /** The web address of a self-hosted forge. Its token is stored apart, so it never reaches the client. */
  baseUrl?: string;
}
export const activitySourceId = (connector: string, repo?: string) => `activity-${connector}${repo ? `-${repo.replace(/\W+/g, "-")}` : ""}`;

/** Below this share of edits inside the project's sources, a session counts as other work. */
const OWN_WORK_SHARE = 0.2;
/** A session that edits mostly outside the project's sources is about something else, whatever folder it runs in. */
export function looksLikeOtherWork(digest: Pick<SessionDigest, "files" | "otherFiles">): boolean {
  const other = digest.otherFiles?.length ?? 0;
  return other > 0 && digest.files.length / (digest.files.length + other) < OWN_WORK_SHARE;
}
/** The session's own title, or its first request, because that says what it was about. */
export const sessionTitleOf = (digest: Pick<SessionDigest, "tool" | "sessionTitle" | "prompts">) => digest.sessionTitle || digest.prompts[0] || `${digest.tool === "claude" ? "Claude" : "Codex"} session`;

export type LinkStrength = "exact" | "strong" | "weak" | "manual";
export interface ActivityLink {
  a: string;
  b: string;
  strength: LinkStrength;
  reason: string;
  /** A developer's decision that this pair is apart. */
  split?: boolean;
}
export interface ActivityThread {
  id: string;
  recordIds: string[];
}
