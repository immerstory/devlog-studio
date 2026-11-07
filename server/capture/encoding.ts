import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Encodes a PNG sequence to an H.264 clip. With a size, frames are scaled to it: a zoomed screenshot can come out a
 * pixel short, and the encoder needs even dimensions.
 */
export function encodeSequence(pattern: string, fps: number, out: string, size?: { width: number; height: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", pattern, ...(size ? ["-vf", `scale=${size.width}:${size.height}:flags=lanczos`] : []), "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", out],
      { windowsHide: true },
    );
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err}`))));
  });
}

/** Encodes the frames `f_0000.png` onward in `frameDir` to `capture.mp4` with a poster from the middle frame, then deletes the frames. */
export async function finishClip(frameDir: string, dir: string, fps: number, frames: number) {
  const file = path.join(dir, "capture.mp4");
  await encodeSequence(path.join(frameDir, "f_%04d.png"), fps, file);
  const poster = path.join(dir, "capture.jpg");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(frameDir, `f_${String(Math.floor(frames / 2)).padStart(4, "0")}.png`), "-q:v", "2", poster], { windowsHide: true });
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
  fs.rmSync(frameDir, { recursive: true, force: true });
  return { file, poster, durationSeconds: Number(stdout.trim()) || 0 };
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}
