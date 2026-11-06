import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activitySourceId, type ActivityRecord, type ActivitySource } from "../../shared/activity.js";
import { getValue } from "../store.js";
import { projectId } from "../context.js";
import type { CollectEvent, IngressConnector, SourceCandidate } from "./provider.js";
import { localDate } from "./provider.js";
import { shorten } from "./redact.js";

const run = promisify(execFile);
/** Calls one forge's API with a path relative to its root. */
export type ForgeCall = (path: string) => Promise<unknown>;

interface ForgeDialect {
  connector: "github" | "forgejo";
  pageSize: number;
  page(size: number, page: number): string;
  pulls: (repo: string) => string;
  issues: (repo: string, from: string) => string;
}
const GITHUB: ForgeDialect = {
  connector: "github", pageSize: 100,
  page: (size, page) => `per_page=${size}&page=${page}`,
  pulls: (repo) => `/repos/${repo}/pulls?state=all&sort=updated&direction=desc`,
  issues: (repo, from) => `/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${from}T00:00:00Z`,
};
/** Forgejo and Gitea share this API. */
const FORGEJO: ForgeDialect = {
  connector: "forgejo", pageSize: 50,
  page: (size, page) => `limit=${size}&page=${page}`,
  pulls: (repo) => `/repos/${repo}/pulls?state=all&sort=recentupdate`,
  issues: (repo, from) => `/repos/${repo}/issues?state=all&type=issues&since=${from}T00:00:00Z`,
};

const GITHUB_HOST = "github.com";
/** Reads the host and repository from a remote URL: ssh://git@host:2222/o/r.git, git@host:o/r.git or https://host/o/r.git. */
export function parseRemote(remoteUrl: string): { host: string; repo: string } | undefined {
  const url = remoteUrl.trim();
  const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(url) ?? /^(?:[^@/]+@)?([^/:]+):(.+?)(?:\.git)?\/?$/.exec(url);
  return m && /^[^/]+\/[^/]+$/.test(m[2]) ? { host: m[1].toLowerCase(), repo: m[2] } : undefined;
}
/** The web page of a commit. GitHub, Forgejo, Gitea and GitLab all serve this path; the remote's SSH port and credentials stay out of it. */
export function commitUrl(remoteUrl: string, hash: string): string | undefined {
  const remote = parseRemote(remoteUrl);
  return remote ? `https://${remote.host}/${remote.repo}/commit/${hash}` : undefined;
}
export const githubRepo = (remoteUrl: string) => { const r = parseRemote(remoteUrl); return r?.host === GITHUB_HOST ? r.repo : undefined; };

async function remotes(paths: string[]) {
  const found = await Promise.all(paths.map(async (cwd) => parseRemote((await run("git", ["remote", "get-url", "origin"], { cwd, windowsHide: true }).catch(() => ({ stdout: "" }))).stdout)));
  return [...new Map(found.filter((r): r is NonNullable<typeof r> => !!r).map((r) => [`${r.host}/${r.repo}`, r])).values()];
}

const pageOf = async <T>(call: ForgeCall, dialect: ForgeDialect, path: string, keep: (item: T) => boolean, stop: (item: T) => boolean): Promise<T[]> => {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const items = (await call(`${path}${path.includes("?") ? "&" : "?"}${dialect.page(dialect.pageSize, page)}`)) as T[];
    if (!items?.length) break;
    out.push(...items.filter(keep));
    if (items.some(stop) || items.length < dialect.pageSize) break;
  }
  return out;
};

interface Pull { number: number; title: string; body: string | null; state: string; html_url: string; created_at: string; updated_at: string; merged_at: string | null; closed_at: string | null; head: { ref: string } }
interface Issue { number: number; title: string; body: string | null; state: string; html_url: string; created_at: string; updated_at: string; closed_at: string | null; pull_request?: unknown }
interface Release { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string | null; draft: boolean }

const ISSUE_REF = /(?:^|\s)#(\d+)\b/g;

