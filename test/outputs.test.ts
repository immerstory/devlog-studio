import { test } from "node:test";
import assert from "node:assert/strict";
import { formatArticleTemplate, articleOutput, type ArticleValues } from "../server/outputs/article.js";
import { ARTICLE_TEMPLATE } from "../shared/projects.js";
import { outputsWithSegment, outputStage, setOutputStage } from "../shared/outputs.js";
import type { Post } from "../shared/types.js";
import { outputFolder } from "../server/outputs/folders.js";

test("article template encodes YAML scalars and lists while preserving Markdown", () => {
  const values: ArticleValues = { title: 'Update: "Launch"', summary: "Two lines\nand a colon: yes", date: "2026-11-03", publishDate: null, tags: ["area: launch", "#game"], project: "My Game", slug: "launch", body: "# Work\n\n{{title}} is literal in the body value.\n![View](images/view.png)", cover: "images/view.png" };
  const result = formatArticleTemplate(ARTICLE_TEMPLATE, values);
  assert.ok(result.endsWith(values.body as string + "\n"));
  const front = result.split("---\n")[1];
  const encoded = Object.fromEntries(front.trim().split("\n").map((line) => { const colon = line.indexOf(":"); return [line.slice(0, colon), JSON.parse(line.slice(colon + 1).trim())]; }));
  assert.deepEqual(encoded, { title: values.title, date: null, tags: values.tags, summary: values.summary, cover: values.cover });
  assert.ok(formatArticleTemplate('---\ntitle: "{{title}}"\n---\n{{body}}', values).includes(`title: ${JSON.stringify(values.title)}`));
  assert.throws(() => formatArticleTemplate("{{missing}}", values), /Unknown article template value/);
  assert.equal(articleOutput.available, true);
});

test("video outputs advance independently and the post reports the earliest stage", () => {
  const post = { outputs: ["portrait", "landscape"], outputStages: {}, stage: "questions" } as Post;
  setOutputStage(post, "portrait", "final");
  assert.equal(outputStage(post, "portrait"), "final");
  assert.equal(outputStage(post, "landscape"), "questions");
  assert.equal(post.stage, "questions");
  setOutputStage(post, "landscape", "preview");
  assert.equal(post.stage, "preview");
});

test("a segment belongs only to the video outputs whose script has it", () => {
  const script = (...ids: string[]) => ({ segments: ids.map((id) => ({ id })) });
  const post = { outputs: ["portrait", "landscape", "article"], scripts: { portrait: script("a", "b") } } as unknown as Post;
  assert.deepEqual(outputsWithSegment(post, "a"), ["portrait"], "an output without a script is skipped");
  post.scripts.landscape = script("a") as unknown as Post["scripts"]["landscape"];
  assert.deepEqual(outputsWithSegment(post, "a"), ["portrait", "landscape"]);
  assert.deepEqual(outputsWithSegment(post, "b"), ["portrait"]);
  assert.deepEqual(outputsWithSegment(post, "missing"), []);
});

test("export folders separate identical titles and preserve legacy paths", () => {
  const post = { id: "post-first", title: "Weekly update", publishDate: "2026-11-03", outputDirs: [] } as unknown as Post;
  const first = outputFolder("one", post, "2026-11-03");
  assert.notEqual(first, outputFolder("two", { ...post, id: "post-second" }, "2026-11-03"));
  assert.notEqual(first, outputFolder("one", { ...post, id: "post-third" }, "2026-11-03"));
  assert.equal(outputFolder("renamed", { ...post, title: "New title", outputDirs: [first, "legacy-second-folder"] }, "2026-11-04"), first);
});
