import net from "node:net";
import type { BlenderTargetConfig } from "../../../shared/projects.js";
import type { Vec3 } from "../../../shared/types.js";
import type { SceneObject } from "../unity/client.js";

const RESULT_MARK = "__DEVLOG_RESULT__";
const QUERY_TIMEOUT_MS = 30_000;
/** One frame in a slow engine can take minutes. Blender handles nothing else while it renders. */
const FRAME_TIMEOUT_MS = 15 * 60_000;

const unreachable = (target: BlenderTargetConfig) => `Blender isn't reachable at ${target.host}:${target.port}. Open Blender, and in the 3D view's sidebar select MCP for Blender > Connect to MCP server.`;

/** Sends one command to the add-on's socket: a JSON object in each direction, with nothing marking the end of a message. */
export function sendCommand(target: BlenderTargetConfig, command: { type: string; params?: Record<string, unknown> }, timeoutMs = QUERY_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`Blender didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`)));
    socket.on("connect", () => socket.write(JSON.stringify(command)));
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      let response: { status?: string; message?: string; result?: unknown };
      try {
        response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return;
      }
      if (response.status === "success") finish(null, response.result);
      else finish(new Error(errorText(response.message)));
    });
    socket.on("error", () => finish(new Error(unreachable(target))));
    socket.on("close", () => finish(new Error("Blender closed the connection before it answered.")));
  });
}

/** The add-on reports a failed script as JSON with the exception's type and message. */
function errorText(message = "Blender reported an error."): string {
  const prefix = message.indexOf("{");
  try {
    const parsed = JSON.parse(message.slice(prefix)) as { message?: string; exception_message?: string };
    return parsed.exception_message ?? parsed.message ?? message;
  } catch {
    return message;
  }
}

const PRELUDE = String.raw`
import bpy, json, math, os
from mathutils import Matrix, Vector
ARGS = json.loads(__ARGS__)
WINDOW = bpy.context.window_manager.windows[0]
SCENE = WINDOW.scene
LAYER = WINDOW.view_layer

expected = ARGS.get("blendFile") or ""
if expected and (not bpy.data.filepath or os.path.normcase(os.path.abspath(bpy.data.filepath)) != os.path.normcase(os.path.abspath(expected))):
    raise Exception("Wrong Blender file: " + (bpy.data.filepath or "unsaved file") + ". This target expects " + expected)

def object_path(o):
    parts = [o.name]
    while o.parent:
        o = o.parent
        parts.insert(0, o.name)
    return "/".join(parts)

def describe(o):
    return {"name": o.name, "path": object_path(o), "scene": SCENE.name, "active": o.visible_get(view_layer=LAYER), "childCount": len(o.children)}

def resolve(path):
    o = SCENE.objects.get(path) or SCENE.objects.get(path.rsplit("/", 1)[-1])
    if not o:
        raise Exception("No object named " + path + " in the open Blender file.")
    return o

def emit(value):
    print("${RESULT_MARK}" + json.dumps(value))
`;

