import path from "node:path";
import { config } from "../../config.js";
import { executeCSharp } from "./mcp.js";
import { throwIfCancelled } from "../../jobs.js";
import type { Pose } from "../../../shared/types.js";

/**
 * Editor capture runs C# in the open editor through MCP `script-execute`.
 * It creates one hidden, unsaved camera (HideAndDontSave), renders, and destroys it.
 * It never writes inside the Unity project, never touches assets and never marks scenes dirty.
 */
const CAPTURE_CS = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.Rendering.RenderGraphModule;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

public static class DevlogCapture
{
    public static string Run()
    {
        var req = JObject.Parse(@"__REQUEST__");
        var expected = (string)req["expectedDataPath"];
        var actual = Application.dataPath.Replace('\\', '/').TrimEnd('/');
        if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
            throw new Exception("Unity MCP is connected to " + actual + ", not " + expected + ".");
        var op = (string)req["op"];
        switch (op)
        {
            case "sceneViewPose": return JsonConvert.SerializeObject(SceneViewPose());
            case "cameraPose": return JsonConvert.SerializeObject(CameraPose((string)req["camera"]));
            case "frame": return JsonConvert.SerializeObject(Frame(req));
            case "find": return JsonConvert.SerializeObject(FindObjects((string)req["query"], (int?)req["limit"] ?? 25));
            case "selection": return JsonConvert.SerializeObject(SelectionPaths());
            case "children": return JsonConvert.SerializeObject(Children((string)req["path"]));
            case "render": return JsonConvert.SerializeObject(Render(req));
            default: throw new Exception("Unknown op " + op);
        }
    }

    static JObject PoseOf(Transform t, float fov)
    {
        var p = t.position; var r = t.rotation;
        return new JObject {
            ["position"] = new JArray(p.x, p.y, p.z),
            ["rotation"] = new JArray(r.x, r.y, r.z, r.w),
            ["fov"] = fov
        };
    }

    static JObject SceneViewPose()
    {
        var sv = SceneView.lastActiveSceneView;
        if (sv == null || sv.camera == null) throw new Exception("No active Scene view.");
        var t = sv.camera.transform;
        var pose = PoseOf(t, sv.camera.fieldOfView);
        // The shot's centre for push and orbit: the first surface in the middle of the view, or a point 20 m ahead.
        var ray = new Ray(t.position, t.forward);
        string hitName;
        var hit = ViewHit(ray, 1000f, out hitName);
        var centre = hit ?? ray.GetPoint(20f);
        pose["pivot"] = new JArray(centre.x, centre.y, centre.z);
        if (hitName != null) pose["pivotObject"] = hitName;
        pose["scene"] = SceneManager.GetActiveScene().path;
        return pose;
    }

