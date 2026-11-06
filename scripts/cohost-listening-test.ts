/**
 * Generates a two-voice dialogue line by line, to judge how a co-host sounds and what it costs.
 *
 *   tsx scripts/cohost-listening-test.ts <dialogue.json> [--regenerate <turnId>]
 *
 * The dialogue file holds { projectId, coHostVoiceId, turns: [{ id, speaker: "developer" | "coHost", text }] }.
 * Takes, the mixed dialogue and a cost report land next to it. A run bills only turns without a matching take,
 * plus the turn named by --regenerate. It writes nothing to the database or to Garage.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const { loadConfig, elevenLabsKey } = await import("../server/config.js");
const { loadProjects, getProject } = await import("../server/projects.js");
const { usesDialogueApi } = await import("../server/tts.js");

const API = "https://api.elevenlabs.io/v1";
const GAP_SAME_SPEAKER_MS = 150;
const GAP_NEW_SPEAKER_MS = 300;
const CONTEXT_CHARS = 100;

interface Turn { id: string; speaker: "developer" | "coHost"; text: string }
interface Dialogue { projectId: string; coHostVoiceId: string; turns: Turn[] }

const [file, flag, regenerate] = process.argv.slice(2);
if (!file || (flag && (flag !== "--regenerate" || !regenerate))) throw new Error("Usage: cohost-listening-test.ts <dialogue.json> [--regenerate <turnId>]");
const dir = path.dirname(path.resolve(file));
const dialogue = JSON.parse(fs.readFileSync(file, "utf8")) as Dialogue;
if (regenerate && !dialogue.turns.some((t) => t.id === regenerate)) throw new Error(`No turn with the ID ${regenerate}`);

await loadConfig();
await loadProjects();
const narration = getProject(dialogue.projectId).settings.narration;
if (!usesDialogueApi(narration.modelId)) throw new Error(`This test supports Text to Dialogue models, and the project uses ${narration.modelId}`);
if (dialogue.coHostVoiceId === narration.voiceId) throw new Error("The co-host voice must differ from the narrator's voice");
const key = elevenLabsKey();
if (!key) throw new Error("Set the ElevenLabs API key in Settings first.");

const voiceOf = (t: Turn) => (t.speaker === "coHost" ? dialogue.coHostVoiceId : narration.voiceId);
const settings = { stability: narration.stability, similarity: narration.similarityBoost };
const takePath = (t: Turn) => path.join(dir, `${t.id}.mp3`);
const hashOf = (t: Turn) => crypto.createHash("sha256").update(JSON.stringify([voiceOf(t), narration.modelId, settings, t.text.trim()])).digest("hex").slice(0, 24);
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12);

async function charactersUsed(): Promise<number | undefined> {
  const res = await fetch(`${API}/user/subscription`, { headers: { "xi-api-key": key! } });
  return res.ok ? ((await res.json()) as { character_count: number }).character_count : undefined;
}

async function synthesize(t: Turn, previous?: string, next?: string) {
  const res = await fetch(`${API}/text-to-dialogue/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key!, "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: [{ text: t.text.trim(), voice_id: voiceOf(t) }], model_id: narration.modelId, settings, previous_text: previous?.slice(-CONTEXT_CHARS), future_text: next?.slice(0, CONTEXT_CHARS) }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status} on ${t.id}: ${(await res.text()).slice(0, 500)}`);
  const body = (await res.json()) as { audio_base64: string; alignment?: { character_end_times_seconds: number[] }; normalized_alignment?: { character_end_times_seconds: number[] } };
  const ends = (body.alignment ?? body.normalized_alignment)?.character_end_times_seconds;
  const cost = res.headers.get("character-cost") ?? res.headers.get("x-character-count");
  return { audio: Buffer.from(body.audio_base64, "base64"), durationMs: Math.round((ends?.at(-1) ?? 0) * 1000), cost: cost === null ? undefined : Number(cost) };
}

const reportPath = path.join(dir, "report.json");
type TakeRecord = { hash: string; durationMs: number; sha: string };
const report: { takes: Record<string, TakeRecord>; runs: unknown[] } = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : { takes: {}, runs: [] };
const before = await charactersUsed();
const shasBefore = Object.fromEntries(dialogue.turns.filter((t) => fs.existsSync(takePath(t))).map((t) => [t.id, sha(takePath(t))]));
const billed: Array<{ id: string; characters: number; reportedCost?: number }> = [];

for (const [i, t] of dialogue.turns.entries()) {
  const current = report.takes[t.id]?.hash === hashOf(t) && fs.existsSync(takePath(t));
  if (current && t.id !== regenerate) continue;
  console.log(`Generating ${t.id} (${t.speaker}, ${t.text.trim().length} characters)`);
  const r = await synthesize(t, dialogue.turns[i - 1]?.text, dialogue.turns[i + 1]?.text);
  fs.writeFileSync(takePath(t), r.audio);
  report.takes[t.id] = { hash: hashOf(t), durationMs: r.durationMs, sha: sha(takePath(t)) };
  billed.push({ id: t.id, characters: t.text.trim().length, reportedCost: r.cost });
}

// One filter chain per turn: resample, then append the gap that follows the turn.
const inputs = dialogue.turns.flatMap((t) => ["-i", takePath(t)]);
const chains = dialogue.turns.map((t, i) => {
  const following = dialogue.turns[i + 1];
  const gap = !following ? 0 : following.speaker === t.speaker ? GAP_SAME_SPEAKER_MS : GAP_NEW_SPEAKER_MS;
  return `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,apad=pad_dur=${gap / 1000}[a${i}]`;
});
const labels = dialogue.turns.map((_, i) => `[a${i}]`).join("");
const mix = path.join(dir, "dialogue.mp3");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", `${chains.join(";")};${labels}concat=n=${dialogue.turns.length}:v=0:a=1[out]`, "-map", "[out]", "-b:a", "128k", mix], { stdio: "inherit" });
const durationSeconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mix]).toString());

const after = await charactersUsed();
const changed = dialogue.turns.filter((t) => shasBefore[t.id] && shasBefore[t.id] !== sha(takePath(t))).map((t) => t.id);
const characters = (speaker: Turn["speaker"]) => dialogue.turns.filter((t) => t.speaker === speaker).reduce((n, t) => n + t.text.trim().length, 0);
const run = {
  regenerate,
  billed,
  billedCharacters: billed.reduce((n, b) => n + b.characters, 0),
  accountCharactersUsed: before !== undefined && after !== undefined ? after - before : undefined,
  existingTakesChanged: changed,
  durationSeconds,
  charactersBySpeaker: { developer: characters("developer"), coHost: characters("coHost") },
  charactersPerMinute: Math.round(((characters("developer") + characters("coHost")) / durationSeconds) * 60),
  model: narration.modelId,
  settings,
};
report.runs.push(run);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(run, null, 2));
console.log(`Dialogue: ${mix}`);
process.exit(0);
