import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, GlobalFonts, ImageData as CanvasImageData, loadImage, type Canvas } from "@napi-rs/canvas";
import { CancelledError, currentJobSignal } from "./jobs.js";
import { config } from "./config.js";
import { outputSize, VideoFrameRenderer } from "../video/renderer.js";
import { audioSchedule, footageSeconds, segmentWindows, type ScheduledAudio, type SegmentWindow } from "../video/schedule.js";
import type { Picture, Platform } from "../video/platform.js";
import type { TimelineProps } from "../shared/types.js";

const run = promisify(execFile);

/** Longest side of decoded footage. Larger files take memory without adding visible detail. */
const MAX_FOOTAGE_SIDE = 2560;
/** Decoded pictures held ahead of the one being drawn. */
const BUFFERED_PICTURES = 4;

/** Downloads a file the timeline refers to. */
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Reads the picture formats and variants the canvas library rejects. */
async function decodeWithFfmpeg(file: Buffer): Promise<Picture> {
  const stream = await new Promise<Buffer>((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-pix_fmt", "rgba", "-"], { windowsHide: true });
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stdin.on("error", () => {});
    ff.stderr.resume();
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("The picture could not be read."))));
    ff.stdin.end(file);
  });
  const image = await loadImage(stream);
  return { source: image as unknown as CanvasImageSource, width: image.width, height: image.height };
}

export const serverPlatform: Platform = {
  createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement,
  async loadImage(url) {
    const file = await download(url);
    const image = await loadImage(file).catch(() => null);
    if (image) return { source: image as unknown as CanvasImageSource, width: image.width, height: image.height };
    return decodeWithFfmpeg(file);
  },
  async loadFont(url, family) {
    if (!GlobalFonts.register(await download(url), family)) throw new Error(`Could not read the font ${url}`);
  },
  newImageData: (data, w, h) => new CanvasImageData(data as never, w, h) as unknown as ImageData,
};

interface VideoProbe {
  width: number;
  height: number;
  fps: number;
  colorSpace?: string;
  colorRange?: string;
  hasAudio: boolean;
}

async function probeVideo(src: string): Promise<VideoProbe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,color_space,color_range", "-of", "json", src], { windowsHide: true });
  const streams = (JSON.parse(stdout) as { streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string; color_space?: string; color_range?: string }> }).streams;
  const video = streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`No video stream in ${src}`);
  const [n, d] = (video.r_frame_rate ?? "30/1").split("/").map(Number);
  return { width: video.width, height: video.height, fps: n && d ? n / d : 30, colorSpace: video.color_space, colorRange: video.color_range, hasAudio: streams.some((s) => s.codec_type === "audio") };
}

/** Reads one segment's footage front to back as raw pictures. */
class FootageDecoder {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly frameBytes: number;
  private readonly canvas: Canvas;
  private readonly fps: number;
  private readonly start: number;
  private nextIndex = 0;
  private ended = false;
  private hasPicture = false;
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private wake?: () => void;
  readonly picture: Picture;

  constructor(src: string, probe: VideoProbe, start: number) {
    const shrink = Math.min(1, MAX_FOOTAGE_SIDE / Math.max(probe.width, probe.height));
    const width = Math.round(probe.width * shrink);
    const height = Math.round(probe.height * shrink);
    this.frameBytes = width * height * 4;
    this.fps = probe.fps;
    this.start = start;
    // Untagged HD footage is BT.709, as browsers assume; the decoder's default would shift its colours.
    const matrix = probe.colorSpace && probe.colorSpace !== "unknown" ? probe.colorSpace : Math.min(width, height) >= 576 ? "bt709" : "smpte170m";
    const range = probe.colorRange === "pc" ? "full" : "limited";
    this.process = spawn("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", start.toFixed(3), "-i", src, "-an", "-vf", `fps=${probe.fps},scale=${width}:${height}:in_color_matrix=${matrix}:in_range=${range}:flags=bicubic,format=rgba`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { windowsHide: true });
    this.process.stderr.resume();
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.stdout.on("close", () => { this.ended = true; this.wake?.(); });
    this.canvas = createCanvas(width, height) as Canvas;
    this.picture = { source: this.canvas as unknown as CanvasImageSource, width, height };
  }

