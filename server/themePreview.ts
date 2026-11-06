import { config, type StudioConfig } from "./config.js";
import { projectId } from "./context.js";
import { getProject } from "./projects.js";
import { getMaterials, listMaterials } from "./store.js";
import { buildTimeline } from "./timeline.js";
import { themeColors, type Format, type Post, type Segment, type TimelineProps } from "../shared/types.js";

/**
 * A short sample video for unsaved theme settings: the intro, a title, bullets, a polaroid stack and the
 * ending with the outro. Nothing is stored. Stack pictures are the slide backgrounds, or the
 * newest image materials when the theme has none.
 */
export async function themePreview(draft: Partial<StudioConfig["theme"]>, format: Format): Promise<TimelineProps> {
  const saved = config().theme;
  const theme: StudioConfig["theme"] = {
    ...saved,
    ...draft,
    colors: themeColors(draft.colors),
    backgroundMaterialIds: Array.isArray(draft.backgroundMaterialIds) ? draft.backgroundMaterialIds : saved.backgroundMaterialIds,
    // Unset in the draft means no bumper; the music stays as saved.
    intro: draft.intro ? { ...draft.intro, audio: saved.intro?.audio } : undefined,
    outro: draft.outro ? { ...draft.outro, audio: saved.outro?.audio } : undefined,
  };
  const backgrounds = (await getMaterials(projectId(), theme.backgroundMaterialIds)).filter((m) => m.kind === "image");
  const pictures = (backgrounds.length ? backgrounds : (await listMaterials(projectId())).filter((m) => m.kind === "image")).slice(0, 3);
  const title = config().gameTitle || getProject().settings.name;
  const segments: Segment[] = [
    { id: "preview-title", narration: "This is how a title slide looks.", visual: { type: "slide", layout: "title", heading: title } },
    { id: "preview-bullets", narration: "Bullet points use the text and accent colours.", visual: { type: "slide", layout: "bullets", heading: "What changed", bullets: ["New slide colours", "Your font for headings and bullets", "Photo frames in the stack"] } },
    ...(pictures.length
      ? [{ id: "preview-stack", narration: "Pictures pile up as polaroids.", visual: { type: "slide" as const, layout: "stack" as const, heading: "Screenshots", imageFrom: pictures.map((m) => m.id), titleCaptions: true } }]
      : []),
    { id: "preview-end", narration: "And this is how the video ends.", visual: { type: "slide", layout: "title", heading: "Thanks for watching" } },
  ];
  const post = {
    id: "theme-preview",
    scripts: { [format]: { format, title, segments, metadata: { title, description: "", tags: [] } } },
    narration: {},
  } as unknown as Post;
  return buildTimeline(post, format, false, theme);
}
