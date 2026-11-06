import { currentContext } from "./context.js";
import { getConnection, getProject, saveConnection } from "./projects.js";
import fs from "node:fs";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { config } from "./config.js";
import { currentJobSignal } from "./jobs.js";

/**
 * YouTube Data API v3: OAuth for an installed app with a loopback redirect, resumable video upload and
 * caption upload. The client id/secret come from the user's own Google Cloud project; the refresh token
 * is stored in the settings and never returned to the browser.
 */

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.force-ssl"];
const redirectUri = () => `http://127.0.0.1:${config().port}/api/youtube/callback`;

const pending = new Map<string, { verifier: string; connectionId: string; expires: number }>(); // OAuth state -> PKCE verifier
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function authUrl(connectionId: string): string {
  const y = getConnection(connectionId);
  if (!y.clientId || !y.clientSecret) throw Object.assign(new Error("Enter the OAuth client ID and secret in Settings first."), { status: 400 });
  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  pending.set(state, { verifier, connectionId, expires: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: y.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google OAuth: ${data.error_description ?? data.error ?? res.statusText}`);
  return data;
}

/** Completes the OAuth flow and stores the refresh token and channel name. */
export async function handleCallback(code: string, state: string) {
  const attempt = pending.get(state);
  if (!attempt || attempt.expires < Date.now()) throw new Error("Unknown or expired sign-in attempt; start again from Settings.");
  pending.delete(state);
  const y = getConnection(attempt.connectionId);
  const t = await tokenRequest({ code, client_id: y.clientId, client_secret: y.clientSecret!, redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: attempt.verifier });
  if (!t.refresh_token) throw new Error("Google returned no refresh token; remove the app's access in your Google account and connect again.");
  const channel = await api<{ items?: Array<{ id: string; snippet: { title: string } }> }>("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {}, t.access_token);
  const selected = channel.items?.[0];
  if (!selected) throw new Error("No YouTube channel was returned");
  if (y.channelId && y.channelId !== selected.id) throw new Error("Choose the original channel when reconnecting, or create another connection.");
  await saveConnection({ ...y, refreshToken: t.refresh_token, channelId: selected.id, channelTitle: selected.snippet.title });
  cachedTokens.delete(y.id);
}
export async function disconnect(connectionId: string) {
  const c = getConnection(connectionId);
  cachedTokens.delete(connectionId);
  await saveConnection({ ...c, refreshToken: undefined });
}
const cachedTokens = new Map<string, { token: string; expires: number; refreshToken: string }>();
async function accessToken(): Promise<string> {
  const id = currentContext().connectionId ?? getProject().settings.publishing.connectionId;
  const y = getConnection(id);
  if (!y.refreshToken) throw new Error("YouTube is not connected; connect it in Settings.");
  const cached = cachedTokens.get(y.id);
  if (cached && cached.refreshToken === y.refreshToken && cached.expires - 60_000 > Date.now()) return cached.token;
  const t = await tokenRequest({ client_id: y.clientId, client_secret: y.clientSecret!, refresh_token: y.refreshToken, grant_type: "refresh_token" });
  cachedTokens.set(y.id, { token: t.access_token!, expires: Date.now() + (t.expires_in ?? 3600) * 1000, refreshToken: y.refreshToken });
  return t.access_token!;
}

async function api<T>(url: string, init: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token ?? (await accessToken())}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`YouTube ${res.status}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface UploadRequest {
  file: string;
  title: string;
  description: string;
  tags: string[];
  /** ISO time to go public; omitted for immediate publishing with `privacy`. */
  publishAt?: string;
  privacy: "public" | "unlisted" | "private";
  /** Overrides the project's default; a co-hosted video always declares synthetic media. */
  containsSyntheticMedia?: boolean;
}

/** Keeps the tag list within YouTube's 500-character total (commas and quotes around spaced tags count). */
export function fitTags(tags: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const tag of tags.map((t) => t.replace(/[<>]/g, "").trim()).filter(Boolean)) {
    const cost = tag.length + (tag.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > 500) break;
    out.push(tag);
    used += cost;
  }
  return out;
}

const clean = (s: string) => s.replace(/[<>]/g, "");

/** Resumable upload of one video; returns its id. */
export async function uploadVideo(req: UploadRequest, log: (l: string) => void): Promise<string> {
  const y = config().youtube;
  const size = fs.statSync(req.file).size;
  const metadata = {
    snippet: {
      title: clean(req.title).slice(0, 100),
      description: Buffer.from(clean(req.description)).subarray(0, 5000).toString("utf8").replace(/�+$/, ""),
      tags: fitTags(req.tags),
      categoryId: y.categoryId || "20",
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
    },
    status: {
      privacyStatus: req.publishAt ? "private" : req.privacy,
      ...(req.publishAt ? { publishAt: req.publishAt } : {}),
      selfDeclaredMadeForKids: y.madeForKids,
      containsSyntheticMedia: req.containsSyntheticMedia ?? y.containsSyntheticMedia,
    },
  };
  const token = await accessToken();
  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": "video/mp4" },
    body: JSON.stringify(metadata),
  });
  const location = init.headers.get("location");
  if (!init.ok || !location) throw new Error(`YouTube upload could not start (${init.status}): ${(await init.text()).slice(0, 600)}`);

  let sent = 0;
  let lastPct = -1;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      sent += chunk.length;
      const pct = Math.floor((sent / size) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log(`Uploading to YouTube: ${pct}%`);
      }
      cb(null, chunk);
    },
  });
  const body = Readable.toWeb(fs.createReadStream(req.file).pipe(counter)) as unknown as BodyInit;
  // Cancelling the job aborts the upload.
  const res = await fetch(location, { method: "PUT", headers: { "Content-Length": String(size), "Content-Type": "video/mp4" }, body, duplex: "half", signal: currentJobSignal() } as RequestInit);
  const text = await res.text();
  if (!res.ok) throw new Error(`YouTube upload failed (${res.status}): ${text.slice(0, 600)}`);
  return (JSON.parse(text) as { id: string }).id;
}

/** Statistics, visibility and publication time for up to 50 videos per request (1 quota unit each). */
export async function videoDetails(ids: string[]) {
  const out: Array<{ id: string; views: number; likes: number; comments: number; privacy?: string; publishedAt?: string }> = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await api<{ items?: Array<{ id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; status?: { privacyStatus?: string }; snippet?: { publishedAt?: string } }> }>(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,status,snippet&id=${batch.join(",")}`,
    );
    for (const it of r.items ?? [])
      out.push({
        id: it.id,
        views: Number(it.statistics?.viewCount ?? 0),
        likes: Number(it.statistics?.likeCount ?? 0),
        comments: Number(it.statistics?.commentCount ?? 0),
        privacy: it.status?.privacyStatus,
        publishedAt: it.snippet?.publishedAt,
      });
  }
  return out;
}

/** Adds an English caption track from an SRT file. */
export async function uploadCaptions(videoId: string, srtFile: string) {
  const boundary = `devlog${crypto.randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ snippet: { videoId, language: "en", name: "English", isDraft: false } });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/x-subrip\r\n\r\n`),
    fs.readFileSync(srtFile),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  await api("https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
}
