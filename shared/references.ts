import type { Post, Script } from "./types.js";

export type CaptureTargetBase = Record<string, string | null>;
export function scriptCaptureTargets(script?: Script): CaptureTargetBase {
  return Object.fromEntries((script?.segments ?? []).filter((s) => s.visual.type === "capture").map((s) => [s.id, s.visual.type === "capture" ? s.visual.targetId ?? null : null]));
}

/** Keep concurrent target changes when the editor has not changed that field. */
export function mergeCaptureTargets(previous: Script | undefined, next: Script, base?: CaptureTargetBase) {
  for (const segment of next.segments) {
    if (segment.visual.type !== "capture") continue;
    const saved = previous?.segments.find((s) => s.id === segment.id)?.visual;
    if (saved?.type !== "capture") continue;
    const unchanged = base && Object.hasOwn(base, segment.id)
      ? (segment.visual.targetId ?? null) === base[segment.id]
      : !segment.visual.targetId;
    if (unchanged) segment.visual.targetId = saved.targetId;
  }
}

export function pinDefaultCaptureTarget(post: Post, targetId: string): boolean {
  let changed = false;
  for (const script of Object.values(post.scripts)) for (const segment of script?.segments ?? []) {
    if (segment.visual.type === "capture" && !segment.visual.targetId) {
      segment.visual.targetId = targetId;
      changed = true;
    }
  }
  return changed;
}

/** A slide can only reference segments in its own script. */
export function pruneSegmentReferences(script: Script, previousIds: Iterable<string> = []) {
  const current = new Set(script.segments.map((s) => s.id));
  const previous = new Set(previousIds);
  for (const segment of script.segments) if (segment.visual.type === "slide") {
    const visual = segment.visual;
    visual.imageFrom = visual.imageFrom?.filter((id) => current.has(id) || (!previous.has(id) && !id.startsWith("seg-")));
    if (visual.captions) for (const id of Object.keys(visual.captions)) if (!visual.imageFrom?.includes(id)) delete visual.captions[id];
  }
}

export function detachMaterial(post: Post, materialId: string) {
  post.materialIds = (post.materialIds ?? []).filter((id) => id !== materialId);
  for (const script of Object.values(post.scripts)) for (const segment of script?.segments ?? []) {
    const visual = segment.visual;
    if (visual.type === "material" && visual.materialId === materialId) visual.materialId = undefined;
    if (visual.type === "slide") {
      visual.imageFrom = visual.imageFrom?.filter((id) => id !== materialId);
      if (visual.captions) delete visual.captions[materialId];
    }
  }
}
