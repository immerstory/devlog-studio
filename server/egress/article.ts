import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { formatArticleTemplate } from "../outputs/article.js";
import { getProject } from "../projects.js";
import { projectId } from "../context.js";
import { getBuffer } from "../storage.js";
import { getMaterials, listSuggestions } from "../store.js";
import type { ArticleDraft } from "../../shared/outputs.js";
import type { EgressConnection, Publication } from "../../shared/publications.js";
import type { Format, Post } from "../../shared/types.js";
import type { EgressConnector, PublishContext } from "./provider.js";

const run = promisify(execFile);
const IMAGE = /\{\{image:([^}]+)\}\}/g;
export const imageRefs = (body: string) => [...new Set([...body.matchAll(IMAGE)].map((m) => m[1]))];
export const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "post";

export interface ArticleImageChoice { id: string; title: string; key: string; source: "material" | "shot" }

/** Everything an article can show: the post's materials and its captured shots' stills. */
export async function articleImageChoices(post: Post, materialIds: string[]): Promise<ArticleImageChoice[]> {
  const materials = (await getMaterials(projectId(), materialIds)).map((m): ArticleImageChoice => ({ id: m.id, title: m.title, key: m.kind === "image" ? m.key : m.previewKey, source: "material" }));
  const shots = Object.entries(post.scripts).flatMap(([format, script]) => (script?.segments ?? []).flatMap((s): ArticleImageChoice[] => {
    const media = s.media?.[format as Format];
    if (!media) return [];
    return [{ id: s.id, title: s.onScreen || (s.visual.type === "capture" ? s.visual.description : s.id), key: media.replace(/\.(mp4|mov|webm|mkv)$/i, ".jpg"), source: "shot" }];
  }));
  return [...materials, ...shots];
}

const articleUrl = (c: EgressConnection, slug: string) => {
  const base = String(c.config.baseUrl ?? "").replace(/\/+$/, "");
  return base ? `${base}${String(c.config.urlPattern || "/{{slug}}/").replaceAll("{{slug}}", slug)}` : undefined;
};
/** The article's address before it exists, so other publications can link to it. */
export const plannedArticleUrl = (c: EgressConnection, draft: ArticleDraft, title: string) => articleUrl(c, draft.slug || slugOf(title));

/** Writes the Markdown and its images into a folder; `imagePrefix` is the path the Markdown uses for them. */
export async function writeArticleFiles(post: Post, draft: ArticleDraft, targetFile: string, imagesDir: string, imagePrefix: string, values: PublishContext["values"], choices: ArticleImageChoice[]) {
  const slug = draft.slug || slugOf(draft.title);
  const byId = new Map(choices.map((c) => [c.id, c]));
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const fileFor = async (id: string) => {
    const choice = byId.get(id);
    if (!choice) throw new Error(`The article refers to an image that no longer exists: ${id}`);
    const name = `${id}${path.extname(choice.key) || ".jpg"}`;
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, name), await getBuffer(choice.key));
    return `${imagePrefix.replace(/\/+$/, "")}/${name}`;
  };
  let body = draft.body;
  for (const id of imageRefs(body)) {
    const src = await fileFor(id);
    body = body.replaceAll(`{{image:${id}}}`, `![${(draft.images?.[id]?.alt ?? "").replace(/[\[\]]/g, "")}](${src})`);
  }
  const embed = values.youtubeId ? `<iframe src="https://www.youtube-nocookie.com/embed/${values.youtubeId}" title="${draft.title.replace(/"/g, "&quot;")}" allowfullscreen loading="lazy"></iframe>` : "";
  body = body.replaceAll("{{youtube.embed}}", embed).replaceAll("{{youtube.url}}", values.youtubeUrl ?? "");
  const cover = draft.coverId ? await fileFor(draft.coverId) : "";
  const today = new Date().toISOString().slice(0, 10);
  const project = getProject().settings;
  fs.writeFileSync(targetFile, formatArticleTemplate(project.outputs.articleTemplate, { title: draft.title, summary: draft.summary, date: today, publishDate: post.publishDate ?? today, tags: draft.tags, project: project.publicTitle, slug, body, cover }));
  return { slug };
}

