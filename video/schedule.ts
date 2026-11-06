import type { TimelineProps, TimelineSegment } from "../shared/types";

/** Frames a segment fades in over the one before it. */
export const FADE_FRAMES = 8;
/** Share of a second between a segment's start, after any intro, and its first narration. */
const SPEECH_LEAD_SECONDS = 0.15;
/** Level of the sound in footage under the narration. */
export const FOOTAGE_VOLUME = 0.25;

/** Frames a segment starts before its `from`, for the fade over the previous one. */
export const segmentLead = (index: number) => (index === 0 ? 0 : FADE_FRAMES);

export interface SegmentWindow {
  segment: TimelineSegment;
  index: number;
  /** First frame the segment is visible. */
  start: number;
  /** First frame after the segment. */
  end: number;
}

export function segmentWindows(t: Pick<TimelineProps, "segments">): SegmentWindow[] {
  return t.segments.map((segment, index) => {
    const start = Math.max(0, segment.from - segmentLead(index));
    return { segment, index, start, end: start + segment.durationInFrames + segmentLead(index) };
  });
}

/** Seconds into a segment's footage at a frame of the segment. Past the end of the file, the last picture stays. */
export function footageSeconds(segment: TimelineSegment, fps: number, localFrame: number): number {
  const media = segment.media;
  return ((media?.trimStartFrames ?? 0) + localFrame * (media?.playbackRate ?? 1)) / fps;
}

/** A sound in the finished video. */
export interface ScheduledAudio {
  src: string;
  /** Seconds into the video at which it starts. */
  at: number;
  /** Seconds into the source at which it starts. */
  offset: number;
  /** Longest it plays, in video seconds; undefined plays to the end of the source. */
  maxSeconds?: number;
  volume: number;
  rate: number;
  /** Footage may have no sound at all. */
  optional?: boolean;
}

/** Every sound of the video. The preview and the export both play this list. */
export function audioSchedule(t: TimelineProps): ScheduledAudio[] {
  const out: ScheduledAudio[] = [];
  const speechLead = Math.round(SPEECH_LEAD_SECONDS * t.fps);
  for (const { segment, start, end } of segmentWindows(t)) {
    const media = segment.media;
    if (media?.kind === "video") {
      out.push({ src: media.src, at: start / t.fps, offset: (media.trimStartFrames ?? 0) / t.fps, maxSeconds: (end - start) / t.fps, volume: FOOTAGE_VOLUME, rate: media.playbackRate ?? 1, optional: true });
    }
    for (const clip of segment.audio ?? []) {
      const from = segment.from + (segment.introFrames ?? 0) + speechLead + clip.startFrame;
      out.push({ src: clip.src, at: from / t.fps, offset: 0, maxSeconds: Math.max(0, end - from) / t.fps, volume: 1, rate: 1 });
    }
  }
  const { intro, outro } = t.theme;
  if (intro?.audioUrl) out.push({ src: intro.audioUrl, at: 0, offset: 0, volume: 1, rate: 1 });
  if (outro?.audioUrl) {
    const from = Math.max(0, t.durationInFrames - outro.durationInFrames - Math.round((outro.audioLeadSeconds ?? 0) * t.fps));
    out.push({ src: outro.audioUrl, at: from / t.fps, offset: 0, volume: 1, rate: 1 });
  }
  return out;
}
