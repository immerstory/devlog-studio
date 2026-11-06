/** Address of a picture in a preview's Markdown, resolved when the picture is drawn. */
export const PREVIEW_IMAGE = "devlog-image:";
/** Address of the video embed in a preview's Markdown. */
export const PREVIEW_VIDEO = "devlog-video:embed";

/**
 * Turns an article body into plain Markdown for showing: pictures and the video embed become image syntax, and the
 * video's link becomes its address. It writes the same picture syntax as the export, so the preview matches the file.
 */
export function previewMarkdown(body: string, values: { alt: (id: string) => string; youtubeUrl?: string }): string {
  return body
    .replace(/\{\{image:([^}]+)\}\}/g, (_, id: string) => `![${values.alt(id).replace(/[\[\]]/g, "")}](${PREVIEW_IMAGE}${encodeURIComponent(id)})`)
    .replace(/\{\{youtube\.embed\}\}/g, `![](${PREVIEW_VIDEO})`)
    .replace(/\{\{youtube\.url\}\}/g, values.youtubeUrl ?? "(the video's link appears here once it's uploaded)");
}