export function validateArticle(post: Post): string[] {
  const draft = post.article?.draft;
  if (!draft?.body.trim()) return ["Write the article first."];
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push("The article needs a title.");
  const refs = [...imageRefs(draft.body), ...(draft.coverId ? [draft.coverId] : [])];
  const missing = [...new Set(refs)].filter((id) => !draft.images?.[id]?.alt?.trim());
  if (missing.length) problems.push(`${missing.length} image(s) need alt text.`);
  return problems;
}

async function isLive(url: string | undefined) {
  if (!url) return true;
  return fetch(url, { method: "HEAD", redirect: "follow" }).then((r) => r.ok).catch(() => false);
}
/** The pictures of a post: from its topics, attached directly, and its captured shots. */
export async function postImageChoices(post: Post) {
  const topics = (await listSuggestions(projectId())).filter((s) => post.suggestionIds.includes(s.id));
  return articleImageChoices(post, [...new Set([...topics.flatMap((s) => s.materialIds ?? []), ...post.materialIds])]);
}

export const folderConnector: EgressConnector = {
  id: "folder",
  label: "Folder",
  accepts: ["article"],
  capabilities: { schedules: false, idempotent: true, metrics: false },
  validate: (_content, post) => validateArticle(post),
  async publish(_publication, ctx) {
    const draft = ctx.post.article!.draft!;
    const slug = draft.slug || slugOf(draft.title);
    const dir = path.join(String(ctx.connection.config.path ?? ""), slug);
    if (!ctx.connection.config.path) throw new Error("Choose a folder for this connection first.");
    await writeArticleFiles(ctx.post, draft, path.join(dir, "article.md"), path.join(dir, "images"), "images", ctx.values, await postImageChoices(ctx.post));
    return { platformId: dir, url: articleUrl(ctx.connection, slug) };
  },
  isPublic: (result) => isLive(result.url),
};

/**
 * Writes into a static site's content folder on a new branch, in a temporary worktree, so the site's own checkout
 * and any uncommitted work in it stay untouched. Pushing is a per-connection choice and off by default.
 */
export const gitSiteConnector: EgressConnector = {
  id: "git-site",
  label: "Git site",
  accepts: ["article"],
  capabilities: { schedules: false, idempotent: true, metrics: false },
  validate: (_content, post) => validateArticle(post),
  async publish(publication: Publication, ctx) {
    const c = ctx.connection.config;
    const repo = String(c.repoPath ?? "");
    if (!repo) throw new Error("Choose the site's Git working copy for this connection first.");
    const draft = ctx.post.article!.draft!;
    const slug = draft.slug || slugOf(draft.title);
    const branch = `${String(c.branchPrefix || "devlog/")}${slug}`;
    const git = (cwd: string, ...args: string[]) => run("git", args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const exists = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(() => true, () => false);
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-site-"));
    fs.rmSync(worktree, { recursive: true, force: true });
    await git(repo, "worktree", "add", ...(exists ? [worktree, branch] : ["-b", branch, worktree]));
    try {
      const target = path.join(worktree, String(c.contentDir || "content/posts"), String(c.fileName || "{{slug}}.md").replaceAll("{{slug}}", slug));
      await writeArticleFiles(ctx.post, draft, target, path.join(worktree, String(c.imagesDir || `static/images/${slug}`).replaceAll("{{slug}}", slug)), String(c.imagePrefix || `/images/${slug}`).replaceAll("{{slug}}", slug), ctx.values, await postImageChoices(ctx.post));
      await git(worktree, "add", "-A");
      const changed = await git(worktree, "diff", "--cached", "--quiet").then(() => false, () => true);
      if (changed) await git(worktree, "commit", "-m", `Add post: ${draft.title}`);
      const commit = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
      if (c.push === true) { await git(worktree, "push", "-u", "origin", branch); ctx.log(`Pushed ${branch}.`); } else ctx.log(`Committed to the local branch ${branch}. Merge it to publish the article.`);
      return { platformId: `${branch}@${commit}`, url: articleUrl(ctx.connection, slug) };
    } finally {
      await git(repo, "worktree", "remove", "--force", worktree).catch(() => fs.rmSync(worktree, { recursive: true, force: true }));
    }
  },
  isPublic: (result) => isLive(result.url),
};
