import { MOTION_DEFAULTS, type Pose, type ShotMotion } from "../../shared/types.js";
// ---------- pose math ----------

type V3 = [number, number, number];
type Q = [number, number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ease = (t: number) => t * t * (3 - 2 * t);

export function slerp(a: Q, b: Q, t: number): Q {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) {
    dot = -dot;
    bb = [-b[0], -b[1], -b[2], -b[3]];
  }
  if (dot > 0.9995) {
    const r: Q = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t];
    const n = Math.hypot(...r);
    return r.map((x) => x / n) as Q;
  }
  const th0 = Math.acos(dot);
  const th = th0 * t;
  const s0 = Math.cos(th) - (dot * Math.sin(th)) / Math.sin(th0);
  const s1 = Math.sin(th) / Math.sin(th0);
  return [a[0] * s0 + bb[0] * s1, a[1] * s0 + bb[1] * s1, a[2] * s0 + bb[2] * s1, a[3] * s0 + bb[3] * s1];
}

/** Unity Quaternion.Euler(pitch, yaw, 0) (degrees). */
export function eulerYawPitch(yawDeg: number, pitchDeg: number): Q {
  const y = (yawDeg * Math.PI) / 360;
  const p = (pitchDeg * Math.PI) / 360;
  // Unity applies Z, then X, then Y: q = qy * qx
  const qy: Q = [0, Math.sin(y), 0, Math.cos(y)];
  const qx: Q = [Math.sin(p), 0, 0, Math.cos(p)];
  return mul(qy, qx);
}

function mul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotates Unity's forward (0,0,1) by q. */
export function forward(q: Q): V3 {
  const [x, y, z, w] = q;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

/** Rotates Unity's right (1,0,0) by q. */
export function right(q: Q): V3 {
  const [x, y, z, w] = q;
  return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
}

function yawPitchOf(dir: V3): { yaw: number; pitch: number } {
  const yaw = (Math.atan2(dir[0], dir[2]) * 180) / Math.PI;
  const pitch = (-Math.asin(Math.max(-1, Math.min(1, dir[1] / Math.hypot(...dir)))) * 180) / Math.PI;
  return { yaw, pitch };
}

/** Pose sequence for a camera move starting at `start`. `center` is the orbit/push target; `fovEnd` zooms the lens over the move. */
export function motionPoses(start: Pose, motion: ShotMotion, frames: number, center?: V3, fovEnd?: number): Pose[] {
  const n = Math.max(1, frames);
  const poses: Pose[] = [];
  const fwd = forward(start.rotation);
  const focus: V3 = center ?? [start.position[0] + fwd[0] * 20, start.position[1] + fwd[1] * 20, start.position[2] + fwd[2] * 20];
  const offset = sub(start.position, focus);
  const amount = motion.amount ?? MOTION_DEFAULTS[motion.type];

  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : ease(i / (n - 1));
    if (motion.type === "orbit") {
      // The whole camera turns around the vertical axis through the centre: position and view direction
      // together, so the centre keeps its place on screen. The framed pose is the middle of the move:
      // the orbit starts half the angle to one side and ends half the angle to the other.
      const a = ((amount * Math.PI) / 180) * (t - 0.5);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const pos: V3 = [focus[0] + offset[0] * cos + offset[2] * sin, start.position[1], focus[2] - offset[0] * sin + offset[2] * cos];
      poses.push({ position: pos, rotation: mul([0, Math.sin(a / 2), 0, Math.cos(a / 2)], start.rotation), fov: start.fov });
    } else if (motion.type === "push") {
      const end = lerp3(start.position, focus, amount);
      poses.push({ position: lerp3(start.position, end, t), rotation: start.rotation, fov: start.fov });
    } else if (motion.type === "pan") {
      // Lateral slide along the camera's right vector, view direction unchanged.
      const r = right(start.rotation);
      const k = (t - 0.5) * amount;
      poses.push({ position: [start.position[0] + r[0] * k, start.position[1] + r[1] * k, start.position[2] + r[2] * k], rotation: start.rotation, fov: start.fov });
    } else if (motion.type === "turn") {
      const { yaw, pitch } = yawPitchOf(fwd);
      poses.push({ position: start.position, rotation: eulerYawPitch(yaw + amount * (t - 0.5), pitch), fov: start.fov });
    } else if (motion.type === "rise") {
      const pos: V3 = [start.position[0], start.position[1] + amount * t, start.position[2]];
      poses.push({ position: pos, rotation: start.rotation, fov: start.fov });
    } else {
      poses.push(start);
    }
    if (fovEnd !== undefined) poses[i] = { ...poses[i], fov: start.fov + (fovEnd - start.fov) * t };
  }
  return poses;
}