const SCRIPTS = {
  status: String.raw`
emit({"file": bpy.data.filepath, "version": bpy.app.version_string})
`,
  find: String.raw`
query = ARGS["query"].lower()
emit([describe(o) for o in SCENE.objects if query in o.name.lower()][:ARGS["limit"]])
`,
  children: String.raw`
parent = resolve(ARGS["path"]) if ARGS["path"] else None
children = parent.children if parent else [o for o in SCENE.objects if not o.parent]
emit([describe(o) for o in children])
`,
  selection: String.raw`
emit([describe(o) for o in LAYER.objects.selected])
`,
  view: String.raw`
views = [(area, area.spaces.active) for window in bpy.context.window_manager.windows for area in window.screen.areas if area.type == "VIEW_3D"]
if not views:
    raise Exception("Open a 3D view in Blender first.")
area, space = max(views, key=lambda view: view[0].width * view[0].height)
view = space.region_3d
if view.view_perspective == "CAMERA" and SCENE.camera:
    matrix = SCENE.camera.matrix_world
    fov = math.degrees(SCENE.camera.data.angle_y)
elif view.view_perspective == "PERSP":
    matrix = view.view_matrix.inverted()
    fov = math.degrees(2 * math.atan(1 / view.window_matrix[1][1]))
else:
    raise Exception("The 3D view is orthographic. Switch it to perspective with numpad 5.")
rotation = matrix.to_3x3()
emit({
    "position": list(matrix.translation),
    "forward": list(rotation @ Vector((0, 0, -1))),
    "up": list(rotation @ Vector((0, 1, 0))),
    "fov": fov,
    "pivot": list(view.view_location),
})
`,
  frame: String.raw`
root = resolve(ARGS["target"])
graph = bpy.context.evaluated_depsgraph_get()
corners = []
for o in [root] + list(root.children_recursive):
    if o.type in {"MESH", "CURVE", "SURFACE", "FONT", "META", "VOLUME"} and o.visible_get(view_layer=LAYER):
        evaluated = o.evaluated_get(graph)
        corners += [evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box]
if not corners:
    corners = [root.matrix_world.translation.copy()]
emit({
    "low": [min(c[i] for c in corners) - 0.01 for i in range(3)],
    "high": [max(c[i] for c in corners) + 0.01 for i in range(3)],
    "facing": list(root.matrix_world.to_3x3() @ Vector((0, -1, 0))),
})
`,
  render: String.raw`
def use_engine(kind):
    # The engine's identifier depends on the Blender version, and the property's list omits some engines.
    for identifier in {"eevee": ["BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"], "workbench": ["BLENDER_WORKBENCH"], "cycles": ["CYCLES"]}[kind]:
        try:
            SCENE.render.engine = identifier
            return
        except TypeError:
            pass
    raise Exception("This Blender has no " + kind + " render engine.")

render = SCENE.render
camera = ARGS["camera"]
saved = {
    "camera": SCENE.camera, "frame": SCENE.frame_current, "engine": render.engine, "x": render.resolution_x, "y": render.resolution_y,
    "percentage": render.resolution_percentage, "filepath": render.filepath, "format": render.image_settings.file_format, "color": render.image_settings.color_mode,
}
data = bpy.data.cameras.new("DevlogCapture")
capture = bpy.data.objects.new("DevlogCapture", data)
try:
    SCENE.collection.objects.link(capture)
    data.sensor_fit = "VERTICAL"
    data.angle_y = math.radians(camera["fov"])
    data.clip_start = 0.01
    data.clip_end = 100000
    back = -Vector(camera["forward"]).normalized()
    up = Vector(camera["up"]).normalized()
    right = up.cross(back).normalized()
    matrix = Matrix((right, up, back)).transposed().to_4x4()
    matrix.translation = Vector(camera["position"])
    capture.matrix_world = matrix
    SCENE.camera = capture
    if ARGS["engine"] != "scene":
        use_engine(ARGS["engine"])
    render.resolution_x = ARGS["width"]
    render.resolution_y = ARGS["height"]
    render.resolution_percentage = 100
    render.image_settings.file_format = "PNG"
    render.image_settings.color_mode = "RGB"
    render.filepath = ARGS["file"]
    if ARGS.get("timeline") is not None:
        start = SCENE.frame_start
        length = max(1, SCENE.frame_end - start + 1)
        scene_fps = render.fps / render.fps_base
        SCENE.frame_set(start + int(ARGS["timeline"]["index"] * scene_fps / ARGS["timeline"]["fps"]) % length)
    LAYER.update()
    bpy.ops.render.render(write_still=True, scene=SCENE.name)
finally:
    SCENE.camera = saved["camera"]
    render.engine = saved["engine"]
    render.resolution_x = saved["x"]
    render.resolution_y = saved["y"]
    render.resolution_percentage = saved["percentage"]
    render.filepath = saved["filepath"]
    render.image_settings.file_format = saved["format"]
    render.image_settings.color_mode = saved["color"]
    if SCENE.frame_current != saved["frame"]:
        SCENE.frame_set(saved["frame"])
    bpy.data.objects.remove(capture)
    bpy.data.cameras.remove(data)
emit({"file": ARGS["file"]})
`,
};

async function runScript<T>(target: BlenderTargetConfig, script: keyof typeof SCRIPTS, args: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  const payload = JSON.stringify(JSON.stringify({ ...args, blendFile: target.blendFile }));
  const code = PRELUDE.replace("__ARGS__", () => payload) + SCRIPTS[script];
  const result = (await sendCommand(target, { type: "execute_code", params: { code } }, timeoutMs)) as { result?: string } | undefined;
  const output = result?.result ?? "";
  const at = output.lastIndexOf(RESULT_MARK);
  if (at < 0) throw new Error("Blender ran the capture script but returned nothing. Update the add-on from https://github.com/ahujasid/mcp-for-blender.");
  return JSON.parse(output.slice(at + RESULT_MARK.length)) as T;
}

/** The open file and Blender's version. It fails when a target's expected file isn't open. */
export const blenderStatus = (target: BlenderTargetConfig) => runScript<{ file: string; version: string }>(target, "status", {});
export const findObjects = (target: BlenderTargetConfig, query: string, limit: number) => runScript<SceneObject[]>(target, "find", { query, limit });
/** Top-level objects for an empty path, otherwise the object's children. */
export const childObjects = (target: BlenderTargetConfig, path: string) => runScript<SceneObject[]>(target, "children", { path });
export const selectedObjects = (target: BlenderTargetConfig) => runScript<SceneObject[]>(target, "selection", {});
export const viewCamera = (target: BlenderTargetConfig) => runScript<{ position: Vec3; forward: Vec3; up: Vec3; fov: number; pivot: Vec3 }>(target, "view", {});
export const frameBounds = (target: BlenderTargetConfig, name: string) => runScript<{ low: Vec3; high: Vec3; facing: Vec3 }>(target, "frame", { target: name });
/** Renders one frame with a temporary camera, then restores the scene's settings. The file is never saved. */
export const renderFrame = (target: BlenderTargetConfig, args: { camera: { position: Vec3; forward: Vec3; up: Vec3; fov: number }; width: number; height: number; file: string; timeline?: { index: number; fps: number } }) =>
  runScript<{ file: string }>(target, "render", { ...args, engine: target.engine ?? "scene" }, FRAME_TIMEOUT_MS);
