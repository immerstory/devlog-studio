import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { sendCommand } from "../server/capture/blender/client";
import { blenderCamera, framedPose, poseFromCamera, rotationFrom, swapAxes, upOf } from "../server/capture/blender/pose";
import { forward, motionPoses, right } from "../server/capture/scene";
import type { BlenderTargetConfig } from "../shared/projects";

const close = (actual: number[], expected: number[], tolerance = 1e-6) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} is not ${expected}`));
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

test("a rotation built from directions has those directions", () => {
  const cases: Array<[[number, number, number], [number, number, number]]> = [[[0, 0, 1], [0, 1, 0]], [[1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0]], [[0, -1, 0], [0, 0, 1]], [[-0.6, 0, 0.8], [0, 1, 0]]];
  for (const [f, u] of cases) {
    const rotation = rotationFrom(f, u);
    close(forward(rotation), f);
    close(upOf(rotation), u);
    assert.ok(Math.abs(Math.hypot(...rotation) - 1) < 1e-6);
  }
});

test("a Blender view survives the conversion to a shot pose and back", () => {
  const camera = { position: [1, -5, 2] as [number, number, number], forward: [0, 1, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 40 };
  const back = blenderCamera(poseFromCamera(camera));
  close(back.position, camera.position);
  close(back.forward, camera.forward);
  close(back.up, camera.up);
});

test("a pan moves a Blender camera toward its own right, so the shot isn't mirrored", () => {
  const camera = { position: [0, -5, 0] as [number, number, number], forward: [0, 1, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 40 };
  const pose = poseFromCamera(camera);
  const blenderRight = cross(camera.forward, camera.up);
  close(swapAxes(right(pose.rotation)), blenderRight);
  const poses = motionPoses(pose, { type: "pan", amount: 2 }, 3).map(blenderCamera);
  assert.ok(poses[2].position[0] > poses[0].position[0]);
});

test("an orbit turns around Blender's vertical axis and keeps the height", () => {
  const camera = { position: [0, -5, 2] as [number, number, number], forward: [0, 1, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 40 };
  const poses = motionPoses(poseFromCamera(camera), { type: "orbit", amount: 60 }, 5, swapAxes([0, 0, 2])).map(blenderCamera);
  for (const pose of poses) {
    assert.ok(Math.abs(pose.position[2] - 2) < 1e-6);
    assert.ok(Math.abs(Math.hypot(pose.position[0], pose.position[1]) - 5) < 1e-6);
    close(pose.up, [0, 0, 1]);
  }
});

test("a framed target sits in the middle and fits the frame from the front", () => {
  const center = [1, 2, 3];
  const target = { low: [0, 1, 2] as [number, number, number], high: [2, 3, 4] as [number, number, number], facing: [0, -1, 0] as [number, number, number] };
  const { pose, pivot } = framedPose(target, { angle: "front", distance: "medium", fov: 40, aspect: 16 / 9 });
  const camera = blenderCamera(pose);
  close(pivot, swapAxes(center as [number, number, number]));
  const toTarget = [center[0] - camera.position[0], center[1] - camera.position[1], center[2] - camera.position[2]];
  const distance = Math.hypot(...toTarget);
  close(toTarget.map((v) => v / distance), camera.forward);
  assert.ok(camera.position[1] < center[1], "the camera stands on the target's -Y side");
  assert.ok(camera.position[2] > center[2], "the front angle looks slightly down");
});

test("the box's corners end up inside the frame with little spare room", () => {
  const target = { low: [-1, -0.2, 0] as [number, number, number], high: [1, 0.2, 1.2] as [number, number, number], facing: [0, -1, 0] as [number, number, number] };
  const { pose } = framedPose(target, { angle: "side", distance: "medium", fov: 40, aspect: 16 / 9 });
  const camera = blenderCamera(pose);
  const sideways = cross(camera.forward, camera.up);
  const tan = Math.tan((40 * Math.PI) / 360);
  let widest = 0;
  for (const x of [target.low[0], target.high[0]]) for (const y of [target.low[1], target.high[1]]) for (const z of [target.low[2], target.high[2]]) {
    const offset = [x - camera.position[0], y - camera.position[1], z - camera.position[2]];
    const depth = offset[0] * camera.forward[0] + offset[1] * camera.forward[1] + offset[2] * camera.forward[2];
    const across = Math.abs(offset[0] * camera.up[0] + offset[1] * camera.up[1] + offset[2] * camera.up[2]) / (depth * tan);
    const along = Math.abs(offset[0] * sideways[0] + offset[1] * sideways[1] + offset[2] * sideways[2]) / (depth * tan * (16 / 9));
    widest = Math.max(widest, across, along);
  }
  assert.ok(widest <= 1 / 1.15 + 1e-6, `reaches ${widest}`);
  assert.ok(widest > 0.8, `reaches only ${widest}`);
});

test("an orbit's sweep moves the camera back when the target gets wider during the move", () => {
  const target = { low: [-0.2, -2, 0] as [number, number, number], high: [0.2, 2, 1] as [number, number, number], facing: [0, -1, 0] as [number, number, number] };
  const length = (sweep: number) => Math.hypot(...framedPose(target, { angle: "front", fov: 40, aspect: 9 / 16, sweep }).pose.position.map((v, i) => v - [0, 0.5, 0][i]));
  assert.ok(length(120) > length(0));
});

test("a portrait frame moves the camera back to fit the narrower width", () => {
  const target = { low: [-0.2, -2, -0.5] as [number, number, number], high: [0.2, 2, 0.5] as [number, number, number], facing: [0, -1, 0] as [number, number, number] };
  const length = (aspect: number) => Math.hypot(...framedPose(target, { angle: "side", fov: 40, aspect }).pose.position);
  assert.ok(length(9 / 16) > length(16 / 9));
});

const target = (port: number): BlenderTargetConfig => ({ host: "127.0.0.1", port });
function fakeAddon(answer: (socket: net.Socket, received: string) => void): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on("data", (data) => answer(socket, data.toString("utf8"))));
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, stop: () => server.close() }));
  });
}

test("a response split across packets still arrives whole", async () => {
  const addon = await fakeAddon((socket, received) => {
    assert.equal(JSON.parse(received).type, "ping");
    const body = JSON.stringify({ status: "success", result: { pong: "é".repeat(20) } });
    const bytes = Buffer.from(body);
    socket.write(bytes.subarray(0, 25));
    setTimeout(() => socket.write(bytes.subarray(25)), 10);
  });
  try {
    assert.deepEqual(await sendCommand(target(addon.port), { type: "ping" }), { pong: "é".repeat(20) });
  } finally {
    addon.stop();
  }
});

test("a script error shows the exception's message", async () => {
  const addon = await fakeAddon((socket) => socket.write(JSON.stringify({ status: "error", message: `Code execution error: ${JSON.stringify({ exception_type: "Exception", exception_message: "No object named Lamp" })}` })));
  try {
    await assert.rejects(sendCommand(target(addon.port), { type: "execute_code" }), /^Error: No object named Lamp$/);
  } finally {
    addon.stop();
  }
});

test("an unreachable add-on says how to start it", async () => {
  const addon = await fakeAddon(() => {});
  addon.stop();
  await assert.rejects(sendCommand(target(addon.port), { type: "ping" }), /Connect to MCP server/);
});
