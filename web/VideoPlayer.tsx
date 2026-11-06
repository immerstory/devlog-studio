import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FullScreenIcon, PauseIcon, PlayIcon, VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import { VideoFrameRenderer } from "../video/renderer";
import { FOOTAGE_VOLUME, audioSchedule, footageSeconds, segmentWindows, type ScheduledAudio } from "../video/schedule";
import type { Picture, Platform } from "../video/platform";
import type { TimelineProps } from "../shared/types";

/** Seconds a video or sound may drift from the playhead before it is moved back. */
const MAX_DRIFT = 0.2;
/** Seconds before a video appears that it is placed at its first picture. */
const VIDEO_LEAD = 1;

const browserPlatform: Platform = {
  createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  loadImage: (url) =>
    new Promise<Picture>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ source: image, width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
      image.onerror = () => reject(new Error(`Could not load ${url}`));
      image.src = url;
    }),
  async loadFont(url, family) {
    const face = await new FontFace(family, `url(${url})`).load();
    // A page can load several fonts for one family; only the newest stays registered.
    for (const old of [...document.fonts]) if (old.family === family || old.family === `"${family}"`) document.fonts.delete(old);
    document.fonts.add(face);
  },
  newImageData: (data, width, height) => new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height),
};

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Sounds and videos of one timeline, kept in step with the playhead. */
class PlaybackMedia {
  readonly videos = new Map<string, HTMLVideoElement>();
  private readonly sounds: Array<{ item: ScheduledAudio; element: HTMLAudioElement }>;
  private readonly t: TimelineProps;
  private muted = false;

  constructor(t: TimelineProps, onPicture: () => void) {
    this.t = t;
    for (const { segment } of segmentWindows(t)) {
      if (segment.media?.kind !== "video") continue;
      const video = document.createElement("video");
      video.preload = "auto";
      video.playsInline = true;
      video.volume = FOOTAGE_VOLUME;
      video.src = segment.media.src;
      video.addEventListener("seeked", onPicture);
      video.addEventListener("loadeddata", onPicture);
      this.videos.set(segment.id, video);
    }
    this.sounds = audioSchedule(t).filter((item) => !item.optional).map((item) => {
      const element = new Audio(item.src);
      element.preload = "auto";
      element.volume = item.volume;
      return { item, element };
    });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const video of this.videos.values()) video.muted = muted;
    for (const { element } of this.sounds) element.muted = muted;
  }

  /** Puts everything where the playhead says. `playing` false shows the exact picture for a still. */
  sync(frame: number, playing: boolean) {
    const { fps } = this.t;
    const now = frame / fps;
    for (const w of segmentWindows(this.t)) {
      const video = this.videos.get(w.segment.id);
      if (!video) continue;
      const visible = frame >= w.start && frame < w.end;
      const soon = !visible && frame < w.start && frame >= w.start - VIDEO_LEAD * fps;
      const target = footageSeconds(w.segment, fps, Math.max(0, frame - w.start));
      if (visible && playing) {
        video.playbackRate = w.segment.media?.playbackRate ?? 1;
        // Past its end a video holds its last picture.
        const inFile = !video.duration || target < video.duration;
        if (inFile && Math.abs(video.currentTime - target) > MAX_DRIFT) video.currentTime = target;
        if (video.paused && inFile) video.play().catch(() => {});
      } else {
        if (!video.paused) video.pause();
        if ((visible || soon) && Math.abs(video.currentTime - target) > 0.001 && !video.seeking) video.currentTime = target;
      }
    }
    for (const { item, element } of this.sounds) {
      const end = item.maxSeconds === undefined ? Infinity : item.at + item.maxSeconds;
      const inside = now >= item.at && now < end && (!element.duration || now - item.at < element.duration);
      if (playing && inside) {
        const target = item.offset + now - item.at;
        if (Math.abs(element.currentTime - target) > MAX_DRIFT) element.currentTime = target;
        if (element.paused) element.play().catch(() => {});
      } else if (!element.paused) element.pause();
    }
    void this.muted;
  }

  dispose() {
    for (const video of this.videos.values()) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    for (const { element } of this.sounds) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
  }
}

