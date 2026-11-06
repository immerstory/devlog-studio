import path from "node:path";
import { OUTPUT_DIR } from "../config.js";
import type { Post } from "../../shared/types.js";

export function outputFolder(projectSlug: string, post: Post, date: string): string {
  if (post.outputDirs.length) return post.outputDirs[0];
  const title = post.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  return path.join(OUTPUT_DIR, projectSlug, `${post.publishDate ?? date}-${title}-${post.id}`);
}
