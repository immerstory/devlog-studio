import fs from "node:fs";
import { spawn } from "node:child_process";
/** Encodes a PNG sequence to an H.264 clip. */
export function encodeSequence(pattern: string, fps: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", pattern, "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", out],
      { windowsHide: true },
    );
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err}`))));
  });
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}