  private onData(chunk: Buffer) {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes >= this.frameBytes * BUFFERED_PICTURES) this.process.stdout.pause();
    this.wake?.();
  }

  /** The next raw picture, or undefined after the last one. */
  private async read(): Promise<Buffer | undefined> {
    const out = this.process.stdout;
    while (this.pendingBytes < this.frameBytes) {
      if (this.ended) return undefined;
      out.resume();
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
    const frame = Buffer.allocUnsafe(this.frameBytes);
    let filled = 0;
    while (filled < this.frameBytes) {
      const chunk = this.pending[0];
      const used = chunk.copy(frame, filled);
      filled += used;
      if (used === chunk.length) this.pending.shift();
      else this.pending[0] = chunk.subarray(used);
    }
    this.pendingBytes -= this.frameBytes;
    return frame;
  }

  /** Moves to the picture on screen at `seconds` into the file, as a video element shows it. After the last picture, that one stays. */
  async seek(seconds: number): Promise<void> {
    const target = Math.max(0, Math.floor((seconds - this.start) * this.fps + 1e-6));
    let last: Buffer | undefined;
    while (this.nextIndex <= target) {
      const raw = await this.read();
      if (!raw) break;
      last = raw;
      this.nextIndex++;
    }
    if (last) {
      const { width, height } = this.canvas;
      this.canvas.getContext("2d").putImageData(new CanvasImageData(new Uint8ClampedArray(last.buffer, last.byteOffset, last.length) as never, width, height), 0, 0);
      this.hasPicture = true;
    }
  }

  get ready() {
    return this.hasPicture;
  }

  close() {
    this.process.stdout.destroy();
    this.process.kill();
  }
}

/** Pictures of the segments on screen at the current frame, decoding only those. */
class FootagePlayer {
  private readonly probes = new Map<string, VideoProbe>();
  private readonly open = new Map<string, FootageDecoder>();
  private readonly windows: SegmentWindow[];
  private readonly fps: number;

  constructor(t: TimelineProps) {
    this.windows = segmentWindows(t).filter((w) => w.segment.media?.kind === "video");
    this.fps = t.fps;
  }

  async prepare() {
    await Promise.all([...new Set(this.windows.map((w) => w.segment.media!.src))].map(async (src) => this.probes.set(src, await probeVideo(src))));
  }

  hasAudio = (src: string) => this.probes.get(src)?.hasAudio ?? false;

  /** Brings every visible segment's footage to this frame and closes the ones that have ended. */
  async advance(frame: number) {
    for (const w of this.windows) {
      const id = w.segment.id;
      if (frame < w.start || frame >= w.end) {
        this.open.get(id)?.close();
        this.open.delete(id);
        continue;
      }
      let decoder = this.open.get(id);
      const seconds = footageSeconds(w.segment, this.fps, frame - w.start);
      if (!decoder) {
        decoder = new FootageDecoder(w.segment.media!.src, this.probes.get(w.segment.media!.src)!, seconds);
        this.open.set(id, decoder);
      }
      await decoder.seek(seconds);
    }
  }

  frame = (segmentId: string): Picture | null => {
    const decoder = this.open.get(segmentId);
    return decoder?.ready ? decoder.picture : null;
  };

  close() {
    for (const decoder of this.open.values()) decoder.close();
    this.open.clear();
  }
}

function ffmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { windowsHide: true });
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg failed: ${err.slice(-2000)}`))));
  });
}

/** Tempo filters for a playback rate; one atempo step covers 0.5 to 2. */
const tempo = (rate: number) => (rate === 1 ? [] : [`atempo=${Math.min(2, Math.max(0.5, rate)).toFixed(4)}`]);

/** Filter graph that lays each sound at its place in the video. */
export function audioMixArgs(sounds: ScheduledAudio[], seconds: number): { inputs: string[]; filter: string } | null {
  if (!sounds.length) return null;
  const parts = sounds.map((s, i) => {
    const steps = [
      ...(s.offset > 0 ? [`atrim=start=${s.offset.toFixed(3)}`, "asetpts=PTS-STARTPTS"] : []),
      ...tempo(s.rate),
      ...(s.maxSeconds !== undefined ? [`atrim=end=${s.maxSeconds.toFixed(3)}`] : []),
      ...(s.volume !== 1 ? [`volume=${s.volume}`] : []),
      "aresample=48000",
      "aformat=channel_layouts=stereo",
      `adelay=${Math.round(s.at * 1000)}:all=1`,
    ];
    return `[${i}:a]${steps.join(",")}[a${i}]`;
  });
  const labels = sounds.map((_, i) => `[a${i}]`).join("");
  return {
    inputs: sounds.flatMap((s) => ["-i", s.src]),
    filter: `${parts.join(";")};${labels}amix=inputs=${sounds.length}:normalize=0:dropout_transition=0,apad,atrim=end=${seconds.toFixed(3)}[mix]`,
  };
}

async function mixAudio(t: TimelineProps, footage: FootagePlayer, videoFile: string, out: string) {
  const seconds = t.durationInFrames / t.fps;
  const sounds = audioSchedule(t).filter((s) => !s.optional || footage.hasAudio(s.src));
  const mix = audioMixArgs(sounds, seconds);
  const inputs = mix?.inputs ?? [];
  const silence = ["-f", "lavfi", "-t", seconds.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
  await ffmpeg([
    "-y", "-loglevel", "error", ...inputs, ...(mix ? [] : silence), "-i", videoFile,
    ...(mix ? ["-filter_complex", mix.filter, "-map", "[mix]"] : ["-map", "0:a"]),
    "-map", `${mix ? sounds.length : 1}:v`, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
  ]);
}

/** Draws every frame and writes the finished MP4. Final renders end at the loudness platforms expect. */
export async function renderVideo(props: TimelineProps, out: string, quality: "draft" | "final", log: (l: string) => void): Promise<void> {
  const signal = currentJobSignal();
  if (signal?.aborted) throw new CancelledError();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const scale = quality === "draft" ? config().render.draftScale : 1;
  const size = outputSize(props, scale);
  const footage = new FootagePlayer(props);
  const silentVideo = out.replace(/\.mp4$/, ".video.mp4");
  const mixed = out.replace(/\.mp4$/, ".raw.mp4");
  let encoder: ChildProcessWithoutNullStreams | undefined;
  const stop = () => encoder?.kill();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    log("Loading pictures and fonts…");
    await footage.prepare();
    const renderer = await VideoFrameRenderer.create(props, serverPlatform, footage.frame, { scale });
    const canvas = createCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    const encoderArgs = [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${size.width}x${size.height}`, "-framerate", String(props.fps), "-i", "-",
      // BT.709 limited range is what YouTube, Instagram and TikTok expect.
      "-vf", "scale=out_color_matrix=bt709:out_range=limited:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-c:v", "libx264", "-preset", quality === "draft" ? "veryfast" : "slow", "-crf", quality === "draft" ? "28" : "17",
      silentVideo,
    ];
    encoder = spawn("ffmpeg", encoderArgs, { windowsHide: true });
    const running = encoder;
    let encoderError = "";
    running.stderr.on("data", (d) => (encoderError += d));
    const encoded = new Promise<void>((resolve, reject) => {
      running.on("error", reject);
      running.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${encoderError.slice(-2000)}`))));
    });
    // A failed encoder also reports through `encoded`; this only stops the pipe from throwing.
    running.stdin.on("error", () => {});
    let last = -1;
    for (let frame = 0; frame < props.durationInFrames; frame++) {
      if (signal?.aborted) throw new CancelledError();
      await footage.advance(frame);
      renderer.draw(ctx, frame);
      // The surface changes with the next frame while the pipe may still queue this one.
      const pixels = Buffer.from(canvas.data());
      if (!running.stdin.write(pixels)) await new Promise<void>((resolve) => running.stdin.once("drain", resolve));
      // Keeps the server answering between frames.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pct = Math.floor(((frame + 1) / props.durationInFrames) * 100);
      if (pct >= last + 5) {
        last = pct;
        log(`Rendering ${props.format} ${quality}: ${pct}%`);
      }
    }
    running.stdin.end();
    await encoded;
    if (signal?.aborted) throw new CancelledError();
    log("Mixing the audio…");
    await mixAudio(props, footage, silentVideo, quality === "final" ? mixed : out);
    if (quality === "final") {
      log("Normalising loudness to -14 LUFS…");
      await loudnorm(mixed, out);
    }
  } catch (err) {
    if (signal?.aborted) throw new CancelledError();
    throw err;
  } finally {
    signal?.removeEventListener("abort", stop);
    footage.close();
    encoder?.kill();
    fs.rmSync(silentVideo, { force: true });
    fs.rmSync(mixed, { force: true });
  }
}

const TARGET_LUFS = -14;

/**
 * EBU R128 normalisation to the -14 LUFS that YouTube, Instagram and TikTok target, with one constant
 * gain so the levels within the mix stay exactly as authored. The first pass measures the integrated
 * loudness; the second applies the gain and a fast peak limiter (about -1.9 dBFS) that only catches
 * brief transients. ffmpeg's loudnorm is not used for the gain: whenever peaks would exceed its
 * true-peak target it falls back to riding the gain, which audibly changes the volume. A silent video
 * keeps its silence.
 */
export async function loudnorm(input: string, output: string): Promise<void> {
  const report = await ffmpeg(["-hide_banner", "-i", input, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
  const json = report.slice(report.lastIndexOf("{"), report.lastIndexOf("}") + 1);
  const measured = Number((JSON.parse(json) as { input_i: string }).input_i);
  const gain = Number.isFinite(measured) && measured > -70 ? TARGET_LUFS - measured : 0;
  const filter = `volume=${gain.toFixed(2)}dB,alimiter=limit=0.8:attack=5:release=60:level=0`;
  await ffmpeg(["-y", "-loglevel", "error", "-i", input, "-c:v", "copy", "-af", filter, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output]);
}
