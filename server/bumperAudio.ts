import { projectId } from "./context.js";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CACHE_DIR, config, saveConfig } from "./config.js";
import { deletePrefix, putFile } from "./storage.js";
import { bumperSeconds, type BumperAudio, type BumperPlacement } from "../shared/bumpers.js";

const run = promisify(execFile);
const audioKey = (placement: BumperPlacement) => `projects/${projectId()}/theme/${placement}-audio.wav`;

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { windowsHide: true });
  return Number(stdout.trim()) || 0;
}

/** End of the leading silence in seconds; 0 when the file starts with sound. */
async function leadingSilence(file: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-60dB:d=0.5", "-f", "null", "-"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const start = /silence_start: (-?[\d.]+)/.exec(stderr);
  const end = /silence_end: ([\d.]+)/.exec(stderr);
  return start && Number(start[1]) <= 0.05 && end ? Number(end[1]) : 0;
}

/**
 * Imports music for a bumper; the leading silence is cut.
 * Intro music starts with the video. Outro music is scored against a full video: the track ends with
 * the video, so whatever plays before the outro's start becomes a lead-in.
 */
export async function importBumperAudio(placement: BumperPlacement, file: string, sourceName: string): Promise<BumperAudio> {
  const choice = config().theme[placement];
  if (!choice) throw Object.assign(new Error(`Choose an ${placement} style before adding music.`), { status: 400 });
  const silence = await leadingSilence(file);
  const dir = path.join(CACHE_DIR, "bumper-audio", projectId());
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${placement}-audio.wav`);
  // A few milliseconds of margin keep the attack of the first note.
  const cut = Math.max(0, silence - 0.01);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", cut.toFixed(3), "-i", file, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", out], { windowsHide: true });
  const durationSeconds = await probeDuration(out);
  if (durationSeconds < 0.5) throw Object.assign(new Error("The track contains no audible music after its silence."), { status: 400 });
  const leadSeconds = placement === "outro" ? Math.max(0, durationSeconds - bumperSeconds(choice)) : 0;
  const audio: BumperAudio = { key: audioKey(placement), sourceName, durationSeconds, leadSeconds };
  await putFile(audio.key, out, "audio/wav");
  fs.rmSync(out, { force: true });
  const c = config();
  await saveConfig({ ...c, theme: { ...c.theme, [placement]: { ...c.theme[placement]!, audio } } });
  return audio;
}

export async function removeBumperAudio(placement: BumperPlacement) {
  const c = config();
  const choice = c.theme[placement];
  if (!choice?.audio) return;
  if (choice.audio.key.startsWith(`projects/${projectId()}/`)) await deletePrefix(choice.audio.key);
  const { audio: _removed, ...rest } = choice;
  await saveConfig({ ...c, theme: { ...c.theme, [placement]: rest } });
}
