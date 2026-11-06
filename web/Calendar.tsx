import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ListInput } from "@/components/list-input";
import { api, projectHref, fmtDate, useJob, type AppState } from "./api";
import { usePersistent } from "./persistent";
import { MaterialAttach } from "./Materials";
import { DayActivity, NewSuggestion, emptyDraft, type DayDraft } from "./GitDay";
import { PopOutButton, PopOutDialog } from "./PopOut";
import { CommitList } from "./CommitLinks";
import { StoryFlow, storyRequestAround } from "./StoryDraft";
import { SegTabs } from "@/components/seg-tabs";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Format, Material, StoryRequest, Suggestion, SuggestionStatus } from "../shared/types";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const KINDS: Suggestion["kind"][] = ["feature", "map", "art", "fix", "tech", "story", "other"];
const STATUSES: SuggestionStatus[] = ["proposed", "approved", "used", "dismissed", "merged"];


function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

export function Calendar({ state, reload }: { state: AppState; reload: () => void }) {
  const now = new Date();
  const [view, setView] = usePersistent<"calendar" | "list">("view", "calendar");
  const [day, setDay] = usePersistent<string | null>("day", null);
  // The shown month starts at the remembered day's month.
  const [cursor, setCursor] = usePersistent("month", day ? { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 } : { y: now.getFullYear(), m: now.getMonth() });
  const [by, setBy] = usePersistent<"work" | "publish">("by", "work");
  const [showDone, setShowDone] = usePersistent("showDone", false);
  const [selected, setSelected] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [storedSideTab, setSideTab] = usePersistent<string>("sideTab", "suggestions");
  const sideTab: "suggestions" | "day" = storedSideTab === "day" ? "day" : "suggestions";
  const [commitCounts, setCommitCounts] = useState<Record<string, number>>({});
  /** The selected day's new-suggestion draft, shared by the Activity and Suggestions tabs. */
  const [draft, setDraft] = useState<DayDraft>(emptyDraft);
  useEffect(() => setDraft(emptyDraft()), [day]);
  /** A just-created suggestion: shown open and scrolled into view in the Suggestions tab. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusSuggestion = (id?: string) => {
    reload();
    if (!id) return;
    setBy("work");
    setSideTab("suggestions");
    setFocusId(id);
  };

  const [storyRequest, setStoryRequest] = useState<StoryRequest | null>(null);
  /** The day's form asked for this draft, so accepting it empties the form. */
  const draftFromDayForm = React.useRef(false);
  const retell = (s: Suggestion) => { draftFromDayForm.current = false; setStoryRequest(storyRequestAround(s.workDate, { retellId: s.id })); };
  const showAccepted = (s: Suggestion) => {
    if (draftFromDayForm.current) setDraft(emptyDraft());
    draftFromDayForm.current = false;
    setView("calendar");
    setDay(s.workDate);
    setCursor({ y: Number(s.workDate.slice(0, 4)), m: Number(s.workDate.slice(5, 7)) - 1 });
    focusSuggestion(s.id);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const patch = (id: string, body: Partial<Suggestion>) => act(() => api(`/api/suggestions/${id}`, "PATCH", body));
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const active = (s: Suggestion) => showDone || s.status === "proposed" || s.status === "approved";
  const dateOf = (s: Suggestion) => (by === "work" ? s.workDate : s.publishDate);
  const byDay = useMemo(() => {
    const m = new Map<string, Suggestion[]>();
    for (const s of state.suggestions.filter(active)) {
      const d = dateOf(s);
      if (d) m.set(d, [...(m.get(d) ?? []), s]);
    }
    return m;
  }, [state.suggestions, by, showDone]);
  /** Videos by publish date (Publish plan) or by the work dates of their topics (Work date). */
  const episodesByDay = useMemo(() => {
    const m = new Map<string, AppState["posts"]>();
    const add = (date: string, e: AppState["posts"][number]) => m.set(date, [...(m.get(date) ?? []), e]);
    const workDate = new Map(state.suggestions.map((s) => [s.id, s.workDate]));
    for (const e of state.posts) {
      if (by === "publish") {
        if (e.publishDate) add(e.publishDate, e);
      } else {
        // Work date view: on its topics' days and, once known, on its publication day.
        const days = new Set(e.suggestionIds.map((id) => workDate.get(id)).filter((d): d is string => !!d));
        if (e.publishDate) days.add(e.publishDate);
        for (const d of days) add(d, e);
      }
    }
    return m;
  }, [state.posts, state.suggestions, by]);
  const materialsByDay = useMemo(() => {
    const m = new Map<string, Material[]>();
    for (const x of state.materials) m.set(x.date, [...(m.get(x.date) ?? []), x]);
    return m;
  }, [state.materials]);
  const notesByDay = useMemo(() => new Set(state.notes.map((n) => n.date)), [state.notes]);

  const [search, setSearch] = useState("");
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: Array<string | undefined>) => terms.every((term) => texts.some((text) => text?.toLowerCase().includes(term)));
  const suggestionMatches = (s: Suggestion) => matches(s.title, s.hook, s.summary, s.whyItMatters, s.highlights, s.suggestedShots.join(" "));
  const postMatches = (e: AppState["posts"][number]) => matches(e.title);
  /** Days with at least one entry that holds every search word. */
  const matchingDays = useMemo(() => {
    const days = new Set<string>();
    if (!terms.length) return days;
    for (const [date, items] of byDay) if (items.some(suggestionMatches)) days.add(date);
    for (const [date, posts] of episodesByDay) if (posts.some(postMatches)) days.add(date);
    for (const m of state.materials) if (matches(m.title, m.annotation, m.group, m.fileName)) days.add(m.date);
    for (const n of state.notes) if (matches(n.text)) days.add(n.date);
    return days;
  }, [search, byDay, episodesByDay, state.materials, state.notes]);
  const monthPrefix = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-`;
  const matchesThisMonth = [...matchingDays].filter((d) => d.startsWith(monthPrefix)).length;

  const sideList = (by === "publish" && !day ? state.suggestions.filter((s) => active(s) && !s.publishDate) : state.suggestions.filter(active).filter((s) => !day || dateOf(s) === day)).sort(
    (a, b) => b.workDate.localeCompare(a.workDate) || b.appeal - a.appeal,
  );
  const grid = monthGrid(cursor.y, cursor.m);
  const todayStr = fmtDate(now);
  useEffect(() => {
    api<Record<string, number>>(`/api/git/counts?from=${fmtDate(grid[0])}&to=${fmtDate(grid[41])}`).then(setCommitCounts, () => setCommitCounts({}));
  }, [cursor.y, cursor.m]);

  return (
    <div className={`calendar-page ${view === "list" ? "without-side" : ""}`}>
      <section className="cal">
        <div className="toolbar">
          <SegTabs value={view} onChange={setView} items={[{ value: "calendar", label: "Calendar" }, { value: "list", label: "Triage list" }]} />
          {view === "calendar" ? (
            <>
              <Button variant="outline" onClick={() => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }))}>‹</Button>
              <h2>{new Date(cursor.y, cursor.m).toLocaleString(undefined, { month: "long", year: "numeric" })}</h2>
              <Button variant="outline" onClick={() => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }))}>›</Button>
              <SegTabs value={by} onChange={setBy} items={[{ value: "work", label: "Work date" }, { value: "publish", label: "Publish plan" }]} />
              <label className="check">
                <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show used/dismissed
              </label>
              <input className="calendar-search" type="search" aria-label="Search the calendar" placeholder="Search the calendar" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }} />
              {terms.length ? <span className="muted small">{matchesThisMonth} {matchesThisMonth === 1 ? "day" : "days"} this month, {matchingDays.size} in all</span> : null}
            </>
          ) : null}
          <StoryFlow state={state} reload={reload} selectedDay={day} around={day ?? fmtDate(now)} request={storyRequest} setRequest={setStoryRequest} onAccepted={showAccepted} />
        </div>

        {err ? <div className="error">{err}</div> : null}
        <SelectionBar defaults={state.settings.outputs} selected={selected} setSelected={setSelected} act={act} />

        {view === "calendar" ? (
          <div className="cal-grid">
            {WEEKDAYS.map((w) => (
              <div key={w} className="wd">{w}</div>
            ))}
            {grid.map((d) => {
              const key = fmtDate(d);
              // A match always shows, even on a day with more entries than fit.
              const items = terms.length ? [...(byDay.get(key) ?? [])].sort((a, b) => Number(suggestionMatches(b)) - Number(suggestionMatches(a))) : byDay.get(key) ?? [];
              const eps = episodesByDay.get(key) ?? [];
              const mats = materialsByDay.get(key) ?? [];
              return (
                <div key={key} className={`cell ${d.getMonth() !== cursor.m ? "out" : ""} ${key === todayStr ? "today" : ""} ${key === day ? "sel" : ""} ${terms.length && !matchingDays.has(key) ? "search-miss" : ""}`} onClick={() => setDay(day === key ? null : key)}>
                  <div className="num">
                    {d.getDate()} {notesByDay.has(key) ? <span className="dot" title="Note" /> : null}
                    <span className="counts">
                      {mats.length ? <span className="matcount" title={`${mats.length} material(s)`}>▣ {mats.length}</span> : null}
                      {commitCounts[key] ? <span className="commitcount" title={`${commitCounts[key]} commit(s)`}>⎇ {commitCounts[key]}</span> : null}
                    </span>
                  </div>
                  {eps.map((e) => (
                    <a key={e.id} className={`chip ep ${terms.length && !postMatches(e) ? "search-miss" : ""}`} href={projectHref(`/post/${e.id}`)} onClick={(ev) => ev.stopPropagation()}>▶ {e.title}</a>
                  ))}
                  {items.slice(0, 4).map((s) => (
                    <div key={s.id} className={`chip k-${s.kind} st-${s.status} ${selected.includes(s.id) ? "picked" : ""} ${terms.length && !suggestionMatches(s) ? "search-miss" : ""}`} title={s.summary} onClick={(ev) => { if (ev.ctrlKey || ev.metaKey) { ev.stopPropagation(); toggle(s.id); } }}>
                      {s.title}
                    </div>
                  ))}
                  {items.length > 4 ? <div className="more">+{items.length - 4}</div> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <TriageList state={state} selected={selected} toggle={toggle} setSelected={setSelected} onPatch={patch} reload={reload} onRetell={retell} />
        )}
        {view === "calendar" ? <Legend /> : null}

        <ProgressPanel state={state} reload={reload} act={act} />
        <NotesPanel state={state} day={day} act={act} />
      </section>

      {view === "calendar" ? <aside className="side">
        <Tabs value={sideTab} onValueChange={(v) => setSideTab(v)} className="side-nav items-center gap-0 data-horizontal:flex-row">
          <div className="side-nav-group">
            <span className="side-nav-label">{day ? `Day ${day.slice(5)}` : "All days"}</span>
            <TabsList>
              <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
              <TabsTrigger value="day">Activity</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
        {sideTab === "day" ? (
          <>
            <div className="side-head">
              <h3>{day ? `Activity on ${day}` : "Activity"}</h3>
              {day ? <Button variant="link" size="xs" onClick={() => setDay(null)}>clear day</Button> : null}
            </div>
            <DayActivity day={day} materials={state.materials} notes={state.notes} draft={draft} setDraft={setDraft} onChanged={reload} />
          </>
        ) : null}
        {sideTab === "suggestions" ? (
          <>
            <div className="side-head">
              <h3>{day ? `Suggestions for ${day}` : by === "publish" ? "Unscheduled suggestions" : "Open suggestions"}</h3>
              {day ? <Button variant="link" size="xs" onClick={() => setDay(null)}>show all</Button> : null}
            </div>
            {day ? (
              <NewSuggestion
                day={day}
                materials={state.materials}
                notes={state.notes}
                draft={draft}
                setDraft={setDraft}
                onShowActivity={() => setSideTab("day")}
                onCreated={focusSuggestion}
                onWriteUp={(parts) => { draftFromDayForm.current = true; setStoryRequest(storyRequestAround(day, parts)); }}
              />
            ) : null}
            <p className="muted small">Tick suggestions (or Ctrl+click a chip) to merge them, change them together or create a post.</p>
            {sideList.map((s) => (
              <SuggestionCard key={s.id} s={s} materials={state.materials} selected={selected.includes(s.id)} onToggle={() => toggle(s.id)} onPatch={(b) => patch(s.id, b)} reload={reload} focused={s.id === focusId} canPopOut onRetell={() => retell(s)} />
            ))}
            {!sideList.length ? <p className="muted">Nothing here. Run a progress check or a backfill, or add a note.</p> : null}
          </>
        ) : null}
      </aside> : null}
    </div>
  );
}

/** Explains the calendar's colours and markers; uses the same classes as the cells. */
function Legend() {
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-title">Kind</span>
        {KINDS.map((k) => (
          <span key={k} className={`chip k-${k}`}>{k}</span>
        ))}
      </div>
      <div className="legend-group">
        <span className="legend-title">Status</span>
        <span className="chip">proposed</span>
        <span className="chip st-approved">approved</span>
        <span className="chip st-used">used / dismissed / merged</span>
        <span className="chip picked">selected</span>
        <span className="chip ep" title="Work date: on its topics' dates · Publish plan: on its publish date">▶ video</span>
      </div>
      <div className="legend-group">
        <span className="legend-title">Day</span>
        <span className="legend-item"><span className="dot" /> note</span>
        <span className="legend-item"><span className="matcount">▣ n</span> materials</span>
        <span className="legend-item"><span className="commitcount">⎇ n</span> commits</span>
        <span className="legend-item"><span className="swatch today" /> today</span>
        <span className="legend-item"><span className="swatch sel" /> selected day</span>
      </div>
    </div>
  );
}


/** Posts with their stage; scheduled ones first by publish date, then unscheduled ones, newest first. */
function SelectionBar({ defaults, selected, setSelected, act }: { defaults: Format[]; selected: string[]; setSelected: (s: string[]) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [formats, setFormats] = useState<Format[]>(defaults);
  const [publish, setPublish] = useState("");
  if (!selected.length) return null;
  const bulk = (patch: Partial<Suggestion>) => act(() => api("/api/suggestions/bulk", "POST", { ids: selected, patch }));
  const toggleFormat = (f: Format, on: boolean) => setFormats((x) => (on ? [...new Set([...x, f])] : x.filter((y) => y !== f)));
  return (
    <div className="selection">
      <strong>{selected.length} selected</strong>
      <Button variant="outline" onClick={() => bulk({ status: "approved" })}>Approve</Button>
      <Button variant="outline" onClick={() => bulk({ status: "dismissed" })}>Dismiss</Button>
      <Button variant="outline" onClick={() => bulk({ status: "proposed" })}>Restore</Button>
      <Button variant="outline" disabled={selected.length < 2} onClick={() => act(async () => { await api("/api/suggestions/merge", "POST", { ids: selected }); setSelected([]); })}>Merge</Button>
      <span className="sep" />
      <input type="date" value={publish} onChange={(e) => setPublish(e.target.value)} />
      <Button variant="outline" disabled={!publish} onClick={() => bulk({ publishDate: publish })}>Set publish date</Button>
      <span className="sep" />
      <label className="check"><input type="checkbox" checked={formats.includes("portrait")} onChange={(e) => toggleFormat("portrait", e.target.checked)} /> Short 9:16</label>
      <label className="check"><input type="checkbox" checked={formats.includes("landscape")} onChange={(e) => toggleFormat("landscape", e.target.checked)} /> Video 16:9</label>
      <Button
        disabled={!formats.length}
        onClick={() =>
          act(async () => {
            const ep = await api<{ id: string }>("/api/posts", "POST", { suggestionIds: selected, outputs: formats });
            setSelected([]);
            location.hash = projectHref(`/post/${ep.id}`);
          })
        }
      >
        Create post
      </Button>
      <Button variant="link" size="xs" onClick={() => setSelected([])}>clear</Button>
    </div>
  );
}

function TriageList({ state, selected, toggle, setSelected, onPatch, reload, onRetell }: { state: AppState; selected: string[]; toggle: (id: string) => void; setSelected: (s: string[]) => void; onPatch: (id: string, b: Partial<Suggestion>) => void; reload: () => void; onRetell: (s: Suggestion) => void }) {
  const [statuses, setStatuses] = useState<SuggestionStatus[]>(["proposed", "approved"]);
  const [kind, setKind] = useState<string>("");
  const [review, setReview] = useState<"" | "new" | "update">("");
  const [minAppeal, setMinAppeal] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"date" | "appeal">("date");
  const [open, setOpen] = useState<string | null>(null);

  const rows = state.suggestions
    .filter((s) => statuses.includes(s.status))
    .filter((s) => !kind || s.kind === kind)
    .filter((s) => !review || (review === "new" ? s.fromSessionReview : s.proposedEdit))
    .filter((s) => s.appeal >= minAppeal)
    .filter((s) => (!from || s.workDate >= from) && (!to || s.workDate <= to))
    .filter((s) => !q || `${s.title} ${s.summary} ${s.hook}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort === "appeal" ? b.appeal - a.appeal || b.workDate.localeCompare(a.workDate) : b.workDate.localeCompare(a.workDate) || b.appeal - a.appeal));
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(r.id));

  return (
    <div className="triage">
      <div className="filters row">
        {STATUSES.map((st) => (
          <label key={st} className="check">
            <input type="checkbox" checked={statuses.includes(st)} onChange={(e) => setStatuses((x) => (e.target.checked ? [...x, st] : x.filter((y) => y !== st)))} /> {st}
          </label>
        ))}
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">all kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={review} onChange={(e) => setReview(e.target.value as "" | "new" | "update")}>
          <option value="">all origins</option>
          <option value="new">from session review</option>
          <option value="update">update proposed</option>
        </select>
        <select value={minAppeal} onChange={(e) => setMinAppeal(Number(e.target.value))}>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>appeal ≥ {n}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="To" />
        <input className="grow" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as "date" | "appeal")}>
          <option value="date">newest first</option>
          <option value="appeal">most appealing first</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...rows.map((r) => r.id)])] : selected.filter((id) => !rows.some((r) => r.id === id)))} /></th>
            <th>Work date</th>
            <th>Title</th>
            <th>Kind</th>
            <th>Appeal</th>
            <th>Format</th>
            <th>Status</th>
            <th>Publish</th>
            <th>▣</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <React.Fragment key={s.id}>
              <tr className={`st-${s.status} ${selected.includes(s.id) ? "selected" : ""}`}>
                <td><input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} /></td>
                <td className="nowrap">{s.workDate}</td>
                <td className="title-cell" onClick={() => setOpen(open === s.id ? null : s.id)}>
                  <div className="title">{s.title}</div>
                  <div className="muted small">{s.hook}</div>
                </td>
                <td><span className={`tag k-${s.kind}`}>{s.kind}</span></td>
                <td className="nowrap">{"★".repeat(s.appeal)}{"☆".repeat(5 - s.appeal)}</td>
                <td>{s.recommendedFormat}</td>
                <td>{s.status}</td>
                <td className="nowrap">{s.publishDate ?? ""}</td>
                <td>{s.materialIds.length || ""}</td>
              </tr>
              {open === s.id ? (
                <tr className="expanded">
                  <td colSpan={9}>
                    <SuggestionCard s={s} materials={state.materials} selected={selected.includes(s.id)} onToggle={() => toggle(s.id)} onPatch={(b) => onPatch(s.id, b)} reload={reload} startOpen onRetell={() => onRetell(s)} />
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      {!rows.length ? <p className="muted">No suggestions match.</p> : <p className="muted small">{rows.length} suggestion(s).</p>}
    </div>
  );
}

