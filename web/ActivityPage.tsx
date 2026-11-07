import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, mediaUrl, useJob } from "./api";
import { CommitLink, CommitList } from "./CommitLinks";
import type { ActivityLink, ActivityRecord, ActivityThread, SessionDigest } from "../shared/activity";

interface View { records: ActivityRecord[]; links: ActivityLink[]; threads: ActivityThread[] }
const KIND_LABEL: Record<ActivityRecord["kind"], string> = { commit: "Commit", workingChange: "Edit", session: "Session", pullRequest: "Pull request", issue: "Issue", release: "Release", note: "Note", material: "Material", feed: "Feed" };
const STRENGTH_LABEL = { exact: "Same commit", strong: "Same time and files", weak: "Same day", manual: "Your choice" };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400_000));

const SHOWN_PROMPTS = 5;

/**
 * Changes show at once, and the server's answer follows. Fresh data loads only after the last pending change, so
 * a slower answer can't bring back a record the developer just hid. A failed change restores what the server has.
 */
function useActivityActions(setView: React.Dispatch<React.SetStateAction<View | null>>, load: () => Promise<void>, setErr: (message: string) => void) {
  const pending = useRef(0);
  const act = useCallback(async (work: () => Promise<unknown>) => {
    setErr("");
    pending.current++;
    try {
      await work();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      pending.current--;
      if (!pending.current) await load();
    }
  }, [load, setErr]);
  const changeVisibility = useCallback((id: string, visibility: ActivityRecord["visibility"]) => {
    setView((v) => v && { ...v, records: v.records.map((r) => (r.id === id ? { ...r, visibility, visibilityChosen: true } : r)) });
    void act(() => api(`/api/activity/records/${encodeURIComponent(id)}`, "PATCH", { visibility }));
  }, [act, setView]);
  return { act, changeVisibility };
}

/** Excluded records stay out of sight until asked for. */
function ExcludedToggle({ count, show, onChange }: { count: number; show: boolean; onChange: (show: boolean) => void }) {
  if (!count) return null;
  return <label className="check small"><input type="checkbox" checked={show} onChange={(e) => onChange(e.target.checked)} />Show {count} excluded</label>;
}

