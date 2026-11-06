import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ANGLE_FRAMING, autoFov, DISTANCE_PADDING, FORMAT_SIZE, FRAMING_FOV, MOTION_DEFAULTS, type Format, type Pose, type SceneShot } from "../../../shared/types.js";
import type { CaptureProvider, CaptureOutput, CaptureResult, Log } from "../provider.js";
import type { UnityTargetConfig } from "../../../shared/projects.js";
import { verifyProject } from "./mcp.js";
import { findObjects, childObjects, selectedObjects, sceneViewPose, frameTarget, renderPoses } from "./client.js";
import { motionPoses } from "../scene.js";
import { encodeSequence } from "../encoding.js";
import { inContext } from "../../context.js";
const run = promisify(execFile);
type UnityConfig = UnityTargetConfig;
const RULES = `a camera shot rendered in the Unity editor, in edit mode: only objects saved in the scene are visible, nothing animates, only the camera moves. Runtime-spawned content (crowds, traffic, spawned characters), editor gizmos and invisible markers do not appear; use a material for those. The camera is placed automatically outside the target's bounding box, looking at it: target = exact hierarchy path from the list below (an object name also works). Small targets (a person, a marker, a prop) give close shots; a building target shows its exterior. Interiors seen from inside, and views no target describes, need manual framing: set target "" and describe the view precisely in description. angle = front | three-quarter | side | high | top | low (relative to the target's facing). distance = close | medium | wide. motion = still | orbit (slow circle around the target) | push (slow move toward it) | pan (slow sideways slide, still looking ahead) | turn (swivel on the spot) | rise (move straight up). The editor shows the game as it is today; use materials for past states.`;

async function poseFor(v: SceneShot, format: Format): Promise<{ pose: Pose; center?: [number, number, number]; warning?: string }> {
  const { width, height } = FORMAT_SIZE[format];
  if (v.pose) return { pose: { ...v.pose, fov: v.fov ?? autoFov(format, v.pose.fov) }, center: v.pivot };
  if (v.target) {
    const angle = ANGLE_FRAMING[v.angle ?? "three-quarter"];
    const padding = DISTANCE_PADDING[v.distance ?? "medium"];
    const sweep = v.motion.type === "orbit" ? v.motion.amount ?? MOTION_DEFAULTS.orbit : 0;
    const f = await frameTarget({ target: v.target, aspect: width / height, fov: v.fov ?? FRAMING_FOV[format], yawOffset: angle.yawOffset, pitch: angle.pitch, padding, sweep });
    return { pose: f, center: f.center, warning: f.clear ? undefined : "No unobstructed angle found; check the shot or use the Scene view." };
  }
  throw new Error("No target or pose: frame the view in the Scene view and use “Use Scene view”.");
}

async function probeSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { windowsHide: true });
  return Number(stdout.trim()) || 0;
}

/** Renders one editor shot locally, uploads it to Garage; returns a warning when the shot needs a manual check. */
async function render(_target: UnityConfig, shot: SceneShot, out: CaptureOutput, log: Log): Promise<CaptureResult> {
  const dir = out.dir;
  const format = out.format;
  fs.mkdirSync(dir, { recursive: true });
  const { width, height } = FORMAT_SIZE[format];
  const { pose, center, warning } = await poseFor(shot, format);
  const base = "capture";
  // A lens zoom turns even a still shot into a clip.
  const fovEnd = shot.fovEnd !== undefined && Math.abs(shot.fovEnd - pose.fov) > 0.01 ? shot.fovEnd : undefined;
  if (shot.motion.type === "still" && fovEnd === undefined) {
    const [file] = await renderPoses({ poses: [pose], width, height, outPattern: path.join(dir, `${base}-{0:D4}.png`) });
    return { file, warning };
  } else {
    const fps = out.fps;
    const frames = out.frames;
    const frameDir = path.join(dir, `${base}-frames`);
    fs.rmSync(frameDir, { recursive: true, force: true });
    log(`Rendering ${frames} frames for ${shot.motion.type === "still" ? "zoom" : shot.motion.type} shot…`);
    await renderPoses({ poses: motionPoses(pose, shot.motion, frames, center, fovEnd), width, height, outPattern: path.join(frameDir, "f_{0:D4}.png"), supersample: 1, fps });
    const mp4 = path.join(dir, `${base}.mp4`);
    await encodeSequence(path.join(frameDir, "f_%04d.png"), fps, mp4);
    const still = path.join(dir, `${base}.jpg`);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(frameDir, `f_${String(Math.floor(frames / 2)).padStart(4, "0")}.png`), "-q:v", "2", still], { windowsHide: true });
    const durationSeconds = await probeSeconds(mp4);
    fs.rmSync(frameDir, { recursive: true, force: true });
    return { file: mp4, poster: still, durationSeconds, warning };
  }
}

export const unityProvider: CaptureProvider<UnityConfig, SceneShot> = {
  kind: "unity-mcp", shotModel: "scene",
  capabilities: { objects: true, selection: true, viewPose: true, motions: ["still", "orbit", "push", "pan", "turn", "rise"], video: true },
  resourceKey(target) { const url = new URL(target.url); url.hostname = ["localhost", "::1", "[::1]"].includes(url.hostname) ? "127.0.0.1" : url.hostname.toLowerCase(); return url.toString().replace(/\/$/, ""); },
  async status(target) { const result = await inContext({ captureConfig: target }, verifyProject); return { ok: result.ok, detail: result.ok ? result.dataPath : `Wrong Unity project: ${result.dataPath}` }; },
  promptRules() { return RULES; },
  render: (target, shot, out, log) => inContext({ captureConfig: target }, () => render(target, shot, out, log)),
  findObjects: (target, query, limit) => inContext({ captureConfig: target }, () => findObjects(query, limit)),
  children: (target, hierarchyPath) => inContext({ captureConfig: target }, () => childObjects(hierarchyPath)),
  selection: (target) => inContext({ captureConfig: target }, selectedObjects),
  viewPose: (target) => inContext({ captureConfig: target }, sceneViewPose),
};
