import { useCallback, useEffect, useRef, useState } from "react";
import type { Post, Material, Note, Suggestion } from "../shared/types";

export interface Job {
  id: string;
  kind: string;
  subject?: string;
  status: "running" | "done" | "failed" | "cancelled";
  log: string[];
  error?: string;
  result?: unknown;
  projectId?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface PostSummary {
  id: string;
  title: string;
  stage: Post["stage"];
  publishDate?: string;
  outputs: Post["outputs"];
  createdAt: string;
  suggestionIds: string[];
}

export interface AppState {
  snapshot?: Record<string, { commit: string; takenAt: string }>;
  suggestions: Suggestion[];
  notes: Note[];
  materials: Material[];
  posts: PostSummary[];
  settings: { agent: "claude" | "codex"; voiceSet: boolean; elevenLabsKey: boolean; gameTitle: string; outputs: Array<"portrait" | "landscape"> };
}

let activeProject: { id: string; slug: string } | undefined;
export function setActiveProject(project?: { id: string; slug: string }) { activeProject = project; }
export function projectHref(path = "/calendar") { return activeProject ? `#/p/${activeProject.slug}${path}` : "#/"; }
export function apiUrl(url: string) {
  const bumperAudio = /^\/api\/project-bumper-audio\/(intro|outro)$/.exec(url);
  if (activeProject && bumperAudio) return `/api/projects/${activeProject.id}/settings/bumper-audio/${bumperAudio[1]}`;
  if (!activeProject || !/^\/api\/(state|discover|backfill|session-review|session-images|intake|git|theme-preview|theme|notes|suggestions|materials|posts|publications|activity|unity|stats|open|project-config)(\/|\?|$)/.test(url)) return url;
  return `/api/projects/${activeProject.id}/${url.slice(5).replace(/^project-config/, "settings/runtime")}`;
}

export async function api<T = unknown>(url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

/** Polls a job until it finishes, then calls onDone. */
export function useJob(onDone?: (job: Job) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const j = await api<Job | null>(`/api/jobs/${job.id}`).catch(() => null);
      if (!j) return;
      setJob(j);
      if (j.status !== "running") doneRef.current?.(j);
    }, 1000);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);
  const start = useCallback(async (url: string, body?: unknown) => {
    const j = await api<Job>(url, "POST", body ?? {});
    setJob(j);
    return j;
  }, []);
  return { job, start, running: job?.status === "running" };
}

export const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** URL of a stored object (material, capture, render). */
export const mediaUrl = (key: string) => `/media/${key.split("/").map(encodeURIComponent).join("/")}`;