/** Plays a timeline on a canvas with the same drawing code the export uses. */
export function VideoPlayer({ timeline: t, loop = false, autoPlay = false }: { timeline: TimelineProps; loop?: boolean; autoPlay?: boolean }) {
  const frameBox = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VideoFrameRenderer | null>(null);
  const mediaRef = useRef<PlaybackMedia | null>(null);
  const positionRef = useRef(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState("");
  const [muted, setMuted] = useState(false);
  const last = t.durationInFrames - 1;

  const paint = useCallback(() => {
    const renderer = rendererRef.current;
    const ctx = canvasRef.current?.getContext("2d");
    if (renderer && ctx) renderer.draw(ctx, Math.min(last, Math.floor(positionRef.current)));
  }, [last]);

  // A new timeline prepares a new renderer; the playhead stays where it is when it still fits.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setFailed("");
    setPlaying(false);
    positionRef.current = Math.min(positionRef.current, last);
    setFrame(Math.floor(positionRef.current));
    const media = new PlaybackMedia(t, () => paint());
    mediaRef.current = media;
    const picture = (segmentId: string): Picture | null => {
      const video = media.videos.get(segmentId);
      return video && video.readyState >= 2 ? { source: video, width: video.videoWidth, height: video.videoHeight } : null;
    };
    VideoFrameRenderer.create(t, browserPlatform, picture, { tolerant: true }).then(
      (renderer) => {
        if (cancelled) return;
        rendererRef.current = renderer;
        media.sync(Math.floor(positionRef.current), false);
        paint();
        setReady(true);
        if (autoPlay) setPlaying(true);
      },
      (err: Error) => { if (!cancelled) setFailed(err.message); },
    );
    return () => {
      cancelled = true;
      rendererRef.current = null;
      mediaRef.current = null;
      media.dispose();
    };
  }, [t, paint, last, autoPlay]);

  useEffect(() => mediaRef.current?.setMuted(muted), [muted, ready]);

  useEffect(() => {
    if (!playing || !ready) {
      mediaRef.current?.sync(Math.floor(positionRef.current), false);
      return;
    }
    let raf = 0;
    let previous = 0;
    const tick = (now: number) => {
      const dt = previous ? (now - previous) / 1000 : 0;
      previous = now;
      let next = positionRef.current + dt * t.fps;
      if (next >= t.durationInFrames) {
        if (!loop) {
          positionRef.current = 0;
          setFrame(0);
          setPlaying(false);
          paint();
          return;
        }
        next = 0;
      }
      const whole = Math.floor(next);
      const changed = whole !== Math.floor(positionRef.current) || !dt;
      positionRef.current = next;
      if (changed) {
        mediaRef.current?.sync(whole, true);
        paint();
        setFrame(whole);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, ready, loop, t.fps, t.durationInFrames, paint]);

  const seek = (to: number) => {
    positionRef.current = to;
    setFrame(to);
    mediaRef.current?.sync(to, playing);
    paint();
  };
  const toggle = () => { if (ready) setPlaying((p) => !p); };

  return (
    <div
      ref={frameBox}
      className="video-player"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== " " || e.target !== e.currentTarget) return;
        e.preventDefault();
        toggle();
      }}
    >
      <canvas ref={canvasRef} width={t.width} height={t.height} style={{ aspectRatio: `${t.width} / ${t.height}` }} onClick={toggle} />
      {!ready && !failed ? <div className="video-player-status">Loading…</div> : null}
      {failed ? <div className="video-player-status">{failed}</div> : null}
      <div className="video-player-controls">
        <button type="button" aria-label={playing ? "Pause" : "Play"} disabled={!ready} onClick={toggle}><HugeiconsIcon icon={playing ? PauseIcon : PlayIcon} size={16} /></button>
        <input type="range" aria-label="Position" min={0} max={last} step={1} value={frame} disabled={!ready} onChange={(e) => seek(Number(e.target.value))} />
        <span className="video-player-time">{clock(frame / t.fps)} / {clock(t.durationInFrames / t.fps)}</span>
        <button type="button" aria-label={muted ? "Turn sound on" : "Mute"} onClick={() => setMuted((m) => !m)}><HugeiconsIcon icon={muted ? VolumeOffIcon : VolumeHighIcon} size={16} /></button>
        <button type="button" aria-label="Full screen" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void frameBox.current?.requestFullscreen(); }}><HugeiconsIcon icon={FullScreenIcon} size={16} /></button>
      </div>
    </div>
  );
}
