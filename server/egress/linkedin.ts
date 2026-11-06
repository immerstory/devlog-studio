import fs from "node:fs";
import { estimatedLength, TEXT_LIMIT } from "../../shared/publications.js";
import type { EgressConnection } from "../../shared/publications.js";
import type { EgressConnector } from "./provider.js";

const API = "https://api.linkedin.com";
/** LinkedIn retires versions regularly, so this one needs updating from time to time. */
const VERSION = "202610";
const SCOPES = "openid profile w_member_social";
const headers = (c: EgressConnection) => {
  if (!c.secrets?.accessToken) throw new Error("Connect this LinkedIn account first.");
  if (c.secrets.expiresAt && new Date(c.secrets.expiresAt).getTime() < Date.now()) throw new Error("This LinkedIn connection has expired. Connect it again in Settings.");
  return { Authorization: `Bearer ${c.secrets.accessToken}`, "X-Restli-Protocol-Version": "2.0.0", "Linkedin-Version": VERSION, "Content-Type": "application/json" };
};

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`LinkedIn ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export function linkedinAuthUrl(c: EgressConnection, redirectUri: string) {
  const q = new URLSearchParams({ response_type: "code", client_id: String(c.config.clientId ?? ""), redirect_uri: redirectUri, state: c.id, scope: SCOPES });
  return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
}

/** Exchanges the sign-in code. Personal connections get no refresh token, so the token's end date is shown in Settings. */
export async function linkedinExchange(c: EgressConnection, code: string, redirectUri: string) {
  const res = await call("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: String(c.config.clientId ?? ""), client_secret: c.secrets?.clientSecret ?? "" }),
  });
  const token = (await res.json()) as { access_token: string; expires_in: number };
  const me = await (await call(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token.access_token}` } })).json() as { sub: string; name?: string };
  return { secrets: { accessToken: token.access_token, expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }, personUrn: `urn:li:person:${me.sub}`, name: me.name };
}

async function uploadVideo(c: EgressConnection, file: string, owner: string, log: (l: string) => void): Promise<string> {
  const size = fs.statSync(file).size;
  const init = await (await call(`${API}/rest/videos?action=initializeUpload`, { method: "POST", headers: headers(c), body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }) })).json() as { value: { video: string; uploadToken: string; uploadInstructions: Array<{ firstByte: number; lastByte: number; uploadUrl: string }> } };
  const parts: string[] = [];
  const handle = fs.openSync(file, "r");
  try {
    for (const part of init.value.uploadInstructions) {
      const buffer = Buffer.alloc(part.lastByte - part.firstByte + 1);
      fs.readSync(handle, buffer, 0, buffer.length, part.firstByte);
      const res = await call(part.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(buffer) });
      parts.push(res.headers.get("etag") ?? "");
      log(`LinkedIn: uploaded part ${parts.length} of ${init.value.uploadInstructions.length}.`);
    }
  } finally { fs.closeSync(handle); }
  await call(`${API}/rest/videos?action=finalizeUpload`, { method: "POST", headers: headers(c), body: JSON.stringify({ finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken, uploadedPartIds: parts } }) });
  return init.value.video;
}

export const linkedinConnector: EgressConnector = {
  id: "linkedin",
  label: "LinkedIn",
  accepts: ["text", "video"],
  // Metrics of a personal post need a restricted permission, and the Posts API offers no key chosen in advance.
  capabilities: { schedules: false, idempotent: false, metrics: false },
  validate(content) {
    const problems: string[] = [];
    if (!content.text?.trim()) problems.push("Write the text first.");
    else if (estimatedLength(content.text) > TEXT_LIMIT.linkedin!) problems.push(`The text is over LinkedIn's ${TEXT_LIMIT.linkedin} characters.`);
    return problems;
  },
  async publish(publication, ctx) {
    const c = ctx.connection;
    const author = String(c.config.personUrn ?? "");
    if (!author) throw new Error("Connect this LinkedIn account first.");
    const body: Record<string, unknown> = { author, commentary: ctx.text.replace(/([\\|{}@\[\]()<>#*_~])/g, "\\$1"), visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false };
    const format = publication.content.videoFormat;
    if (format) {
      const file = ctx.post.renders[format]?.final;
      if (!file || !fs.existsSync(file)) throw new Error("The final video file is missing.");
      body.content = { media: { title: publication.content.title ?? ctx.post.title, id: await uploadVideo(c, file, author, ctx.log) } };
    } else if (ctx.linkUrl) {
      // LinkedIn doesn't read a page's metadata for API posts, so the post states it.
      body.content = { article: { source: ctx.linkUrl, title: publication.content.title ?? ctx.post.title, description: publication.content.description ?? "" } };
    }
    const res = await call(`${API}/rest/posts`, { method: "POST", headers: headers(c), body: JSON.stringify(body) });
    const id = res.headers.get("x-restli-id") ?? "";
    return { platformId: id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : undefined, sentText: ctx.text };
  },
  isPublic: async () => true,
};