function ProgressPanel({ state, reload, act }: { state: AppState; reload: () => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [agent, setAgent] = useState(state.settings.agent);
  const [info, setInfo] = useState<{ firstCommit: string; processedWeeks: string[]; lastCheck?: string } | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rerun, setRerun] = useState(false);
  const loadInfo = () =>
    api<{ firstCommit: string; processedWeeks: string[]; lastCheck?: string }>("/api/backfill").then((i) => {
      setInfo(i);
      setFrom((f) => f || i.firstCommit);
      setTo((t) => t || (i.lastCheck ? i.lastCheck.slice(0, 10) : fmtDate(new Date())));
    });
  useEffect(() => {
    loadInfo().catch(() => {});
  }, []);
  const [review, setReview] = useState<{ firstSession?: string; processedWeeks: string[] } | null>(null);
  const [reviewFrom, setReviewFrom] = useState("");
  const [reviewTo, setReviewTo] = useState(fmtDate(new Date()));
  const [reviewAgain, setReviewAgain] = useState(false);
  const loadReview = () => api<{ firstSession?: string; processedWeeks: string[] }>("/api/session-review").then((r) => {
    setReview(r);
    setReviewFrom((f) => f || (r.firstSession ?? ""));
  });
  useEffect(() => {
    loadReview().catch(() => {});
  }, []);
  const job = useJob(() => {
    reload();
    loadInfo().catch(() => {});
    loadReview().catch(() => {});
  });
  const takenAt = Object.values(state.snapshot ?? {}).map((s) => s.takenAt).sort().at(-1);
  const lastCheck = takenAt ? new Date(takenAt).toLocaleString() : "never";
  return (
    <div className="discover">
      <div className="row">
        <div className="grow">
          <strong>Check for progress</strong>
          <div className="muted small">Last check: {lastCheck}. Reads new commits, uncommitted content files, new notes and new materials.</div>
        </div>
        <select value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <Button disabled={job.running} onClick={() => act(() => job.start("/api/discover", { agent }))}>
          Propose changes since last check
        </Button>
      </div>
      <div className="row">
        <div className="grow">
          <strong>Backfill history</strong>
          <div className="muted small">
            One agent run per week of commits, notes and materials in the range. {info ? `${info.processedWeeks.length} week(s) processed so far; those are skipped unless you re-run them.` : ""}
          </div>
        </div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <label className="check"><input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} /> re-run processed weeks</label>
        <Button variant="outline" disabled={job.running || !from || !to} onClick={() => act(() => job.start("/api/backfill", { from, to, rerun, agent }))}>Backfill</Button>
      </div>
      <div className="row">
        <div className="grow">
          <strong>Review with sessions</strong>
          <div className="muted small">
            One agent run per week with AI sessions, which sends those sessions' prompts to the agent's provider. It can add topics and evidence, and an existing suggestion's text changes only when you accept an update. {review ? `${review.processedWeeks.length} week(s) reviewed so far.` : ""}
          </div>
        </div>
        <input type="date" value={reviewFrom} onChange={(e) => setReviewFrom(e.target.value)} />
        <span>to</span>
        <input type="date" value={reviewTo} onChange={(e) => setReviewTo(e.target.value)} />
        <label className="check"><input type="checkbox" checked={reviewAgain} onChange={(e) => setReviewAgain(e.target.checked)} /> review weeks again</label>
        <Button variant="outline" disabled={job.running || !reviewFrom || !reviewTo} onClick={() => act(() => job.start("/api/session-review", { from: reviewFrom, to: reviewTo, rerun: reviewAgain, agent }))}>Review</Button>
      </div>
    </div>
  );
}

