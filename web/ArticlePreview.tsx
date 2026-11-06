import React from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { mediaUrl } from "./api";
import { PREVIEW_IMAGE, PREVIEW_VIDEO, previewMarkdown } from "../shared/article-preview";
import type { ArticleDraft } from "../shared/outputs";

interface Picture { id: string; title: string; key: string }

/** The notes only show in this preview. They name what export would refuse or leave out. */
function PreviewNote({ children }: { children: React.ReactNode }) {
  return <span className="article-preview-note">{children}</span>;
}

/** Shows an article as a reader would, from the current edits, whether or not they are saved. */
export function ArticlePreview({ draft, pictures, youtube }: { draft: ArticleDraft; pictures: Picture[]; youtube?: { id: string; url?: string } }) {
  const altOf = (id: string) => draft.images?.[id]?.alt?.trim() ?? "";
  const picture = (id: string) => pictures.find((p) => p.id === id);
  const figure = (id: string) => {
    const found = picture(id);
    if (!found) return <PreviewNote>This picture no longer exists: {id}</PreviewNote>;
    return (
      <span className="article-preview-figure">
        <img src={mediaUrl(found.key)} alt={altOf(id)} />
        {altOf(id) ? null : <PreviewNote>This picture needs alt text before export.</PreviewNote>}
      </span>
    );
  };
  const components: Components = {
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => {
      if (src === PREVIEW_VIDEO) {
        return youtube
          ? <iframe className="article-preview-video" src={`https://www.youtube-nocookie.com/embed/${youtube.id}`} title={draft.title} allowFullScreen loading="lazy" />
          : <PreviewNote>The video appears here once it's uploaded.</PreviewNote>;
      }
      if (src?.startsWith(PREVIEW_IMAGE)) return figure(decodeURIComponent(src.slice(PREVIEW_IMAGE.length)));
      return <img src={src} alt={alt} />;
    },
  };
  const markdown = previewMarkdown(draft.body, { alt: altOf, youtubeUrl: youtube?.url });
  return (
    <article className="article-preview">
      {draft.coverId ? <div className="article-preview-cover">{figure(draft.coverId)}</div> : null}
      <h1>{draft.title}</h1>
      {draft.summary ? <p className="article-preview-summary">{draft.summary}</p> : null}
      {draft.tags.length ? <p className="article-preview-tags">{draft.tags.map((t) => `#${t}`).join(" ")}</p> : null}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={(url) => (url.startsWith(PREVIEW_IMAGE) || url === PREVIEW_VIDEO ? url : defaultUrlTransform(url))}>{markdown}</ReactMarkdown>
    </article>
  );
}