/** What a session was about comes first: its prompts. The rest stays one click away. */
function SessionDetail({ record, onChange }: { record: ActivityRecord; onChange: () => void }) {
  const d = record.detail as SessionDigest;
  const jobs = useJob(() => onChange());
  // An untitled session's heading is already its first prompt.
  const prompts = d.sessionTitle ? d.prompts : d.prompts.slice(1);
  const other = d.otherFiles?.length ?? 0;
  if (record.visibility === "excluded") {
    return <p className="muted small">{record.visibilityChosen ? "You excluded this session." : `Looks like other work: ${other} edited file${other === 1 ? " is" : "s are"} outside this project's sources.`} No agent sees it.</p>;
  }
  return (
    <>
      {prompts.length ? (
        <ul className="activity-prompts">
          {prompts.slice(0, SHOWN_PROMPTS).map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      ) : null}
      {d.aiSummary ? (
        <div className="small">
          <p><strong>Attempted:</strong> {d.aiSummary.attempted || "–"}</p>
          <p><strong>Failed:</strong> {d.aiSummary.failed || "–"}</p>
          <p><strong>Changed course:</strong> {d.aiSummary.changedCourse || "–"}</p>
          <p><strong>Shipped:</strong> {d.aiSummary.shipped || "–"}</p>
        </div>
      ) : null}
      <details className="activity-detail">
        <summary>{d.activeMinutes.length} active min · {d.files.length} files · {d.commits.length} commits{prompts.length > SHOWN_PROMPTS ? ` · ${prompts.length - SHOWN_PROMPTS} more prompts` : ""}</summary>
        {prompts.length > SHOWN_PROMPTS ? <ul className="activity-prompts">{prompts.slice(SHOWN_PROMPTS).map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
        <p className="small"><strong>Files:</strong> {d.files.join(", ") || "–"}</p>
        <p className="small"><strong>Git:</strong> {d.commands.join(" ; ") || "–"}</p>
        {d.commits.length ? <CommitList commits={d.commits} /> : null}
        <p className="small"><strong>Checks:</strong> {d.checks.map((c) => `${c.ok ? "passed" : "failed"}: ${c.command}${c.error ? ` (${c.error})` : ""}`).join(" ; ") || "–"}</p>
        <Button variant="outline" size="xs" disabled={jobs.running} title="One agent run. It sends this digest to the provider of the selected agent." onClick={() => jobs.start(`/api/activity/records/${encodeURIComponent(record.id)}/summarize`)}>
          {d.aiSummary ? "Summarize again" : "Summarize"}
        </Button>
      </details>
    </>
  );
}

/** One record with its links and visibility controls. */
export function RecordCard({ record: r, view, act, changeVisibility }: { record: ActivityRecord; view: View; act: (work: () => Promise<unknown>) => void; changeVisibility: (id: string, visibility: ActivityRecord["visibility"]) => void }) {
  const byId = new Map(view.records.map((x) => [x.id, x]));
  const links = view.links.filter((l) => !l.split && l.a === r.id);
  const stored = !["note", "material"].includes(r.kind);
  const digest = r.kind === "session" ? (r.detail as SessionDigest) : undefined;
  // A record's title is short for lists of links. An untitled session shows its whole first prompt here.
  const heading = digest && !digest.sessionTitle && digest.prompts[0] ? digest.prompts[0] : r.title;
  const thumbKey = r.kind === "material" ? (r.detail as { thumbKey?: string } | undefined)?.thumbKey : undefined;
  const firm = links.filter((l) => l.strength !== "weak");
  const suggested = links.filter((l) => l.strength === "weak");
  const linkRow = (l: ActivityLink) => {
    const other = byId.get(l.a === r.id ? l.b : l.a);
    if (!other) return null;
    const strengthText = l.strength === "weak" ? other.title : `${STRENGTH_LABEL[l.strength]}: ${other.title}. ${l.reason}`;
    return (
      <div key={`${l.a}${l.b}`} className="muted small row">
        <span className="grow">{strengthText}</span>
        {l.strength === "weak" ? <Button variant="ghost" size="xs" onClick={() => act(() => api("/api/activity/links", "PUT", { a: l.a, b: l.b, split: false }))}>Join</Button> : <Button variant="ghost" size="xs" onClick={() => act(() => api("/api/activity/links", "PUT", { a: l.a, b: l.b, split: true }))}>Split</Button>}
      </div>
    );
  };
  const setVisibility = (visibility: ActivityRecord["visibility"]) => changeVisibility(r.id, visibility);
  return (
    <div className={`activity-record ${r.visibility}`}>
      <div className="row">
        <span className="activity-kind">{KIND_LABEL[r.kind]}</span>
        <span className="grow">{heading}</span>
        {r.kind === "commit" && r.refs.commits[0] ? <CommitLink commit={`${r.sourceId}:${r.refs.commits[0]}`} /> : null}
        {r.visibility === "private" ? <span className="muted small">Private</span> : null}
        {stored && r.visibility !== "excluded" ? <Button variant="ghost" size="xs" title="Never reaches an agent" onClick={() => setVisibility("excluded")}>Exclude</Button> : null}
        {stored && r.visibility === "excluded" ? <Button variant="ghost" size="xs" onClick={() => setVisibility(r.kind === "commit" ? "public" : "private")}>Include</Button> : null}
      </div>
      {r.kind === "session" ? <div className="activity-session"><SessionDetail record={r} onChange={() => act(async () => {})} /></div> : thumbKey || r.summary ? (
        <div className="activity-body">
          {thumbKey ? <img className="activity-thumb" src={mediaUrl(thumbKey)} alt={r.title} loading="lazy" /> : null}
          {r.summary ? <p className="muted small">{r.summary.slice(0, 240)}</p> : null}
        </div>
      ) : null}
      {firm.map(linkRow)}
      {suggested.length ? (
        <details className="activity-detail">
          <summary>{suggested.length} possible link{suggested.length === 1 ? "" : "s"} on this day</summary>
          {suggested.map(linkRow)}
        </details>
      ) : null}
    </div>
  );
}

/** Sessions, pull requests, issues and releases of one day, for the calendar. Commits, notes and materials have their own lists there. */
export function DayRecords({ day }: { day: string }) {
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => { await api<View>(`/api/activity?from=${day}&to=${day}`).then(setView, (e) => setErr((e as Error).message)); }, [day]);
  useEffect(() => { setView(null); void load(); }, [load]);
  const { act, changeVisibility } = useActivityActions(setView, load, setErr);
  const [showExcluded, setShowExcluded] = useState(false);
  const all = view?.records.filter((r) => !["commit", "workingChange", "note", "material"].includes(r.kind)) ?? [];
  const excluded = all.filter((r) => r.visibility === "excluded").length;
  const shown = showExcluded ? all : all.filter((r) => r.visibility !== "excluded");
  if (!all.length && !err) return null;
  return (
    <div className="day-records">
      <div className="row">
        <div className="label grow">Sessions and project activity</div>
        <ExcludedToggle count={excluded} show={showExcluded} onChange={setShowExcluded} />
      </div>
      {err ? <div className="error small">{err}</div> : null}
      {view ? shown.map((r) => <RecordCard key={r.id} record={r} view={view} act={act} changeVisibility={changeVisibility} />) : null}
    </div>
  );
}

/** Everything the connected sources recorded, day by day, with the links between records. */
export function ActivityPage() {
  const [from, setFrom] = useState(daysAgo(14));
  // A date field is empty or holds an early year while someone types, so only a complete date becomes the filter.
  const [fromInput, setFromInput] = useState(from);
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [showExcluded, setShowExcluded] = useState(false);
  const jobs = useJob();
  const load = useCallback(async () => { await api<View>(`/api/activity?from=${from}`).then((next) => { setView(next); setErr(""); }, (e) => setErr((e as Error).message)); }, [from]);
  useEffect(() => { void load(); }, [load, jobs.running]);
  const { act, changeVisibility } = useActivityActions(setView, load, setErr);

  const days = useMemo(() => {
    if (!view) return [];
    const byId = new Map(view.records.map((r) => [r.id, r]));
    const map = new Map<string, ActivityThread[]>();
    for (const thread of view.threads) {
      const t = { ...thread, recordIds: thread.recordIds.filter((id) => showExcluded || byId.get(id)?.visibility !== "excluded") };
      const date = byId.get(t.recordIds[0])?.date;
      if (date) map.set(date, [...(map.get(date) ?? []), t]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, threads]) => ({ date, threads, byId }));
  }, [view, showExcluded]);
  const excludedCount = view?.records.filter((r) => r.visibility === "excluded").length ?? 0;
  return (
    <div className="panel pad">
      <div className="row">
        <h2 className="grow">Activity</h2>
        <ExcludedToggle count={excludedCount} show={showExcluded} onChange={setShowExcluded} />
        <label className="inline-field">From<input type="date" value={fromInput} onChange={(e) => { setFromInput(e.target.value); if (/^(19|20)\d\d-/.test(e.target.value)) setFrom(e.target.value); }} onBlur={() => setFromInput(from)} /></label>
        <Button disabled={jobs.running} onClick={() => act(() => jobs.start("/api/activity/sync", { from }))}>Refresh activity</Button>
      </div>
      <p className="muted small">Commits from the project's Sources, notes and materials are always here. Turn on AI sessions, GitHub and Forgejo under Project settings &gt; Connected activity. Reading sessions stays on this computer and sends nothing. Summarize and Review with sessions send them to the selected agent.</p>
      {err ? <div className="error">{err}</div> : null}
      {!days.length ? <p className="muted">{excludedCount ? "Everything recorded for this period is excluded." : "Nothing recorded for this period yet. Select Refresh activity."}</p> : null}
      {days.map(({ date, threads, byId }) => (
        <section key={date} className="activity-day">
          <h3>{date}</h3>
          {threads.map((t) => (
            <div key={t.id} className={`activity-thread ${t.recordIds.length > 1 ? "linked" : ""}`}>
              {t.recordIds.length > 1 ? <div className="activity-thread-label">Linked: these records are about the same work</div> : null}
              {t.recordIds.map((id) => <RecordCard key={id} record={byId.get(id)!} view={view!} act={act} changeVisibility={changeVisibility} />)}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
