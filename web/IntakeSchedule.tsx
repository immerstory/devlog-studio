import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings-section";
import type { IntakeSchedule, IntakeState } from "../shared/projects";
import { api, useJob } from "./api";

const DEFAULT: IntakeSchedule = { enabled: false, time: "06:00", propose: false, review: false };
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

function LastRun({ state }: { state: IntakeState | null }) {
  if (!state?.startedAt) return <>No run yet.</>;
  if (state.status === "running") return <>Running since {when(state.startedAt)}.</>;
  if (state.status === "failed") return <>The run of {when(state.startedAt)} failed: {state.errors?.join(" ") || "no details"}</>;
  return <>Last run {when(state.finishedAt ?? state.startedAt)}.</>;
}

/** The project's daily intake. The steps that call an agent are off until the developer ticks them. */
export function IntakeScheduleSection({ value, saved, hasFeeds, onChange }: { value?: IntakeSchedule; saved?: IntakeSchedule; hasFeeds: boolean; onChange: (schedule: IntakeSchedule) => void }) {
  const schedule = { ...DEFAULT, ...value };
  const set = (patch: Partial<IntakeSchedule>) => onChange({ ...schedule, ...patch });
  const [info, setInfo] = useState<{ state: IntakeState | null; next: string | null } | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<{ state: IntakeState | null; next: string | null }>("/api/intake").then(setInfo, () => setInfo(null));
  const job = useJob(() => void load());
  useEffect(() => { void load(); }, [saved?.enabled, saved?.time]);
  const unsaved = JSON.stringify({ ...DEFAULT, ...saved }) !== JSON.stringify(schedule);
  return (
    <SettingsSection
      title="Daily intake"
      description="Refreshes the activity once a day, and can also propose suggestions and review sessions. It runs only while the app runs. A time missed while the app is off runs once after the next start, unless the next time is at most an hour away."
      action={<Button variant="outline" size="sm" disabled={job.running || unsaved} title={unsaved ? "Save the project settings first" : "Runs the saved steps now"} onClick={() => { setErr(""); job.start("/api/intake/run").then(() => load(), (e: Error) => setErr(e.message)); }}>{job.running ? "Running…" : "Run now"}</Button>}
    >
      <div className="row">
        <label className="check"><input type="checkbox" checked={schedule.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Run every day at</label>
        <input type="time" aria-label="Time of day" value={schedule.time} onChange={(e) => set({ time: e.target.value })} />
      </div>
      <p className="field-hint">Every run refreshes activity: commits, connected sources, session digests and, where turned on, the screenshots you sent. This step calls no agent.</p>
      <label className="check"><input type="checkbox" checked={schedule.propose} onChange={(e) => set({ propose: e.target.checked })} />Propose changes since last check</label>
      <p className="field-hint">Calls the default agent when there is new work, and its provider bills the run.</p>
      {hasFeeds ? (
        <>
          <label className="check"><input type="checkbox" checked={!!schedule.feeds} onChange={(e) => set({ feeds: e.target.checked })} />Propose from feeds</label>
          <p className="field-hint">Calls the default agent once per new feed entry of the last seven days.</p>
        </>
      ) : null}
      <label className="check"><input type="checkbox" checked={schedule.review} onChange={(e) => set({ review: e.target.checked })} />Review with sessions</label>
      <p className="field-hint">Reviews each complete week of the last four that isn't reviewed yet, with one agent call per week. A week is reviewed after it ends, on the Monday run.</p>
      <p className="muted small">
        <LastRun state={info?.state ?? null} />
        {info?.next ? ` Next run ${when(info.next)}.` : ""}
      </p>
      {err ? <div className="error small">{err}</div> : null}
    </SettingsSection>
  );
}
