import { newId } from "./store.js";
import { projectWrite } from "./store.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { currentContext } from "./context.js";

export interface Job {
  projectId?: string;
  id: string;
  kind: string;
  /** Post or other subject the job works on. */
  subject?: string;
  status: "running" | "done" | "failed" | "cancelled";
  log: string[];
  error?: string;
  /** What the work returned, for the UI to act on (e.g. a created suggestion's id). */
  result?: unknown;
  startedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
/** The cancellation signal of the job whose work is running, reachable from anywhere inside it. */
const jobSignal = new AsyncLocalStorage<AbortSignal>();

export class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
  }
}
/** Signal of the current job, for work that can stop early (child processes, renders, requests). */
export const currentJobSignal = () => jobSignal.getStore();
/** Throws CancelledError when the current job was cancelled; long loops call it between steps. */
export function throwIfCancelled() {
  if (jobSignal.getStore()?.aborted) throw new CancelledError();
}
/** Asks a running job to stop; it ends at its next check. */
export function cancelJob(id: string): Job | undefined {
  const job = jobs.get(id);
  if (job?.status === "running") {
    controllers.get(id)?.abort();
    job.log.push(`${new Date().toLocaleTimeString()} Cancelling…`);
  }
  return job;
}
const MAX_LOG = 400;

/** Starts background work; one running job per subject+kind. */
export async function startJob(kind: string, subject: string | undefined, work: (log: (line: string) => void) => Promise<unknown>): Promise<Job> {
  const pid = currentContext().projectId;
  if (pid) return projectWrite(pid, () => Promise.resolve(registerJob(kind, `${pid}:${subject ?? "project"}`, work, pid)));
  return registerJob(kind, subject, work);
}
function registerJob(kind: string, subject: string | undefined, work: (log: (line: string) => void) => Promise<unknown>, projectId?: string): Job {
  const existing = [...jobs.values()].find((j) => j.status === "running" && j.kind === kind && j.subject === subject);
  if (existing) return existing;
  const job: Job = { id: newId("job"), projectId, kind, subject, status: "running", log: [], startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  const log = (line: string) => {
    job.log.push(`${new Date().toLocaleTimeString()} ${line}`);
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  };
  const controller = new AbortController();
  controllers.set(job.id, controller);
  jobSignal.run(controller.signal, () => Promise.resolve().then(() => work(log)))
    .then((result) => {
      // Work that completes despite a cancel request is done: its results are saved.
      job.result = result;
      job.status = "done";
      log("Done.");
    })
    .catch((err: Error) => {
      if (controller.signal.aborted) {
        job.status = "cancelled";
        log("Cancelled.");
      } else {
        job.status = "failed";
        job.error = err.message;
        log(`Failed: ${err.message}`);
      }
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      controllers.delete(job.id);
    });
  return job;
}

export const getJob = (id: string) => jobs.get(id);
export const listJobs = (subject?: string) =>
  [...jobs.values()].filter((j) => !subject || j.subject === subject).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
