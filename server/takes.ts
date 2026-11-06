import crypto from "node:crypto";
import { config } from "./config.js";
import { getProject } from "./projects.js";
import type { NarrationTake, Segment, Speaker } from "../shared/types.js";

/** Everything that changes how a line sounds. */
export interface ResolvedVoice {
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}
/** No voice means the project has no co-host. */
export type VoiceOf = (speaker: Speaker) => ResolvedVoice | undefined;

/** Voices of the project in the current context. Co-host values that aren't set use the narrator's. */
export function projectVoices(): VoiceOf {
  const { voiceId, modelId, stability, similarityBoost, style, speed } = config().elevenlabs;
  const developer: ResolvedVoice = { voiceId, modelId, stability, similarityBoost, style, speed };
  const coHost = getProject().settings.coHost;
  return (speaker) => (speaker === "developer" ? developer : coHost && { ...developer, ...coHost.voice, voiceId: coHost.voiceId });
}

export const voiceSettings = (v: ResolvedVoice) => ({ stability: v.stability, similarity_boost: v.similarityBoost, style: v.style, use_speaker_boost: true, speed: v.speed });

/** Cache key: neighbouring text (previous/next) only steers prosody, so it does not invalidate takes. */
export function takeHash(voice: ResolvedVoice, text: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([voice.voiceId, voice.modelId, voiceSettings(voice), text.trim()])).digest("hex").slice(0, 24);
}

/**
 * The takes that still match the script. A turn's take needs its turn, with the same text and resolved voice,
 * and follows the turn to another segment. Solo takes have no turn and pass through.
 */
export function usableTakes(takes: NarrationTake[], segments: Segment[], voiceOf: VoiceOf): NarrationTake[] {
  const located = new Map(segments.flatMap((s) => (s.turns ?? []).map((turn) => [turn.id, { segmentId: s.id, turn }] as const)));
  return takes.flatMap((take) => {
    if (!take.turnId) return [take];
    const found = located.get(take.turnId);
    const voice = found && voiceOf(found.turn.speaker);
    if (!found || !voice || take.hash !== takeHash(voice, found.turn.text)) return [];
    return [{ ...take, segmentId: found.segmentId, speaker: found.turn.speaker }];
  });
}
