import crypto from "node:crypto";
import { estimatedLength, graphemes, TEXT_LIMIT } from "../../shared/publications.js";
import type { EgressConnection } from "../../shared/publications.js";
import type { EgressConnector } from "./provider.js";

const DEFAULT_SERVICE = "https://bsky.social";
const PUBLIC_API = "https://public.api.bsky.app";
const MAX_THUMBNAIL_BYTES = 1_000_000;
const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/** A record key in the protocol's time-based format, chosen before sending so that a retry can't post twice. */
export function newRecordKey(now = Date.now()): string {
  let value = (BigInt(now) * 1000n << 10n) | BigInt(crypto.randomInt(1024));
  let out = "";
  for (let i = 0; i < 13; i++) { out = TID_CHARS[Number(value & 31n)] + out; value >>= 5n; }
  return out;
}

/** Link and hashtag facets. Bluesky counts these positions in UTF-8 bytes, and plain URLs in text aren't clickable. */
export function facetsFor(text: string) {
  const facets: Array<{ index: { byteStart: number; byteEnd: number }; features: Array<Record<string, string>> }> = [];
  const span = (at: number, value: string) => {
    const byteStart = Buffer.byteLength(text.slice(0, at));
    return { byteStart, byteEnd: byteStart + Buffer.byteLength(value) };
  };
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g)) facets.push({ index: span(m.index, m[0]), features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_]+)/gu)) facets.push({ index: span(m.index + m[1].length, m[2]), features: [{ $type: "app.bsky.richtext.facet#tag", tag: m[2].slice(1) }] });
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

const serviceOf = (c: EgressConnection) => (typeof c.config.service === "string" && c.config.service) || DEFAULT_SERVICE;

async function xrpc<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Bluesky ${res.status}: ${body.slice(0, 300)}`), { status: res.status, body });
  return (body ? JSON.parse(body) : {}) as T;
}

async function session(c: EgressConnection) {
  if (!c.secrets?.appPassword) throw new Error("Set an app password for this Bluesky connection first.");
  return xrpc<{ accessJwt: string; did: string; handle: string }>(`${serviceOf(c)}/xrpc/com.atproto.server.createSession`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: c.config.handle, password: c.secrets.appPassword }),
  });
}

export const blueskyConnector: EgressConnector = {
  id: "bluesky",
  label: "Bluesky",
  accepts: ["text"],
  capabilities: { schedules: false, idempotent: true, metrics: true },
  validate(content) {
    const problems: string[] = [];
    if (!content.text?.trim()) problems.push("Write the text first.");
    else if (estimatedLength(content.text) > TEXT_LIMIT.bluesky!) problems.push(`The text is over Bluesky's ${TEXT_LIMIT.bluesky} characters, counting each link as up to 60.`);
    return problems;
  },
  async publish(publication, ctx) {
    const c = ctx.connection;
    if (graphemes(ctx.text) > TEXT_LIMIT.bluesky!) throw new Error(`The text is ${graphemes(ctx.text)} characters, over Bluesky's limit.`);
    const auth = await session(c);
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${auth.accessJwt}` };
    const record: Record<string, unknown> = { $type: "app.bsky.feed.post", text: ctx.text, createdAt: new Date().toISOString(), langs: ["en"] };
    const facets = facetsFor(ctx.text);
    if (facets.length) record.facets = facets;
    if (ctx.linkUrl) {
      // The client builds the card itself: Bluesky doesn't fetch a page's metadata when a post is created.
      const external: Record<string, unknown> = { uri: ctx.linkUrl, title: publication.content.title ?? ctx.post.title, description: publication.content.description ?? "" };
      const image = await ctx.thumbnail?.().catch(() => undefined);
      if (image && image.length <= MAX_THUMBNAIL_BYTES) {
        const blob = await xrpc<{ blob: unknown }>(`${serviceOf(c)}/xrpc/com.atproto.repo.uploadBlob`, { method: "POST", headers: { "Content-Type": "image/jpeg", Authorization: headers.Authorization }, body: new Uint8Array(image) });
        external.thumb = blob.blob;
      }
      record.embed = { $type: "app.bsky.embed.external", external };
    }
    const rkey = publication.content.recordKey ?? newRecordKey();
    const postUrl = (uri: string) => `https://bsky.app/profile/${auth.handle}/post/${uri.split("/").pop()}`;
    try {
      const created = await xrpc<{ uri: string }>(`${serviceOf(c)}/xrpc/com.atproto.repo.createRecord`, { method: "POST", headers, body: JSON.stringify({ repo: auth.did, collection: "app.bsky.feed.post", rkey, record }) });
      return { platformId: created.uri, url: postUrl(created.uri), sentText: ctx.text };
    } catch (err) {
      // The same key exists when an earlier attempt got through and its answer was lost.
      const existing = await xrpc<{ uri: string }>(`${serviceOf(c)}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(auth.did)}&collection=app.bsky.feed.post&rkey=${rkey}`, { headers }).catch(() => undefined);
      if (existing?.uri) return { platformId: existing.uri, url: postUrl(existing.uri), sentText: ctx.text };
      throw err;
    }
  },
  isPublic: async () => true,
  async metrics(result) {
    if (!result.platformId) return {};
    const { posts } = await xrpc<{ posts: Array<{ likeCount?: number; repostCount?: number; replyCount?: number }> }>(`${PUBLIC_API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(result.platformId)}`, {});
    const p = posts[0];
    return p ? { likes: p.likeCount ?? 0, reposts: p.repostCount ?? 0, replies: p.replyCount ?? 0 } : ({} as Record<string, number>);
  },
};
