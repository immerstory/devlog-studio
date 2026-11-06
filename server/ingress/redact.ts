/** Secret patterns removed from everything a digest stores. Commit hashes (up to 40 hex digits) stay. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([a-z]+:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
  // Long opaque values: at least 41 characters, so a full commit hash doesn't match.
  /\b[A-Za-z0-9+/_-]{41,}={0,2}/g,
];
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|credential)[A-Za-z0-9_-]*|password|passwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi;

export function redact(text: string, terms: string[] = []): string {
  let out = text.replace(ASSIGNMENT, "$1$2[redacted]");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  for (const term of terms.map((t) => t.trim()).filter(Boolean)) out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
  return out;
}

const ABSOLUTE_PATH = /(?:\b[A-Za-z]:[\\/]|(?<![\w.~/-])\/(?:home|Users|mnt|[a-z])\/)[^\s"'`<>|,;()]*/g;

/** Makes paths inside a root relative to it, and replaces every other absolute path, because those name the developer's computer and other work. */
export function withoutAbsolutePaths(text: string, roots: string[] = []): string {
  let out = text;
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const forward = root.replace(/\\/g, "/").replace(/\/$/, "");
    const shell = forward.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    for (const form of new Set([forward, forward.replace(/\//g, "\\"), shell])) {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`${literal}(?:[\\\\/]|(?![\\w.-]))`, "gi"), "");
    }
  }
  return out.replace(ABSOLUTE_PATH, "[path]");
}

export function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