function NotesPanel({ state, day, act }: { state: AppState; day: string | null; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [text, setText] = useState("");
  const [date, setDate] = useState(fmtDate(new Date()));
  useEffect(() => {
    if (day) setDate(day);
  }, [day]);
  return (
    <div className="note-form">
      <strong>Add a progress note</strong>
      <span className="muted small">Work the repository cannot show, or what you want to talk about. For screenshots and videos, use Materials.</span>
      <div className="row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="grow" placeholder="e.g. Finished the settings page and fixed the login redirect" value={text} onChange={(e) => setText(e.target.value)} />
        <Button variant="outline" disabled={!text.trim()} onClick={() => act(async () => { await api("/api/notes", "POST", { date, text }); setText(""); })}>Add note</Button>
        <Button variant="outline" disabled={!text.trim()} title="Create a suggestion directly from this text" onClick={() => act(async () => { await api("/api/suggestions", "POST", { workDate: date, title: text.slice(0, 80), summary: text, highlights: text }); setText(""); })}>
          Add as suggestion
        </Button>
      </div>
      {state.notes.filter((n) => !day || n.date === day).slice(-5).map((n) => (
        <div key={n.id} className="note">
          <span className="muted">{n.date}</span> {n.text}
          <Button variant="link" size="xs" onClick={() => act(() => api(`/api/notes/${n.id}`, "DELETE"))}>remove</Button>
        </div>
      ))}
    </div>
  );
}

/**
 * A suggestion with all its fields. `inPost` shows it as a topic on its post's page: no selection box,
 * no status buttons and no link to the post.
 */
export function SuggestionCard(props: {
  s: Suggestion;
  materials: Material[];
  selected?: boolean;
  onToggle?: () => void;
  inPost?: boolean;
  onPatch: (b: Partial<Suggestion>) => void;
  reload: () => void;
  startOpen?: boolean;
  focused?: boolean;
  canPopOut?: boolean;
  onRetell?: () => void;
}) {
  const { s, materials, selected = false, onToggle, onPatch, reload, startOpen, focused, inPost, canPopOut, onRetell } = props;
  const [open, setOpen] = useState(!!startOpen || !!focused);
  const [poppedOut, setPoppedOut] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focused]);
  const [draft, setDraft] = useState(s);
  useEffect(() => setDraft(s), [s]);
  const dirty = JSON.stringify({ ...draft, materialIds: [] }) !== JSON.stringify({ ...s, materialIds: [] });
  const editor = (
    <div className="card-body">
      {s.proposedEdit ? (
        <div className="proposed-edit">
          <div className="label">Proposed update</div>
          <p className="muted">{s.proposedEdit.reason}</p>
          <p><strong>Hook:</strong> {s.proposedEdit.hook}</p>
          <p><strong>Summary:</strong> {s.proposedEdit.summary}</p>
          <p><strong>Why it matters:</strong> {s.proposedEdit.whyItMatters}</p>
          <div className="row">
            <Button size="sm" onClick={() => void api(`/api/suggestions/${s.id}/proposed-edit`, "POST", { accept: true }).then(reload)}>Accept update</Button>
            <Button size="sm" variant="outline" onClick={() => void api(`/api/suggestions/${s.id}/proposed-edit`, "POST", { accept: false }).then(reload)}>Ignore</Button>
          </div>
        </div>
      ) : null}
      <label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>Hook<input value={draft.hook} onChange={(e) => setDraft({ ...draft, hook: e.target.value })} /></label>
      <label>Summary<textarea rows={poppedOut ? 12 : 4} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} /></label>
      <label>What I want to highlight<textarea rows={poppedOut ? 8 : 3} placeholder="Your angle, what was hard, what to show…" value={draft.highlights} onChange={(e) => setDraft({ ...draft, highlights: e.target.value })} /></label>
      <label>Suggested shots<ListInput lines rows={poppedOut ? 6 : 3} value={draft.suggestedShots} onChange={(suggestedShots) => setDraft({ ...draft, suggestedShots })} /></label>
      <div className="row">
        <label>Work date<input type="date" value={draft.workDate} onChange={(e) => setDraft({ ...draft, workDate: e.target.value })} /></label>
        <label>Publish date<input type="date" value={draft.publishDate ?? ""} onChange={(e) => setDraft({ ...draft, publishDate: e.target.value || undefined })} /></label>
        <label>Kind
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Suggestion["kind"] })}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      <div className="label">Materials</div>
      <MaterialAttach attached={s.materialIds} all={materials} onChange={(ids) => onPatch({ materialIds: ids })} attach={{ suggestionId: s.id }} defaultDate={s.workDate} onUploaded={reload} />
      {s.sources.commits.length ? <CommitList commits={s.sources.commits} /> : null}
      {s.sources.sessions?.length ? <div className="muted small">Sessions: {s.sources.sessions.length}</div> : null}
      {s.possibleRepeatOf ? <div className="muted small">Shares commits with "{s.possibleRepeatOf}". Dismiss this one if it tells the same story.</div> : null}
      {s.mergedFrom ? <div className="muted small">Merged from {s.mergedFrom.length} suggestions</div> : null}
      <div className="row editor-actions">
        <Button disabled={!dirty} onClick={() => onPatch({ ...draft, materialIds: s.materialIds })}>Save</Button>
        {!inPost && s.status === "proposed" ? <Button variant="outline" onClick={() => onPatch({ status: "approved" })}>Approve</Button> : null}
        {inPost ? null : s.status !== "dismissed" ? <Button variant="outline" onClick={() => onPatch({ status: "dismissed" })}>Dismiss</Button> : <Button variant="outline" onClick={() => onPatch({ status: "proposed" })}>Restore</Button>}
        {onRetell && s.status !== "merged" ? <Button variant="outline" onClick={() => { setPoppedOut(false); onRetell(); }}>Tell it differently</Button> : null}
        {!inPost && s.postId ? <a href={projectHref(`/post/${s.postId}`)}>Open post</a> : null}
      </div>
    </div>
  );
  return (
    <div ref={ref} className={`card st-${s.status} ${selected ? "selected" : ""} ${focused ? "focused" : ""}`}>
      <div className="card-head">
        {onToggle ? <input type="checkbox" checked={selected} onChange={onToggle} /> : null}
        <div className="grow" onClick={() => setOpen(!open)}>
          <div className="title">{s.title}</div>
          <div className="meta">
            <span className={`tag k-${s.kind}`}>{s.kind}</span>
            <span title="Appeal">{"★".repeat(s.appeal)}{"☆".repeat(5 - s.appeal)}</span>
            <span>{s.recommendedFormat}</span>
            <span>{s.workDate}</span>
            {s.publishDate ? <span>→ {s.publishDate}</span> : null}
            {s.materialIds.length ? <span>▣ {s.materialIds.length}</span> : null}
            {s.status !== "proposed" && !inPost ? <span className="tag">{s.status}</span> : null}
            {s.fromSessionReview ? <span className="tag">From sessions</span> : null}
            {s.proposedEdit ? <span className="tag">Update proposed</span> : null}
            {s.possibleRepeatOf ? <span className="tag" title={`Shares commits with "${s.possibleRepeatOf}"`}>May repeat</span> : null}
          </div>
        </div>
        {canPopOut && open ? <PopOutButton onClick={() => setPoppedOut(true)} /> : null}
      </div>
      {s.hook && !startOpen ? <p className="hook">“{s.hook}”</p> : null}
      {open && !poppedOut ? editor : null}
      {open && poppedOut ? <PopOutDialog title="Edit suggestion" description={`${s.kind} · ${s.workDate}`} onClose={() => setPoppedOut(false)}>{editor}</PopOutDialog> : null}
    </div>
  );
}