    /// <summary>
    /// First surface along the ray. Many scene meshes have no colliders, so the meshes whose bounds the ray
    /// crosses get temporary colliders in a preview scene, nearest first; the user's scenes are not modified.
    /// </summary>
    static Vector3? ViewHit(Ray ray, float max, out string name)
    {
        name = null;
        var candidates = new List<KeyValuePair<float, MeshFilter>>();
        foreach (var mf in UnityEngine.Object.FindObjectsByType<MeshFilter>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
        {
            var mr = mf.GetComponent<MeshRenderer>();
            if (mr == null || !mr.enabled || mf.sharedMesh == null) continue;
            float d;
            if (mr.bounds.IntersectRay(ray, out d) && d <= max) candidates.Add(new KeyValuePair<float, MeshFilter>(d, mf));
        }
        candidates.Sort((a, b) => a.Key.CompareTo(b.Key));
        var probe = EditorSceneManager.NewPreviewScene();
        bool backfaces = Physics.queriesHitBackfaces;
        try
        {
            var names = new Dictionary<Collider, string>();
            for (int i = 0; i < candidates.Count && i < 96; i++)
            {
                var mf = candidates[i].Value;
                var copy = new GameObject("view-probe") { hideFlags = HideFlags.HideAndDontSave };
                SceneManager.MoveGameObjectToScene(copy, probe);
                copy.transform.SetPositionAndRotation(mf.transform.position, mf.transform.rotation);
                copy.transform.localScale = mf.transform.lossyScale;
                var col = copy.AddComponent<MeshCollider>();
                col.sharedMesh = mf.sharedMesh;
                // Mesh objects often have generic names; the parent usually names the thing.
                names[col] = mf.transform.parent != null ? mf.transform.parent.name + "/" + mf.gameObject.name : mf.gameObject.name;
            }
            foreach (var terrain in Terrain.activeTerrains)
            {
                if (terrain == null || terrain.terrainData == null) continue;
                var copy = new GameObject("view-probe-terrain") { hideFlags = HideFlags.HideAndDontSave };
                SceneManager.MoveGameObjectToScene(copy, probe);
                copy.transform.position = terrain.transform.position;
                var col = copy.AddComponent<TerrainCollider>();
                col.terrainData = terrain.terrainData;
                names[col] = terrain.gameObject.name;
            }
            // Mesh colliders are single-sided; a wall seen from behind still counts.
            Physics.queriesHitBackfaces = true;
            RaycastHit h;
            if (!probe.GetPhysicsScene().Raycast(ray.origin, ray.direction, out h, max, ~0, QueryTriggerInteraction.Ignore)) return null;
            names.TryGetValue(h.collider, out name);
            return h.point;
        }
        finally
        {
            Physics.queriesHitBackfaces = backfaces;
            EditorSceneManager.ClosePreviewScene(probe);
        }
    }

    static Camera SourceCamera(string path)
    {
        if (!string.IsNullOrEmpty(path))
        {
            var go = FindByPath(path);
            if (go != null && go.GetComponent<Camera>() != null) return go.GetComponent<Camera>();
        }
        if (Camera.main != null) return Camera.main;
        return UnityEngine.Object.FindFirstObjectByType<Camera>();
    }

    static JObject CameraPose(string path)
    {
        var cam = SourceCamera(path);
        if (cam == null) throw new Exception("No camera found.");
        return PoseOf(cam.transform, cam.fieldOfView);
    }

    static IEnumerable<GameObject> AllObjects()
    {
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var scene = SceneManager.GetSceneAt(i);
            if (!scene.isLoaded) continue;
            var stack = new Stack<Transform>();
            foreach (var root in scene.GetRootGameObjects()) stack.Push(root.transform);
            while (stack.Count > 0)
            {
                var t = stack.Pop();
                yield return t.gameObject;
                for (int c = 0; c < t.childCount; c++) stack.Push(t.GetChild(c));
            }
        }
    }

    /** Siblings of t in hierarchy order: the parent's children, or the scene's root objects. */
    static List<Transform> Siblings(Transform t)
    {
        var list = new List<Transform>();
        if (t.parent != null) { for (int i = 0; i < t.parent.childCount; i++) list.Add(t.parent.GetChild(i)); }
        else foreach (var root in t.gameObject.scene.GetRootGameObjects()) list.Add(root.transform);
        return list;
    }

    /** Path segment: the name, plus "[n]" (0-based among same-named siblings) when the name is ambiguous. */
    static string Segment(Transform t)
    {
        int count = 0, ordinal = 0;
        foreach (var s in Siblings(t))
        {
            if (s.name != t.name) continue;
            if (s == t) ordinal = count;
            count++;
        }
        return count > 1 ? t.name + "[" + ordinal + "]" : t.name;
    }

    static string PathOf(Transform t)
    {
        var parts = new List<string>();
        for (var x = t; x != null; x = x.parent) parts.Insert(0, Segment(x));
        return string.Join("/", parts);
    }

    /** Matches one path segment: exact unique form first, then a plain name (first of its siblings). */
    static Transform MatchSegment(List<Transform> candidates, string segment)
    {
        foreach (var c in candidates) if (Segment(c) == segment) return c;
        foreach (var c in candidates) if (c.name == segment) return c;
        return null;
    }