/** Reads pull requests, issues and releases updated since the range's start. Records of a private repository are private. */
async function* collectForge(dialect: ForgeDialect, repo: string, from: string, call: ForgeCall): AsyncGenerator<CollectEvent> {
  const info = (await call(`/repos/${repo}`)) as { private: boolean };
  const c = dialect.connector;
  const base = { connector: c, sourceId: `${c}:${repo}`, visibility: (info.private ? "private" : "public") as ActivityRecord["visibility"], contentHash: "" };
  const isNew = (updated: string) => updated.slice(0, 10) >= from;
  const pulls = await pageOf<Pull>(call, dialect, dialect.pulls(repo), (p) => isNew(p.updated_at), (p) => !isNew(p.updated_at));
  for (const p of pulls) {
    const commits = (await call(`/repos/${repo}/pulls/${p.number}/commits?${dialect.page(dialect.pageSize, 1)}`)) as Array<{ sha: string }>;
    const at = p.merged_at ?? p.closed_at ?? p.updated_at;
    yield { record: { ...base, id: `${c}:${repo}:pull:${p.number}`, kind: "pullRequest", startedAt: p.created_at, endedAt: at, date: localDate(at), title: `#${p.number} ${p.title}`, summary: shorten(p.body ?? "", 600), refs: { repo, branch: p.head?.ref, commits: (commits ?? []).map((x) => x.sha), files: [], urls: [p.html_url], issues: [...(p.body ?? "").matchAll(ISSUE_REF)].map((m) => m[1]) }, detail: { state: p.merged_at ? "merged" : p.state } } };
  }
  const issues = await pageOf<Issue>(call, dialect, dialect.issues(repo, from), (i) => !i.pull_request, () => false);
  for (const i of issues) {
    const at = i.closed_at ?? i.updated_at;
    yield { record: { ...base, id: `${c}:${repo}:issue:${i.number}`, kind: "issue", startedAt: i.created_at, endedAt: at, date: localDate(at), title: `#${i.number} ${i.title}`, summary: shorten(i.body ?? "", 600), refs: { repo, commits: [], files: [], urls: [i.html_url], issues: [String(i.number)] }, detail: { state: i.state } } };
  }
  const releases = await pageOf<Release>(call, dialect, `/repos/${repo}/releases`, (r) => !r.draft && !!r.published_at && r.published_at.slice(0, 10) >= from, () => false);
  for (const r of releases) yield { record: { ...base, id: `${c}:${repo}:release:${r.tag_name}`, kind: "release", startedAt: r.published_at!, endedAt: r.published_at!, date: localDate(r.published_at!), title: r.name || r.tag_name, summary: shorten(r.body ?? "", 600), refs: { repo, commits: [], files: [], urls: [r.html_url], issues: [] } } };
}

export const collectGithub = (repo: string, from: string, call: ForgeCall = gh) => collectForge(GITHUB, repo, from, call);
export const collectForgejo = (repo: string, from: string, call: ForgeCall) => collectForge(FORGEJO, repo, from, call);

/** GitHub goes through the `gh` CLI, which keeps the credentials out of this app. */
const gh: ForgeCall = async (path) => JSON.parse((await run("gh", ["api", path], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout);

/** A Forgejo or Gitea server. The error says what happened, and never includes the token. */
export function forgejoCall(baseUrl: string, token: string): ForgeCall {
  return async (path) => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/v1${path}`, { headers: { Authorization: `token ${token}`, Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) throw new Error(`The server refused this token (${res.status}). It needs read access to the repository and its issues.`);
    if (!res.ok) throw new Error(`The server answered ${res.status} for ${path.split("?")[0]}.`);
    return res.json();
  };
}

export const forgeTokenKey = (sourceId: string) => `forgeToken:${sourceId}`;

const recognized = new Map<string, boolean>();
/** Sends no credentials: it only checks whether the host looks like a Forgejo or Gitea server. Asks each host once while the app runs. */
async function looksLikeForgejo(baseUrl: string): Promise<boolean> {
  const known = recognized.get(baseUrl);
  if (known !== undefined) return known;
  const answers = await Promise.all(["/swagger.v1.json", "/api/v1/version"].map((p) => fetch(`${baseUrl}${p}`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok || r.status === 401 || r.status === 403, () => false)));
  const result = answers.some(Boolean);
  // A server that didn't answer may only be down, so only a positive answer lasts.
  if (result) recognized.set(baseUrl, true);
  return result;
}

const sourcePaths = (project: { sources: Array<{ path: string; archived?: boolean }> }) => project.sources.filter((s) => !s.archived).map((s) => s.path);

export const githubConnector: IngressConnector = {
  id: "github",
  label: "GitHub",
  async discover(project) {
    const found = (await remotes(sourcePaths(project))).filter((r) => r.host === GITHUB_HOST);
    return found.map((r): SourceCandidate => ({ connector: "github", label: `GitHub: ${r.repo}`, detail: "Pull requests, issues and releases, read through the gh CLI", found: 1, repo: r.repo }));
  },
  async *collect(_project, source, _cursor, range) {
    if (source?.repo) yield* collectGithub(source.repo, range.from);
  },
};

export const forgejoConnector: IngressConnector = {
  id: "forgejo",
  label: "Forgejo or Gitea",
  async discover(project) {
    const found = (await remotes(sourcePaths(project))).filter((r) => r.host !== GITHUB_HOST);
    return Promise.all(found.map(async (r): Promise<SourceCandidate> => {
      const baseUrl = `https://${r.host}`;
      const id = activitySourceId("forgejo", r.repo);
      const recognized = await looksLikeForgejo(baseUrl);
      return {
        connector: "forgejo", label: `${r.host}: ${r.repo}`, found: 1, repo: r.repo, baseUrl,
        tokenSet: !!(await getValue<string>(projectId(), forgeTokenKey(id))),
        detail: recognized ? "Pull requests, issues and releases. Needs an access token with read access." : "This server doesn't answer like Forgejo or Gitea at this address. Correct the address if its web interface is elsewhere.",
      };
    }));
  },
  async *collect(_project, source: ActivitySource | undefined, _cursor, range) {
    if (!source?.repo || !source.baseUrl) return;
    const token = await getValue<string>(projectId(), forgeTokenKey(source.id));
    if (!token) throw new Error(`Enter an access token for ${source.repo} in the project settings.`);
    yield* collectForgejo(source.repo, range.from, forgejoCall(source.baseUrl, token));
  },
};
