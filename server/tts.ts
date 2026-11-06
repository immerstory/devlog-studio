import { elevenLabsKey } from "./config.js";
import { exists, getBuffer, putBuffer } from "./storage.js";
import { throwIfCancelled } from "./jobs.js";
import { projectVoices, takeHash, voiceSettings, type ResolvedVoice, type VoiceOf } from "./takes.js";
import { spokenTurns } from "../shared/turns.js";
import type { NarrationTake, Segment, Speaker } from "../shared/types.js";

const API = "https://api.elevenlabs.io/v1";
/** Narration takes live in Garage under tts/<hash>.mp3 with word timings in tts/<hash>.json. */
const takeKey = (hash: string, ext: "mp3" | "json") => `tts/${hash}.${ext}`;

function key(): string {
  const k = elevenLabsKey();
  if (!k) throw new Error("Set the ElevenLabs API key in Settings first.");
  return k;
}

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${url}`, {
    ...init,
    headers: { "xi-api-key": key(), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}

/** Looks up one voice by id, including Voice Library voices not in the account list. */
export async function getVoice(id: string) {
  const v = await api<{ voice_id: string; name: string; category: string }>(`/voices/${encodeURIComponent(id)}`);
  return { id: v.voice_id, name: v.name, category: v.category };
}

export async function listVoices() {
  const r = await api<{ voices: Array<{ voice_id: string; name: string; category: string }> }>("/voices");
  return r.voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category }));
}

export async function subscription() {
  const s = await api<{ character_count: number; character_limit: number; next_character_count_reset_unix: number }>("/user/subscription");
  return { used: s.character_count, limit: s.character_limit, resetsAt: new Date(s.next_character_count_reset_unix * 1000).toISOString() };
}

/** Characters that would be billed, per speaker: spoken lines with no cached take. */
export async function billableCharacters(segments: Segment[], voices: VoiceOf = projectVoices()): Promise<{ total: number; bySpeaker: Record<Speaker, number> }> {
  const bySpeaker: Record<Speaker, number> = { developer: 0, coHost: 0 };
  for (const turn of segments.flatMap(spokenTurns)) {
    const voice = voices(turn.speaker);
    if (voice && (await exists(takeKey(takeHash(voice, turn.text), "json")))) continue;
    bySpeaker[turn.speaker] += turn.text.trim().length;
  }
  return { total: bySpeaker.developer + bySpeaker.coHost, bySpeaker };
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

export function wordsFromAlignment(a: Alignment): NarrationTake["words"] {
  const words: NarrationTake["words"] = [];
  let cur = "";
  let start = 0;
  let end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) words.push({ text: cur, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
      cur = "";
      return;
    }
    if (!cur) start = a.character_start_times_seconds[i];
    cur += ch;
    end = a.character_end_times_seconds[i];
  });
  if (cur) words.push({ text: cur, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
  return words;
}

/**
 * Models served through the Text to Dialogue API (eleven_v3, eleven_v4 and their variants), per the
 * ElevenLabs models overview. Other models use Text to Speech. Both return character timings.
 */
export const usesDialogueApi = (modelId: string) => /^eleven_v[34](_|$)/.test(modelId);

const clip = (text: string | undefined, max: number, fromEnd: boolean) => (text ? (fromEnd ? text.slice(-max) : text.slice(0, max)) : undefined);

/** One spoken line with character timings, through the endpoint the voice's model needs. */
async function synthesize(e: ResolvedVoice, text: string, previous?: string, next?: string): Promise<{ audio_base64: string; alignment: Alignment }> {
  if (usesDialogueApi(e.modelId)) {
    // Single-voice dialogue: one input. Context fields accept at most 100 characters each.
    const r = await api<{ audio_base64: string; alignment?: Alignment | null; normalized_alignment?: Alignment | null }>(`/text-to-dialogue/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      body: JSON.stringify({
        inputs: [{ text, voice_id: e.voiceId }],
        model_id: e.modelId,
        settings: { stability: e.stability, similarity: e.similarityBoost },
        previous_text: clip(previous, 100, true),
        future_text: clip(next, 100, false),
      }),
    });
    const alignment = r.alignment ?? r.normalized_alignment;
    if (!alignment) throw new Error(`ElevenLabs returned no timing data for ${e.modelId}`);
    return { audio_base64: r.audio_base64, alignment };
  }
  return api<{ audio_base64: string; alignment: Alignment }>(`/text-to-speech/${e.voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    body: JSON.stringify({ text, model_id: e.modelId, voice_settings: voiceSettings(e), previous_text: previous || undefined, next_text: next || undefined }),
  });
}

/**
 * Generates (or reuses) one take per spoken line. Lines in `force`, by turn ID (a solo line's ID is its
 * segment's), get a fresh take even when their text is cached; the new take replaces the cached one for
 * that text and voice.
 */
export async function narrate(segments: Segment[], log: (l: string) => void, force: Set<string> = new Set()): Promise<NarrationTake[]> {
  const voices = projectVoices();
  if (!voices("developer")?.voiceId) throw new Error("Choose an ElevenLabs voice in Settings first.");
  const spoken = segments.flatMap((seg) => spokenTurns(seg).map((turn) => {
    const voice = voices(turn.speaker);
    if (!voice) throw new Error("Set the co-host's voice in the project settings first.");
    return { seg, turn, voice };
  }));
  const takes: NarrationTake[] = [];
  for (let i = 0; i < spoken.length; i++) {
    throwIfCancelled();
    const { seg, turn, voice } = spoken[i];
    const text = turn.text.trim();
    const hash = takeHash(voice, text);
    const audio = takeKey(hash, "mp3");
    const meta = takeKey(hash, "json");
    let timing: Pick<NarrationTake, "words" | "durationMs" | "generatedAt">;
    if (force.has(turn.id) || !(await exists(meta))) {
      log(`ElevenLabs: line ${i + 1}/${spoken.length} (${text.length} chars)`);
      const r = await synthesize(voice, text, spoken[i - 1]?.turn.text.trim(), spoken[i + 1]?.turn.text.trim());
      timing = { words: wordsFromAlignment(r.alignment), durationMs: Math.round((r.alignment.character_end_times_seconds.at(-1) ?? 0) * 1000), generatedAt: Date.now() };
      await putBuffer(audio, Buffer.from(r.audio_base64, "base64"));
      await putBuffer(meta, JSON.stringify(timing));
    } else {
      log(`ElevenLabs: line ${i + 1}/${spoken.length} cached`);
      timing = JSON.parse((await getBuffer(meta)).toString("utf8"));
    }
    takes.push({ segmentId: seg.id, ...(seg.turns ? { turnId: turn.id, speaker: turn.speaker } : {}), file: audio, durationMs: timing.durationMs, words: timing.words, hash, generatedAt: timing.generatedAt });
  }
  return takes;
}
