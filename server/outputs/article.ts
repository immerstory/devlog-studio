import type { ArticleDraft } from "../../shared/outputs.js";
import type { OutputDefinition } from "./provider.js";

const unavailable = (): never => { throw Object.assign(new Error("Article writing and export are not available yet"), { status: 400 }); };
export const articleOutput: OutputDefinition<ArticleDraft> = {
  id: "article", label: "Article", available: true, stages: ["draft", "images", "export"],
  writer: { prompt: unavailable, schema: () => ({ type: "object", additionalProperties: false, properties: { title: { type: "string" }, summary: { type: "string" }, tags: { type: "array", items: { type: "string" } }, body: { type: "string" } }, required: ["title", "summary", "tags", "body"] }), normalize: unavailable },
  export: unavailable,
};

export type ArticleValues = Record<"title" | "summary" | "date" | "publishDate" | "tags" | "project" | "slug" | "body" | "cover", string | string[] | null>;
/** JSON scalars and arrays are valid YAML; body substitution remains literal Markdown. */
export function formatArticleTemplate(template: string, values: ArticleValues): string {
  const token = /{{(\w+)}}/g;
  const get = (name: string) => { if (!(name in values)) throw new Error(`Unknown article template value: ${name}`); return values[name as keyof ArticleValues]; };
  const text = (value: string) => value.replace(token, (_, name: string) => { const v = get(name); return Array.isArray(v) ? v.join(", ") : v ?? ""; });
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(template);
  if (!match) return text(template);
  const front = match[1].split(/\r?\n/).map((line) => {
    const scalar = /^(\s*[^:#\n][^:\n]*:\s*)(.*)$/.exec(line);
    if (scalar && /{{\w+}}/.test(scalar[2])) {
      const value = scalar[2].replace(/^(["'])(.*)\1$/, "$2");
      const exact = /^{{(\w+)}}$/.exec(value);
      return scalar[1] + JSON.stringify(exact ? get(exact[1]) : text(value));
    }
    return line.replace(token, (_, name: string) => JSON.stringify(get(name)));
  }).join("\n");
  return `---\n${front}\n---\n${text(match[2])}`;
}
