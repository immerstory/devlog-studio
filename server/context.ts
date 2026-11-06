import { AsyncLocalStorage } from "node:async_hooks";
import type { CaptureTarget } from "../shared/projects.js";

export interface RequestContext { projectId?: string; sourceId?: string; targetId?: string; connectionId?: string; captureConfig?: CaptureTarget["config"] }
const context = new AsyncLocalStorage<RequestContext>();
export const currentContext = () => context.getStore() ?? {};
export function projectId(): string {
  const id = currentContext().projectId;
  if (!id) throw new Error("A project is required");
  return id;
}
export function inContext<T>(values: RequestContext, work: () => T): T {
  return context.run({ ...currentContext(), ...values }, work);
}
