import type { Post } from "../../shared/types.js";

const words = (text: string, stepMs: number) => text.split(" ").map((w, i) => ({ text: w, startMs: i * stepMs, endMs: i * stepMs + stepMs - 40 }));
const take = (segmentId: string, text: string, stepMs: number, generatedAt: number) => {
  const w = words(text, stepMs);
  return { segmentId, file: `tts/${segmentId}.mp3`, durationMs: w.at(-1)!.endMs + 120, words: w, hash: `hash-${segmentId}`, generatedAt };
};
const first = "Drafts became pages, in about a day.";
const second = "Far too many to write alone. So I asked for help, and it mostly worked.";
const third = "Follow along.";

/** A solo post: narrated and silent segments, every visual type, and punctuation that splits caption pages. */
export function soloPost(): Post {
  return {
    id: "ep-solo", title: "Solo", createdAt: "2026-11-04T00:00:00.000Z", suggestionIds: [], materialIds: [], outputs: ["portrait", "landscape"], outputDirs: [], outputStages: {}, brief: "", questions: [], renders: {}, stage: "narrated",
    scripts: Object.fromEntries((["portrait", "landscape"] as const).map((format) => [format, {
      format, title: "Solo", metadata: { title: "Solo", description: "", tags: [] },
      segments: [
        { id: "seg-one", narration: first, visual: { type: "slide", layout: "title", heading: "Opening" } },
        { id: "seg-two", narration: second, onScreen: "Label", visual: { type: "capture", description: "A screen" } },
        { id: "seg-silent", narration: "  ", visual: { type: "slide", layout: "bullets", heading: "Silent", bullets: ["One"] } },
        { id: "seg-three", narration: third, visual: { type: "slide", layout: "title", heading: "End" } },
      ],
    }])) as Post["scripts"],
    narration: Object.fromEntries((["portrait", "landscape"] as const).map((format) => [format, [take("seg-one", first, 310, 11), take("seg-two", second, 280, 22), take("seg-three", third, 400, 33)]])) as Post["narration"],
  };
}
