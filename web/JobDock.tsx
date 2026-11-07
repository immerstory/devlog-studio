import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Spinner } from "@/components/ui/spinner";
import { api, type Job } from "./api";

/** Fired on window when a task the dock watched finishes; detail is the finished job. */
export const JOB_FINISHED = "devlog:job-finished";

const KIND_LABEL: Record<string, string> = {
  discover: "Progress check",
  publish: "Publishing",
  activity: "Refreshing activity",
  summarize: "Summarizing a session",
  sessionImages: "Importing screenshots",
  social: "Writing a post",
  article: "Writing an article",
  verify: "Checking co-host lines",
  backfill: "Backfill",
  sessionReview: "Review with sessions",
  storyDraft: "Writing a draft",
  questions: "Questions",
  script: "Script",
  capture: "Capture",
  narrate: "Narration",
  render: "Render",
  upload: "Upload",
  stats: "Statistics",
};

/** Finished tasks stay this long unless they failed; failed ones stay until dismissed. */
const KEEP_DONE_MS = 2 * 60_000;

const elapsed = (job: Job, now: number) => {
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`;
};

const RUNNING_KEY = "devlog.runningJobs";
/** Running tasks as last seen, without their logs beyond the last few lines. */
function loadRunning(): Job[] {
  try {
    return JSON.parse(localStorage.getItem(RUNNING_KEY) ?? "[]") as Job[];
  } catch {
    return [];
  }
}
function saveRunning(jobs: Job[]) {
  try {
    localStorage.setItem(RUNNING_KEY, JSON.stringify(jobs.map((j) => ({ ...j, log: j.log.slice(-20), result: undefined }))));
  } catch {
    /* not remembered */
  }
}

/** The log of one task, kept scrolled to the newest line unless the reader scrolled up. */
function JobLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      ref={ref}
      className="job-dock-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}

/**
 * Floating terminal box for background tasks: captures, scripts, renders, uploads and checks of every
 * project. It appears while a task runs and keeps finished ones briefly, so the rest of the app stays
 * usable while work continues on the server.
 */
export function JobDock({ titleFor }: { titleFor: (job: Job) => string | undefined }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Kept in the browser too, so a task that a server restart ended is still reported after the page reloads.
  const seenRunning = useRef(new Map<string, Job>(loadRunning().map((j) => [j.id, j])));
  /** Tasks that vanished while running: the server keeps tasks in memory, so a restart ends them. */
  const [lost, setLost] = useState<Job[]>([]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const all = await api<Job[]>("/api/jobs").catch(() => null);
      if (stop) return;
      if (all) {
        for (const j of all) {
          if (j.status === "running") seenRunning.current.set(j.id, j);
          else if (seenRunning.current.delete(j.id)) window.dispatchEvent(new CustomEvent(JOB_FINISHED, { detail: j }));
        }
        const ids = new Set(all.map((j) => j.id));
        const vanished = [...seenRunning.current.values()].filter((j) => !ids.has(j.id));
        if (vanished.length) {
          const ended = new Date().toISOString();
          const failed = vanished.map((j): Job => ({ ...j, status: "failed", error: "The server restarted, which stopped this task. Start it again.", finishedAt: ended }));
          for (const j of failed) {
            seenRunning.current.delete(j.id);
            window.dispatchEvent(new CustomEvent(JOB_FINISHED, { detail: j }));
          }
          setLost((l) => [...l, ...failed]);
        }
        setJobs(all);
        saveRunning([...seenRunning.current.values()]);
      }
      setNow(Date.now());
      // Poll quickly while something runs; otherwise just often enough to notice tasks started elsewhere.
      timer = setTimeout(tick, all?.some((j) => j.status === "running") ? 1000 : 3000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  const visible = [...jobs, ...lost]
    .filter((j) => !dismissed.has(j.id))
    .filter((j) => j.status === "running" || j.status === "failed" || (j.finishedAt && now - Date.parse(j.finishedAt) < KEEP_DONE_MS))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!visible.length) return null;
  const running = visible.filter((j) => j.status === "running").length;
  const dismiss = (ids: string[]) => setDismissed((d) => new Set([...d, ...ids]));

  return (
    <div className={`job-dock ${collapsed ? "collapsed" : ""}`} role="status" aria-live="polite">
      <div className="job-dock-head">
        {running ? <Spinner className="size-3.5" /> : <HugeiconsIcon icon={Tick02Icon} className="size-3.5" />}
        <span className="grow">{running ? `${running} task${running === 1 ? "" : "s"} running` : "Tasks finished"}</span>
        {visible.some((j) => j.status !== "running") ? (
          <button className="job-dock-btn" title="Hide finished tasks" onClick={() => dismiss(visible.filter((j) => j.status !== "running").map((j) => j.id))}>
            Clear
          </button>
        ) : null}
        <button className="job-dock-btn" title={collapsed ? "Show tasks" : "Minimise"} onClick={() => setCollapsed(!collapsed)}>
          <HugeiconsIcon icon={collapsed ? ArrowUp01Icon : ArrowDown01Icon} className="size-3.5" />
        </button>
      </div>
      {collapsed
        ? null
        : visible.map((j) => {
            const title = titleFor(j);
            const last = j.status === "failed" ? `Failed: ${j.error ?? "unknown error"}` : j.log.at(-1)?.replace(/^\S+\s/, "") ?? "Starting…";
            const cancelling = j.status === "running" && j.log.at(-1)?.endsWith("Cancelling…");
            return (
              <div key={j.id} className={`job-dock-item ${j.status}`}>
                <div className="job-dock-row" onClick={() => setOpen(open === j.id ? null : j.id)} title="Show the log">
                  <span className="job-dock-state">
                    {j.status === "running" ? <Spinner className="size-3.5" /> : j.status === "done" ? <HugeiconsIcon icon={Tick02Icon} className="size-3.5" /> : <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />}
                  </span>
                  <span className="job-dock-text">
                    <span className="job-dock-title">
                      {KIND_LABEL[j.kind] ?? j.kind}
                      {title ? <span className="job-dock-subject"> · {title}</span> : null}
                    </span>
                    <span className="job-dock-last">{last}</span>
                  </span>
                  <span className="job-dock-time">{elapsed(j, now)}</span>
                  {j.status === "running" ? (
                    <button
                      className="job-dock-btn job-dock-cancel"
                      title="Stop this task at its next step; finished parts are kept"
                      disabled={cancelling}
                      onClick={(e) => { e.stopPropagation(); void api(`/api/jobs/${j.id}/cancel`, "POST").catch(() => {}); }}
                    >
                      {cancelling ? "Stopping…" : "Cancel"}
                    </button>
                  ) : (
                    <button className="job-dock-btn" title="Hide" onClick={(e) => { e.stopPropagation(); dismiss([j.id]); }}>
                      <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
                    </button>
                  )}
                </div>
                {open === j.id ? <JobLog lines={j.log} /> : null}
              </div>
            );
          })}
    </div>
  );
}
