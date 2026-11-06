import type { Segment, Turn } from "./types.js";

/**
 * The spoken lines of a segment, in order. A solo segment has one developer line whose ID is the segment ID.
 * All audio, timing and word-count code reads speech through this function.
 */
export function spokenTurns(segment: Pick<Segment, "id" | "narration" | "turns">): Turn[] {
  if (segment.turns) return segment.turns.filter((t) => t.text.trim());
  return segment.narration.trim() ? [{ id: segment.id, speaker: "developer", text: segment.narration }] : [];
}
