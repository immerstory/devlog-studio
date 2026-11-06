import type { CaptureTarget, ProjectSettings } from "../../shared/projects.js";
import type { CaptureVisual, Format, MotionType, Pose, Vec3 } from "../../shared/types.js";
import { inContext } from "../context.js";
import { getProject } from "../projects.js";
import { unityProvider } from "./unity/index.js";
import { browserProvider } from "./browser/index.js";
import type { SceneObject } from "./unity/client.js";

export type Log = (line: string) => void;
export interface CaptureOutput { dir: string; format: Format; frames: number; fps: number }
export interface CaptureResult { file: string; poster?: string; durationSeconds?: number; warning?: string }
export interface CaptureProvider<TConfig, TShot> {
  kind: "unity-mcp" | "unreal" | "browser";
  shotModel: "scene" | "page";
  capabilities: { objects: boolean; selection: boolean; viewPose: boolean; motions: MotionType[]; video: boolean };
  resourceKey(target: TConfig): string;
  status(target: TConfig): Promise<{ ok: boolean; detail: string }>;
  promptRules(target: TConfig): string;
  /** Render and query operations verify the resource as part of their own requests. */
  render(target: TConfig, shot: TShot, out: CaptureOutput, log: Log): Promise<CaptureResult>;
  findObjects?(target: TConfig, query: string, limit: number): Promise<SceneObject[]>;
  children?(target: TConfig, path: string): Promise<SceneObject[]>;
  selection?(target: TConfig): Promise<SceneObject[]>;
  viewPose?(target: TConfig): Promise<Pose & { pivot?: Vec3; pivotObject?: string }>;
}
// Each provider checks that a target's kind and a shot's model match before it gets them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const providers = new Map<string, CaptureProvider<any, any>>([["unity-mcp", unityProvider], ["browser", browserProvider]]);
/** A Unity target without its own project path expects the primary source. */
function withProjectPath(target: CaptureTarget, settings: ProjectSettings): CaptureTarget {
  if (target.kind !== "unity-mcp" || target.config.projectPath) return target;
  return { ...target, config: { ...target.config, projectPath: settings.sources.find((s) => s.id === settings.primarySourceId)!.path } };
}
export function providerFor(target: CaptureTarget) {
  const provider = providers.get(target.kind);
  if (!provider) throw new Error(`Capture provider ${target.kind} is not available`);
  return provider;
}
const locks = new Map<string, Promise<void>>();
/** Queue by physical resource, shared across projects and all browsing/render operations. */
export async function withResourceLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => ticket);
  locks.set(key, tail);
  await previous;
  try { return await work(); }
  finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
export function resolveTarget(id?: string) {
  const p = getProject().settings;
  const target = p.captureTargets.find((t) => t.id === (id ?? p.defaultCaptureTargetId));
  if (!target) throw Object.assign(new Error("Configure a capture target in Project settings"), { status: 404 });
  return target;
}
async function withTarget<T>(id: string | undefined, work: (target: CaptureTarget, provider: ReturnType<typeof providerFor>) => Promise<T>) {
  return withResolvedTarget(withProjectPath(resolveTarget(id), getProject().settings), work);
}
async function withResolvedTarget<T>(target: CaptureTarget, work: (target: CaptureTarget, provider: ReturnType<typeof providerFor>) => Promise<T>) {
  const provider = providerFor(target);
  return withResourceLock(`${provider.kind}:${provider.resourceKey(target.config)}`, () => inContext({ targetId: target.id, captureConfig: target.config }, () => work(target, provider)));
}
function renderTarget(target: CaptureTarget, visual: CaptureVisual, out: CaptureOutput, log: Log) {
  return withResolvedTarget(target, async (target, provider) => {
    if (provider.shotModel !== visual.shot.model) throw new Error("Shot model does not match the capture target");
    return provider.render(target.config, visual.shot, out, log);
  });
}
/** Resolve defaults and configuration once for every segment in a capture job. */
export function createCaptureSession(settings: ProjectSettings = getProject().settings) {
  const defaultId = settings.defaultCaptureTargetId;
  const targets = new Map(settings.captureTargets.map((configured) => [configured.id, withProjectPath(structuredClone(configured), settings)] as const));
  return {
    async render(visual: CaptureVisual, out: CaptureOutput, log: Log) {
      const target = targets.get(visual.targetId ?? defaultId ?? "");
      if (!target) throw Object.assign(new Error("Configure a capture target in Project settings"), { status: 404 });
      return renderTarget(target, visual, out, log);
    },
  };
}
export async function renderCapture(visual: CaptureVisual, out: CaptureOutput, log: Log) {
  return createCaptureSession().render(visual, out, log);
}
export function captureOperation(id: string | undefined, op: "status"): Promise<{ ok: boolean; detail: string }>;
export function captureOperation(id: string | undefined, op: "view"): Promise<Pose & { pivot?: Vec3; pivotObject?: string }>;
export function captureOperation(id: string | undefined, op: "objects" | "children" | "selection", query?: string, limit?: number): Promise<SceneObject[]>;
export function captureOperation(id: string | undefined, op: "status" | "view" | "objects" | "children" | "selection", query?: string, limit?: number): Promise<{ ok: boolean; detail: string } | (Pose & { pivot?: Vec3 }) | SceneObject[]>;
export function captureOperation(id: string | undefined, op: string, query = "", limit = 40) {
  return withTarget(id, async (target, provider) => {
    if (op === "status") return provider.status(target.config);
    if (op === "objects" && provider.findObjects) return provider.findObjects(target.config, query, limit);
    if (op === "children" && provider.children) return provider.children(target.config, query);
    if (op === "selection" && provider.selection) return provider.selection(target.config);
    if (op === "view" && provider.viewPose) return provider.viewPose(target.config);
    throw Object.assign(new Error("This capture target does not support that operation"), { status: 400 });
  });
}
export function capturePromptRules(targets: CaptureTarget[]) {
  if (!targets.length) return "No capture targets are configured. Use materials and slides only.";
  return targets.map((t) => `${t.label} [targetId: ${t.id}, shotModel: ${providerFor(t).shotModel}]: ${providerFor(t).promptRules(t.config)}`).join("\n");
}
