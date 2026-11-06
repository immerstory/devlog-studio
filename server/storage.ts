import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { Request, Response } from "express";
import { CACHE_DIR } from "./config.js";

/** Garage (S3) object storage for all media: materials, captures, narration audio and renders. */
let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY } = process.env;
    if (!S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) throw new Error("S3 settings are missing; run `npm run setup`.");
    client = new S3Client({
      endpoint: S3_ENDPOINT,
      region: "garage",
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });
  }
  return client;
}

const bucket = () => process.env.S3_BUCKET || "devlog";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".json": "application/json",
  ".srt": "application/x-subrip",
  ".txt": "text/plain; charset=utf-8",
};
export const contentTypeOf = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";

export async function putFile(key: string, file: string, contentType = contentTypeOf(file)) {
  await new Upload({ client: s3(), params: { Bucket: bucket(), Key: key, Body: fs.createReadStream(file), ContentType: contentType } }).done();
}

export async function putBuffer(key: string, body: Buffer | string, contentType = contentTypeOf(key)) {
  await new Upload({ client: s3(), params: { Bucket: bucket(), Key: key, Body: body, ContentType: contentType } }).done();
}

export async function exists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function getBuffer(key: string): Promise<Buffer> {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

/** Local copy of an object under cache/, reused while the object size is unchanged. */
export async function cached(key: string): Promise<string> {
  const local = path.join(CACHE_DIR, "objects", ...key.split("/"));
  const head = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
  if (fs.existsSync(local) && fs.statSync(local).size === head.ContentLength) return local;
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  await pipeline(r.Body as Readable, fs.createWriteStream(local));
  return local;
}

export async function deletePrefix(prefix: string) {
  let token: string | undefined;
  do {
    const list = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (keys.length) await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys } }));
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}

export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((o) => o.Key!));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
export async function deleteKey(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Streams an object to the client with HTTP range support, which video seeking needs. */
export async function serveObject(key: string, req: Request, res: Response) {
  let r: GetObjectCommandOutput;
  try {
    r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: req.headers.range }));
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    res.status(status === 416 ? 416 : 404).end();
    return;
  }
  res.status(r.ContentRange ? 206 : 200);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", r.ContentType ?? contentTypeOf(key));
  if (r.ContentLength !== undefined) res.setHeader("Content-Length", String(r.ContentLength));
  if (r.ContentRange) res.setHeader("Content-Range", r.ContentRange);
  res.setHeader("Cache-Control", "no-cache");
  if (r.ETag) res.setHeader("ETag", r.ETag);
  await pipeline(r.Body as Readable, res).catch(() => {});
}
