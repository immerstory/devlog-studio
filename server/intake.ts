import type { IntakeSchedule, IntakeState } from "../shared/projects.js";
import { inContext, projectId } from "./context.js";
import { syncActivity } from "./ingress/sync.js";
import { CancelledError, getJob, startJob, throwIfCancelled } from "./jobs.js";
import { runDiscovery, runSessionReview } from "./pipeline.js";
import { getProject, listProjects } from "./projects.js";
import { getValue, setValue } from "./store.js";

const STATE = "intake:state";
const TICK_MS = 60_000;
const ACTIVITY_DAYS = 30;
const REVIEW_WEEKS = 4;
export const DEFAULT_INTAKE: IntakeSchedule = { enabled: false, time: "06:00", propose: false, review: false };
export const isIntakeTime = (time: unknown): time is string => typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const atTime = (day: Date, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
};

/** The latest time the schedule was due, at or before now. */
export function lastSlot(time: string, now = new Date()): Date {
  const today = atTime(now, time);
  return today <= now ? today : atTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1), time);
}
/** The next time the schedule is due after now. */
export function nextSlot(time: string, now = new Date()): Date {
  const today = atTime(now, time);
  return today > now ? today : atTime(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), time);
}
const CATCH_UP_GAP_MS = 3600_000;
/**
 * A day runs once. A missed time runs after the next start, and missed days before it don't add runs.
 * The catch-up waits when the next time is at most an hour away, and that run covers it.
 */
export const isDue = (time: string, state: IntakeState | undefined, now = new Date()) =>
  !!state && localDate(lastSlot(time, now)) > state.day && nextSlot(time, now).getTime() - now.getTime() > CATCH_UP_GAP_MS;

/** The four complete Monday-to-Sunday weeks before this week. A week in progress isn't reviewed, because a reviewed week is skipped later. */
export function reviewWeeks(now = new Date()): { from: string; to: string } {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const shift = (days: number) => localDate(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + days));
  return { from: shift(-7 * REVIEW_WEEKS), to: shift(-1) };
}

/** Runs the intake steps in order. A failing step doesn't stop the next, and the task fails at the end. */
export async function runIntake(schedule: IntakeSchedule, log: (line: string) => void, now = new Date()) {
  const errors: string[] = [];
  const step = async (name: string, work: () => Promise<unknown>) => {
    throwIfCancelled();
    log(`${name}…`);
    try {
      await work();
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      errors.push(`${name}: ${(err as Error).message}`);
      log(`${name} failed: ${(err as Error).message}`);
    }
  };
  await step("Refresh activity", async () => {
    const from = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - ACTIVITY_DAYS));
    const result = await syncActivity({ from }, log);
    if (result.errors.length) throw new Error(result.errors.join("; "));
  });
  if (schedule.propose) await step("Propose changes since last check", () => runDiscovery(log));
  if (schedule.review) await step("Review with sessions", () => { const weeks = reviewWeeks(now); return runSessionReview(weeks.from, weeks.to, false, log); });
  if (errors.length) throw new Error(errors.join(" "));
}

export const intakeState = (pid = projectId()) => getValue<IntakeState>(pid, STATE);

export async function intakeInfo() {
  const schedule = getProject(projectId()).settings.intake;
  const state = await intakeState();
  // A run the app stopped during has no task any more.
  if (state?.status === "running" && getJob(state.jobId ?? "")?.status !== "running") Object.assign(state, { status: "failed", errors: ["The app stopped during this run."] });
  return { state: state ?? null, next: schedule?.enabled && isIntakeTime(schedule.time) ? nextSlot(schedule.time).toISOString() : null };
}

/** Starts the project's intake as a task and records its outcome. A run on request keeps the day, so the scheduled run still comes. */
export async function startIntake(schedule: IntakeSchedule, due?: string) {
  const pid = projectId();
  const day = due ?? (await intakeState(pid))?.day ?? localDate(lastSlot(schedule.time));
  const job = await startJob("intake", "project", async (log) => {
    try {
      await runIntake(schedule, log);
      await setValue(pid, STATE, { ...(await intakeState(pid)), day, finishedAt: new Date().toISOString(), status: "done", errors: [] });
    } catch (err) {
      await setValue(pid, STATE, { ...(await intakeState(pid)), day, finishedAt: new Date().toISOString(), status: "failed", errors: [(err as Error).message] });
      throw err;
    }
  });
  await setValue(pid, STATE, { day, startedAt: job.startedAt, jobId: job.id, status: "running" } satisfies IntakeState);
  return job;
}

/** Called when a schedule is turned on: it waits for its next time, also when an old state says a day was missed. */
export async function armIntake(time: string, now = new Date()) {
  await setValue(projectId(), STATE, { ...(await intakeState()), day: localDate(lastSlot(time, now)) });
}

async function tickProject(now: Date) {
  const pid = projectId();
  const schedule = getProject(pid).settings.intake;
  if (!schedule?.enabled || !isIntakeTime(schedule.time)) return;
  const state = await intakeState(pid);
  const day = localDate(lastSlot(schedule.time, now));
  // A newly enabled schedule waits for its next time instead of running at once.
  if (!state) { await setValue(pid, STATE, { day } satisfies IntakeState); return; }
  if (isDue(schedule.time, state, now)) await startIntake(schedule, day);
}

let timer: NodeJS.Timeout | undefined;
/** Checks every minute while the app runs. A time missed while it's off runs once after the next start. */
export function scheduleIntake() {
  if (timer) clearInterval(timer);
  const tick = async () => {
    const now = new Date();
    for (const p of listProjects()) if (!p.deletion) await inContext({ projectId: p.id }, () => tickProject(now)).catch((err) => console.warn(`Intake: ${(err as Error).message}`));
  };
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
}
