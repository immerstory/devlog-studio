import { ANGLE_FRAMING, DISTANCE_PADDING, type Pose, type ShotAngle, type ShotDistance, type Vec3 } from "../../../shared/types.js";
import { eulerYawPitch, forward, right } from "../scene.js";

type Q = [number, number, number, number];

/**
 * Shot poses use a Y-up space with +Z as a camera's forward direction, and Blender is Z-up.
 * Swapping Y and Z converts a point or direction either way.
 */
export const swapAxes = ([x, y, z]: Vec3): Vec3 => [x, z, y];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** Rotates the shot space's up direction (0,1,0) by q. */
export function upOf(q: Q): Vec3 {
  const [x, y, z, w] = q;
  return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
}

/** The rotation whose forward and up directions are the given ones, in the shot space. */
export function rotationFrom(forwardDirection: Vec3, upDirection: Vec3): Q {
  const f = unit(forwardDirection);
  const r = unit(cross(upDirection, f));
  const u = cross(f, r);
  const trace = r[0] + u[1] + f[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(u[2] - f[1]) / s, (f[0] - r[2]) / s, (r[1] - u[0]) / s, s / 4];
  }
  if (r[0] > u[1] && r[0] > f[2]) {
    const s = Math.sqrt(1 + r[0] - u[1] - f[2]) * 2;
    return [s / 4, (u[0] + r[1]) / s, (f[0] + r[2]) / s, (u[2] - f[1]) / s];
  }
  if (u[1] > f[2]) {
    const s = Math.sqrt(1 + u[1] - r[0] - f[2]) * 2;
    return [(u[0] + r[1]) / s, s / 4, (f[1] + u[2]) / s, (f[0] - r[2]) / s];
  }
  const s = Math.sqrt(1 + f[2] - r[0] - u[1]) * 2;
  return [(f[0] + r[2]) / s, (f[1] + u[2]) / s, s / 4, (r[1] - u[0]) / s];
}

/** A shot pose as a Blender camera: position, viewing direction and up direction, all in Blender's axes. */
export const blenderCamera = (pose: Pose) => ({
  position: swapAxes(pose.position),
  forward: swapAxes(forward(pose.rotation)),
  up: swapAxes(upOf(pose.rotation)),
  fov: pose.fov,
});

/** A Blender camera or 3D view as a shot pose. */
export const poseFromCamera = (camera: { position: Vec3; forward: Vec3; up: Vec3; fov: number }): Pose => ({
  position: swapAxes(camera.position),
  rotation: rotationFrom(swapAxes(camera.forward), swapAxes(camera.up)),
  fov: camera.fov,
});

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Camera distance from the box's centre at which every corner lies inside the frame, with the shot's padding. */
function fitDistance(halfSize: Vec3, rotation: Q, tanVertical: number, tanHorizontal: number): number {
  const [r, u, f] = [right(rotation), upOf(rotation), forward(rotation)];
  let distance = 0;
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const corner: Vec3 = [x * halfSize[0], y * halfSize[1], z * halfSize[2]];
    const depth = dot(corner, f);
    distance = Math.max(distance, Math.abs(dot(corner, r)) / tanHorizontal - depth, Math.abs(dot(corner, u)) / tanVertical - depth, 0.01 - depth);
  }
  return distance;
}

/**
 * Places the camera so a target's bounding box fits the frame, for the whole of an orbit's `sweep` in degrees.
 * The target's front is its local -Y side, the side Blender's front view shows.
 * The box and `facing` use Blender's axes; the pivot in the result uses the shot space.
 */
export function framedPose(target: { low: Vec3; high: Vec3; facing: Vec3 }, shot: { angle?: ShotAngle; distance?: ShotDistance; fov: number; aspect: number; sweep?: number }): { pose: Pose; pivot: Vec3 } {
  const low = swapAxes(target.low);
  const high = swapAxes(target.high);
  const center: Vec3 = [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2, (low[2] + high[2]) / 2];
  const halfSize: Vec3 = [(high[0] - low[0]) / 2, (high[1] - low[1]) / 2, (high[2] - low[2]) / 2];
  const facing = swapAxes(target.facing);
  const yaw = Math.hypot(facing[0], facing[2]) > 1e-4 ? (Math.atan2(facing[0], facing[2]) * 180) / Math.PI : 0;
  const angle = ANGLE_FRAMING[shot.angle ?? "three-quarter"];
  const rotation = eulerYawPitch(yaw + angle.yawOffset, angle.pitch);
  const padding = DISTANCE_PADDING[shot.distance ?? "medium"];
  const tanVertical = Math.tan((shot.fov * Math.PI) / 360) / padding;
  const tanHorizontal = tanVertical * shot.aspect;
  const sweep = shot.sweep ?? 0;
  let distance = 0;
  for (let step = 0; step <= 8; step++) {
    distance = Math.max(distance, fitDistance(halfSize, eulerYawPitch(yaw + angle.yawOffset + sweep * (step / 8 - 0.5), angle.pitch), tanVertical, tanHorizontal));
  }
  const view = forward(rotation);
  return {
    pose: { position: [center[0] - view[0] * distance, center[1] - view[1] * distance, center[2] - view[2] * distance], rotation, fov: shot.fov },
    pivot: center,
  };
}
