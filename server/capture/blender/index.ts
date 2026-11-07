import fs from "node:fs";
import path from "node:path";
import { autoFov, FORMAT_SIZE, FRAMING_FOV, MOTION_DEFAULTS, type Format, type Pose, type SceneShot, type Vec3 } from "../../../shared/types.js";
import type { BlenderTargetConfig } from "../../../shared/projects.js";
import type { CaptureOutput, CaptureProvider, CaptureResult, Log } from "../provider.js";
import { motionPoses } from "../scene.js";
import { finishClip } from "../encoding.js";
import { blenderStatus, childObjects, findObjects, frameBounds, renderFrame, selectedObjects, viewCamera } from "./client.js";
import { blenderCamera, framedPose, poseFromCamera, swapAxes } from "./pose.js";

const RULES = `a camera shot rendered from the file open in Blender, with its scene's lights and materials. Objects hidden in the viewport do not appear. Only the camera moves, and the scene stays on its current frame. The camera is placed automatically around the target, looking at it: target = an object's name in that file. Other files can't be shown; use a material for those. To let the developer frame the view by hand, set target "" and describe the view precisely in description. angle = front | three-quarter | side | high | top | low (relative to the target's front, its -Y side). distance = close | medium | wide. motion = still | orbit (slow circle around the target) | push (slow move toward it) | pan (slow sideways slide, still looking ahead) | turn (swivel on the spot) | rise (move straight up). The file shows the model as it is today; use materials for past states.`;

async function poseFor(target: BlenderTargetConfig, shot: SceneShot, format: Format): Promise<{ pose: Pose; center?: Vec3 }> {
  if (shot.pose) return { pose: { ...shot.pose, fov: shot.fov ?? autoFov(format, shot.pose.fov) }, center: shot.pivot };
  if (!shot.target) throw new Error("No target or pose: frame the view in Blender's 3D view and use “Use 3D view”.");
  const { width, height } = FORMAT_SIZE[format];
  const framed = framedPose(await frameBounds(target, shot.target), { angle: shot.angle, distance: shot.distance, fov: shot.fov ?? FRAMING_FOV[format], aspect: width / height, sweep: shot.motion.type === "orbit" ? shot.motion.amount ?? MOTION_DEFAULTS.orbit : 0 });
  return { pose: framed.pose, center: framed.pivot };
}

/** Renders each frame in its own request, so Blender redraws between frames and a slow engine can't exceed one long timeout. */
async function render(target: BlenderTargetConfig, shot: SceneShot, out: CaptureOutput, log: Log): Promise<CaptureResult> {
  fs.mkdirSync(out.dir, { recursive: true });
  const { width, height } = FORMAT_SIZE[out.format];
  const { pose, center } = await poseFor(target, shot, out.format);
  const fovEnd = shot.fovEnd !== undefined && Math.abs(shot.fovEnd - pose.fov) > 0.01 ? shot.fovEnd : undefined;
  if (shot.motion.type === "still" && fovEnd === undefined && !shot.playTimeline) {
    const file = path.join(out.dir, "capture-0000.png");
    await renderFrame(target, { camera: blenderCamera(pose), width, height, file });
    if (!fs.existsSync(file)) throw new Error(`Blender saved no image at ${file}. Blender has to run on the same computer as this app.`);
    return { file };
  }
  const frameDir = path.join(out.dir, "capture-frames");
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
  const poses = motionPoses(pose, shot.motion, out.frames, center, fovEnd);
  log(`Rendering ${poses.length} frames in Blender…`);
  for (const [index, framePose] of poses.entries()) {
    const file = path.join(frameDir, `f_${String(index).padStart(4, "0")}.png`);
    await renderFrame(target, { camera: blenderCamera(framePose), width, height, file, timeline: shot.playTimeline ? { index, fps: out.fps } : undefined });
    if (!fs.existsSync(file)) throw new Error(`Blender saved no image at ${file}. Blender has to run on the same computer as this app.`);
    if ((index + 1) % 30 === 0) log(`Rendered ${index + 1} of ${poses.length} frames.`);
  }
  return finishClip(frameDir, out.dir, out.fps, out.frames);
}

export const blenderProvider: CaptureProvider<BlenderTargetConfig, SceneShot> = {
  kind: "blender-mcp",
  shotModel: "scene",
  capabilities: { objects: true, selection: true, viewPose: true, motions: ["still", "orbit", "push", "pan", "turn", "rise"], video: true },
  resourceKey: (target) => `${["localhost", "::1", "[::1]"].includes(target.host) ? "127.0.0.1" : target.host.toLowerCase()}:${target.port}`,
  async status(target) {
    const { file, version } = await blenderStatus(target);
    return { ok: true, detail: `${file || "Unsaved file"} in Blender ${version}` };
  },
  promptRules: () => RULES,
  render,
  findObjects,
  children: childObjects,
  selection: selectedObjects,
  async viewPose(target) {
    const camera = await viewCamera(target);
    return { ...poseFromCamera(camera), pivot: swapAxes(camera.pivot) };
  },
};