    static GameObject FindByPath(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var segments = path.Split('/');
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var scene = SceneManager.GetSceneAt(i);
            if (!scene.isLoaded) continue;
            var level = new List<Transform>();
            foreach (var root in scene.GetRootGameObjects()) level.Add(root.transform);
            Transform hit = null;
            foreach (var segment in segments)
            {
                hit = MatchSegment(level, segment);
                if (hit == null) break;
                level.Clear();
                for (int c = 0; c < hit.childCount; c++) level.Add(hit.GetChild(c));
            }
            if (hit != null) return hit.gameObject;
        }
        // A bare object name (as agents often write) matches the first object with that name.
        foreach (var go in AllObjects()) if (go.name == path) return go;
        return null;
    }

    static JObject Describe(GameObject go) => new JObject {
        ["name"] = go.name, ["path"] = PathOf(go.transform), ["scene"] = go.scene.name,
        ["active"] = go.activeInHierarchy, ["childCount"] = go.transform.childCount
    };

    /** Objects selected in the editor, active object first. */
    static JArray SelectionPaths()
    {
        var result = new JArray();
        var seen = new HashSet<GameObject>();
        if (Selection.activeGameObject != null && Selection.activeGameObject.scene.IsValid()) { result.Add(Describe(Selection.activeGameObject)); seen.Add(Selection.activeGameObject); }
        foreach (var go in Selection.gameObjects)
            if (go.scene.IsValid() && seen.Add(go)) result.Add(Describe(go));
        return result;
    }

    /** Root objects of all loaded scenes for an empty path, otherwise the children of that object. */
    static JArray Children(string path)
    {
        var result = new JArray();
        if (string.IsNullOrEmpty(path))
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects()) result.Add(Describe(root));
            }
            return result;
        }
        var go = FindByPath(path);
        if (go == null) throw new Exception("Object not found: " + path);
        for (int c = 0; c < go.transform.childCount; c++) result.Add(Describe(go.transform.GetChild(c).gameObject));
        return result;
    }

    static JArray FindObjects(string query, int limit)
    {
        var result = new JArray();
        var q = (query ?? "").ToLowerInvariant();
        foreach (var go in AllObjects())
        {
            if (!go.name.ToLowerInvariant().Contains(q)) continue;
            var entry = Describe(go);
            entry["scene"] = go.scene.path;
            result.Add(entry);
            if (result.Count >= limit) break;
        }
        return result;
    }

    static JObject Frame(JObject req)
    {
        var go = FindByPath((string)req["target"]);
        if (go == null) throw new Exception("Target not found: " + (string)req["target"]);
        var renderers = go.GetComponentsInChildren<Renderer>(false);
        // Markers without renderers (spawn or work positions) are framed as a standing person.
        Bounds b = new Bounds(go.transform.position + Vector3.up * 0.9f, new Vector3(0.8f, 1.8f, 0.8f));
        bool any = false;
        foreach (var r in renderers)
        {
            if (!r.enabled || r is ParticleSystemRenderer) continue;
            if (!any) { b = r.bounds; any = true; } else b.Encapsulate(r.bounds);
        }
        float fov = (float?)req["fov"] ?? 40f;
        float aspect = (float?)req["aspect"] ?? (16f / 9f);
        // yawOffset is relative to the object's facing: 180 looks at its front.
        float yaw = (float?)req["yaw"] ?? go.transform.eulerAngles.y + ((float?)req["yawOffset"] ?? 200f);
        float pitch = (float?)req["pitch"] ?? 18f;
        float padding = (float?)req["padding"] ?? 1.15f;
        float sweep = (float?)req["sweep"] ?? 0f;
        float vHalf = fov * 0.5f * Mathf.Deg2Rad;
        float hHalf = Mathf.Atan(Mathf.Tan(vHalf) * aspect);
        float radius = Mathf.Max(b.extents.magnitude, 0.5f);
        float desired = radius * padding / Mathf.Sin(Mathf.Min(vHalf, hHalf));
        float minDist = Mathf.Min(desired, Mathf.Max(1.2f, radius * 0.6f));

        // Search yaw/pitch candidates around the requested angle. Each candidate's usable distance is the
        // clear line from the target centre to the camera (over the whole orbit sweep), so walls never
        // end up between camera and target. The score prefers full distance and small angle changes.
        // Occlusion uses a temporary preview scene with mesh colliders built from nearby renderers, because
        // many scene meshes have no colliders. The user's scenes are not modified.
        float bestScore = float.MinValue, bestYaw = yaw, bestPitch = pitch, bestDist = desired;
        int probeCount = 0;
        var probe = EditorSceneManager.NewPreviewScene();
        try
        {
            probeCount = BuildProbe(probe, b.center, desired + 6f, go.transform);
            var phys = probe.GetPhysicsScene();
            // The sight line is a thick cylinder so frames and doorways do not cover the subject.
            float sightRadius = Mathf.Clamp(radius * 0.45f, 0.25f, 1.5f);
            float[] pitchOffsets = { 0f, 12f, -8f, 25f };
            for (int yi = 0; yi < 24; yi++)
            {
                float dy = (yi % 2 == 0 ? 1 : -1) * ((yi + 1) / 2) * 15f;
                foreach (var dp in pitchOffsets)
                {
                    float cy = yaw + dy, cp = Mathf.Clamp(pitch + dp, -10f, 80f);
                    float clear = float.MaxValue;
                    int steps = Mathf.Max(1, Mathf.CeilToInt(Mathf.Abs(sweep) / 10f));
                    for (int s = 0; s <= steps && clear > minDist * 0.5f; s++)
                    {
                        // The orbit swings from half the sweep on one side of the framing to half on the other.
                        float sy = cy + sweep * ((float)s / steps - 0.5f);
                        var dir = Quaternion.Euler(cp, sy, 0f) * Vector3.back;
                        clear = Mathf.Min(clear, ClearDistance(phys, b.center, dir, desired + 0.4f, sightRadius) - 0.4f);
                    }
                    if (clear < minDist) continue;
                    float d = Mathf.Min(desired, clear);
                    float score = d / desired * 100f - Mathf.Abs(dy) * 0.35f - Mathf.Abs(dp) * 0.5f;
                    if (score > bestScore) { bestScore = score; bestYaw = cy; bestPitch = cp; bestDist = d; }
                }
            }
        }
        finally
        {
            EditorSceneManager.ClosePreviewScene(probe);
        }
        bool clearFound = bestScore > float.MinValue;
        var rot = Quaternion.Euler(bestPitch, bestYaw, 0f);
        var pos = b.center - rot * Vector3.forward * bestDist;
        // A closer camera keeps the subject's size by widening the lens.
        float outFov = fov;
        if (bestDist < desired * 0.85f)
            outFov = Mathf.Min(85f, 2f * Mathf.Rad2Deg * Mathf.Atan(Mathf.Tan(vHalf) * desired / Mathf.Max(bestDist, 0.1f)));
        return new JObject {
            ["position"] = new JArray(pos.x, pos.y, pos.z),
            ["rotation"] = new JArray(rot.x, rot.y, rot.z, rot.w),
            ["fov"] = outFov,
            ["center"] = new JArray(b.center.x, b.center.y, b.center.z),
            ["radius"] = radius,
            ["distance"] = bestDist,
            ["clear"] = clearFound,
            ["probes"] = probeCount,
            ["desired"] = desired,
            ["path"] = PathOf(go.transform)
        };
    }

    /** Copies static meshes and terrains near centre into the probe scene as colliders, skipping the target. */
    static int BuildProbe(Scene probe, Vector3 centre, float range, Transform target)
    {
        float r2 = range * range;
        int count = 0;
        foreach (var mf in UnityEngine.Object.FindObjectsByType<MeshFilter>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
        {
            var mr = mf.GetComponent<MeshRenderer>();
            if (mr == null || !mr.enabled || mf.sharedMesh == null) continue;
            if (mf.transform.IsChildOf(target)) continue;
            if (mr.bounds.SqrDistance(centre) > r2) continue;
            if (mr.bounds.size.magnitude < 0.4f) continue;
            var copy = new GameObject("probe") { hideFlags = HideFlags.HideAndDontSave };
            SceneManager.MoveGameObjectToScene(copy, probe);
            copy.transform.SetPositionAndRotation(mf.transform.position, mf.transform.rotation);
            copy.transform.localScale = mf.transform.lossyScale;
            copy.AddComponent<MeshCollider>().sharedMesh = mf.sharedMesh;
            count++;
        }
        foreach (var t in Terrain.activeTerrains)
        {
            if (t == null || t.terrainData == null) continue;
            var copy = new GameObject("probe-terrain") { hideFlags = HideFlags.HideAndDontSave };
            SceneManager.MoveGameObjectToScene(copy, probe);
            copy.transform.position = t.transform.position;
            copy.AddComponent<TerrainCollider>().terrainData = t.terrainData;
            count++;
        }
        return count;
    }

    static readonly Collider[] overlapBuffer = new Collider[4];

    /** Distance from origin along dir to the first obstacle in the probe scene. */
    static float ClearDistance(PhysicsScene phys, Vector3 origin, Vector3 dir, float max, float sightRadius)
    {
        float nearest = max;
        if (phys.SphereCast(origin, sightRadius, dir, out var hit, max, ~0, QueryTriggerInteraction.Ignore) && hit.distance > 0f)
            nearest = hit.distance;
        // Mesh colliders are single-sided: also cast back from the camera spot so walls facing the camera count.
        for (int i = 0; i < 3 && nearest > 0.5f; i++)
        {
            var from = origin + dir * nearest;
            if (!phys.SphereCast(from, sightRadius, -dir, out var back, nearest - 0.05f, ~0, QueryTriggerInteraction.Ignore)) break;
            nearest = Mathf.Max(0f, nearest - back.distance - 0.05f);
        }
                var camera = origin + dir * Mathf.Max(0f, nearest - 0.4f);
        // Keep the camera away from walls beside it, which would fill half the frame.
        if (phys.OverlapSphere(camera, Mathf.Max(0.6f, sightRadius), overlapBuffer, ~0, QueryTriggerInteraction.Ignore) > 0) return 0f;
        return nearest;
    }

    /// <summary>
    /// Sets the shader time globals as URP does, for a fixed time instead of the wall clock.
    /// </summary>
    static void SetShaderTime(UnsafeCommandBuffer cmd, float time, float delta)
    {
        float last = time - delta;
        cmd.SetGlobalVector("_Time", time * new Vector4(1f / 20f, 1f, 2f, 3f));
        cmd.SetGlobalVector("_SinTime", new Vector4(Mathf.Sin(time / 8f), Mathf.Sin(time / 4f), Mathf.Sin(time / 2f), Mathf.Sin(time)));
        cmd.SetGlobalVector("_CosTime", new Vector4(Mathf.Cos(time / 8f), Mathf.Cos(time / 4f), Mathf.Cos(time / 2f), Mathf.Cos(time)));
        cmd.SetGlobalVector("unity_DeltaTime", new Vector4(delta, 1f / delta, delta, 1f / delta));
        cmd.SetGlobalVector("_TimeParameters", new Vector4(time, Mathf.Sin(time), Mathf.Cos(time), 0f));
        cmd.SetGlobalVector("_LastTimeParameters", new Vector4(last, Mathf.Sin(last), Mathf.Cos(last), 0f));
    }

    /// <summary>
    /// Outside Play mode, URP feeds shaders the wall-clock time, so wind and other animated shaders would advance by
    /// however long each capture frame took to render. This pass replaces that time with the frame's time in the clip.
    /// URP re-applies its time with the camera properties several times per camera, so the pass runs after each of those.
    /// </summary>
    class FixedTimePass : ScriptableRenderPass
    {
        class PassData { public float time; public float delta; }
        public float ShaderTime;
        public float Delta = 1f / 30f;
        public FixedTimePass(RenderPassEvent e) { renderPassEvent = e; }
        public override void RecordRenderGraph(RenderGraph renderGraph, ContextContainer frameData)
        {
            using (var builder = renderGraph.AddUnsafePass<PassData>("Devlog fixed shader time", out var data))
            {
                data.time = ShaderTime;
                data.delta = Delta;
                builder.AllowPassCulling(false);
                builder.AllowGlobalStateModification(true);
                builder.SetRenderFunc((PassData d, UnsafeGraphContext ctx) => SetShaderTime(ctx.cmd, d.time, d.delta));
            }
        }
    }

    static readonly RenderPassEvent[] TimeEvents = {
        RenderPassEvent.BeforeRenderingShadows,
        RenderPassEvent.AfterRenderingShadows,
        RenderPassEvent.BeforeRenderingPrePasses,
        RenderPassEvent.AfterRenderingPrePasses,
        RenderPassEvent.BeforeRenderingOpaques,
    };

    static JObject Render(JObject req)
    {
        int w = (int)req["width"], h = (int)req["height"];
        int ss = Mathf.Clamp((int?)req["supersample"] ?? 2, 1, 3);
        var poses = (JArray)req["poses"];
        var pattern = (string)req["outPattern"];
        int start = (int?)req["startIndex"] ?? 0;
        var src = SourceCamera((string)req["sourceCamera"]);
        // Frame i of the clip shows shader time timeStart + i / fps, however long rendering takes.
        float fps = Mathf.Max(1f, (float?)req["fps"] ?? 30f);
        float timeStart = (float?)req["shaderTimeStart"] ?? 10f;
        var timePasses = new List<FixedTimePass>();
        foreach (var e in TimeEvents) timePasses.Add(new FixedTimePass(e) { Delta = 1f / fps });
        Camera captureCam = null;
        Action<ScriptableRenderContext, Camera> injectTime = (ctx, c) =>
        {
            if (c != captureCam) return;
            var renderer = c.GetUniversalAdditionalCameraData().scriptableRenderer;
            foreach (var pass in timePasses) renderer.EnqueuePass(pass);
        };
        RenderPipelineManager.beginCameraRendering += injectTime;

        var go = new GameObject("DevlogCaptureCamera") { hideFlags = HideFlags.HideAndDontSave };
        var big = new RenderTexture(w * ss, h * ss, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        var small = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        var tex = new Texture2D(w, h, TextureFormat.RGB24, false, false);
        var written = new JArray();
        try
        {
            var cam = go.AddComponent<Camera>();
            captureCam = cam;
            if (src != null) cam.CopyFrom(src);
            cam.enabled = false;
            cam.targetTexture = big;
            var data = cam.GetUniversalAdditionalCameraData();
            var srcData = src != null ? src.GetComponent<UniversalAdditionalCameraData>() : null;
            data.renderPostProcessing = srcData == null || srcData.renderPostProcessing;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            data.antialiasingQuality = AntialiasingQuality.High;
            data.renderShadows = true;
            if (srcData != null) { data.volumeLayerMask = srcData.volumeLayerMask; data.volumeTrigger = null; }

            for (int i = 0; i < poses.Count; i++)
            {
                var p = (JObject)poses[i];
                var pa = (JArray)p["position"]; var ra = (JArray)p["rotation"];
                go.transform.SetPositionAndRotation(
                    new Vector3((float)pa[0], (float)pa[1], (float)pa[2]),
                    new Quaternion((float)ra[0], (float)ra[1], (float)ra[2], (float)ra[3]));
                cam.fieldOfView = (float?)p["fov"] ?? cam.fieldOfView;
                cam.aspect = (float)w / h;
                foreach (var pass in timePasses) pass.ShaderTime = timeStart + (start + i) / fps;
                cam.Render();
                Graphics.Blit(big, small);
                var prev = RenderTexture.active;
                RenderTexture.active = small;
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply(false);
                RenderTexture.active = prev;
                var file = string.Format(pattern, start + i);
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                File.WriteAllBytes(file, tex.EncodeToPNG());
                written.Add(file);
            }
        }
        finally
        {
            RenderPipelineManager.beginCameraRendering -= injectTime;
            UnityEngine.Object.DestroyImmediate(go);
            UnityEngine.Object.DestroyImmediate(tex);
            big.Release(); UnityEngine.Object.DestroyImmediate(big);
            small.Release(); UnityEngine.Object.DestroyImmediate(small);
        }
        return new JObject { ["files"] = written };
    }
}`;

async function capture<T>(request: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
  const expectedDataPath = config().unity.projectPath.replace(/\\/g, "/").replace(/\/$/, "") + "/Assets";
  const json = JSON.stringify({ ...request, expectedDataPath }).replace(/"/g, '""');
  const code = CAPTURE_CS.replace("__REQUEST__", json);
  const out = await executeCSharp(code, "DevlogCapture", "Run", timeoutMs);
  return JSON.parse(out) as T;
}

function assertOutsideProject(file: string) {
  const project = path.resolve(config().unity.projectPath).toLowerCase();
  if (path.resolve(file).toLowerCase().startsWith(project + path.sep)) {
    throw new Error(`Refusing to write capture output inside the Unity project: ${file}`);
  }
}

/** The Scene view camera, with the first surface in the middle of the view as pivot (20 m ahead when nothing is hit). */
export const sceneViewPose = () => capture<Pose & { pivot: [number, number, number]; pivotObject?: string; scene: string }>({ op: "sceneViewPose" });
export const cameraPose = (camera?: string) => capture<Pose>({ op: "cameraPose", camera });
export interface SceneObject {
  name: string;
  path: string;
  scene: string;
  active: boolean;
  childCount: number;
}

export const findObjects = (query: string, limit = 25) => capture<SceneObject[]>({ op: "find", query, limit });
/** Objects selected in the editor's Hierarchy or Scene view. */
export const selectedObjects = () => capture<SceneObject[]>({ op: "selection" });
/** Root objects of loaded scenes for an empty path, otherwise the object's children. */
export const childObjects = (path: string) => capture<SceneObject[]>({ op: "children", path });

export interface Framing extends Pose {
  center: [number, number, number];
  radius: number;
  distance: number;
  /** False when no unobstructed angle exists; the shot likely needs manual framing. */
  clear: boolean;
  path: string;
}

export const frameTarget = (opts: {
  target: string;
  aspect: number;
  fov?: number;
  /** Absolute camera yaw in degrees; wins over yawOffset. */
  yaw?: number;
  /** Camera yaw relative to the target's facing; 180 looks at its front. */
  yawOffset?: number;
  pitch?: number;
  padding?: number;
  /** Orbit sweep in degrees that must stay clear of obstacles. */
  sweep?: number;
}) => capture<Framing>({ op: "frame", ...opts });

export async function renderPoses(opts: {
  poses: Pose[];
  width: number;
  height: number;
  outPattern: string;
  supersample?: number;
  sourceCamera?: string;
  /** Frame rate of the clip: frame i shows shader time shaderTimeStart + i / fps. */
  fps?: number;
  shaderTimeStart?: number;
}): Promise<string[]> {
  assertOutsideProject(opts.outPattern);
  const files: string[] = [];
  // Small batches keep the editor responsive and each MCP call well under its timeout.
  const batch = opts.width * opts.height > 2_500_000 ? 8 : 16;
  for (let i = 0; i < opts.poses.length; i += batch) {
    throwIfCancelled();
    const res = await capture<{ files: string[] }>({
      op: "render",
      poses: opts.poses.slice(i, i + batch),
      width: opts.width,
      height: opts.height,
      supersample: opts.supersample ?? 2,
      outPattern: opts.outPattern.replace(/\\/g, "/"),
      startIndex: i,
      sourceCamera: opts.sourceCamera,
      fps: opts.fps ?? 30,
      shaderTimeStart: opts.shaderTimeStart ?? 10,
    });
    files.push(...res.files);
  }
  return files;
}

