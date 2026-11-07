import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, type AppState, type Job } from "./api";
import { CommitList } from "./CommitLinks";
import { JOB_FINISHED } from "./JobDock";
import { MaterialAttach, MaterialThumb } from "./Materials";
import { PopOutDialog } from "./PopOut";
import type { StoryDraft, StoryRequest, Suggestion } from "../shared/types";

const SEARCH_DAYS = 14;
const QUICK_RANGES = [1, 7];

const shifted = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
};

/** A request that searches the two weeks either side of `date`. */
export const storyRequestAround = (date: string, parts: Partial<StoryRequest> = {}): StoryRequest => ({
  description: "",
  from: shifted(date, -SEARCH_DAYS),
  to: shifted(date, SEARCH_DAYS),
  commits: [],
  notes: [],
  materialIds: [],
  ...parts,
});

/** "Describe a post" with its two steps: the description, and the review of the draft the agent writes from it. */
export function StoryFlow({ state, reload, selectedDay, around, request, setRequest, onAccepted }: {
  state: AppState;
  reload: () => void;
  selectedDay: string | null;
  around: string;
  request: StoryRequest | null;
  setRequest: (request: StoryRequest | null) => void;
  onAccepted: (suggestion: Suggestion) => void;
}) {
  const [drafts, setDrafts] = useState<StoryDraft[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState("");
  const [agent, setAgent] = useState(state.settings.agent);
  const started = useRef<{ jobId: string; request: StoryRequest; replaces?: string } | null>(null);
  const [replaces, setReplaces] = useState<string>();
  // Text survives an accidental close of the dialog, per retold suggestion.
  const unsent = useRef(new Map<string, string>());

  const load = useCallback(() => api<StoryDraft[]>("/api/suggestions/story-drafts").then(setDrafts, () => {}), []);
  useEffect(() => { void load(); }, [load, state]);
  useEffect(() => {
    const finished = async (e: Event) => {
      const job = (e as CustomEvent<Job>).detail;
      const mine = started.current;
      if (!mine || job.id !== mine.jobId) return;
      started.current = null;
      if (job.status === "done") {
        if (mine.replaces) await api(`/api/suggestions/story-drafts/${mine.replaces}`, "DELETE").catch(() => {});
        await load();
        setReviewing(true);
      } else if (job.status === "failed") {
        setError(job.error ?? "The agent could not write a draft.");
        setRequest(mine.request);
      }
    };
    addEventListener(JOB_FINISHED, finished);
    return () => removeEventListener(JOB_FINISHED, finished);
  }, [load, setRequest]);

  const open = request ? { ...request, description: request.description || unsent.current.get(request.retellId ?? "") || "" } : null;
  // An upload finishes after the render that started it, so edits build on the latest request.
  const latest = useRef(open);
  latest.current = open;
  const edit = (patch: Partial<StoryRequest>) => {
    const current = latest.current;
    if (!current) return;
    if (patch.description !== undefined) unsent.current.set(current.retellId ?? "", patch.description);
    latest.current = { ...current, ...patch };
    setRequest(latest.current);
  };
  const start = async () => {
    if (!open) return;
    setError("");
    try {
      const job = await api<Job>("/api/suggestions/story-drafts", "POST", { ...open, agent });
      started.current = { jobId: job.id, request: open, replaces };
      unsent.current.delete(open.retellId ?? "");
      setReplaces(undefined);
      setRequest(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const retold = open?.retellId ? state.suggestions.find((s) => s.id === open.retellId) : undefined;
  const ticked = open ? open.commits.length + open.notes.length + open.materialIds.length : 0;
  const draft = drafts[0];
  return (
    <>
      <Button variant="outline" onClick={() => { setError(""); setReplaces(undefined); setRequest(storyRequestAround(around)); }}>Describe a post</Button>
      {drafts.length ? <Button onClick={() => setReviewing(true)}>Review draft{drafts.length > 1 ? `s (${drafts.length})` : ""}</Button> : null}

      {open ? (
        <PopOutDialog title={retold ? `Tell it differently: ${retold.title}` : "Describe a post"} onClose={() => { setReplaces(undefined); setRequest(null); }}>
          <div className="card-body">
            <label>What do you want to post?
              <textarea
                rows={9}
                value={open.description}
                placeholder="Your angle, and anything you no longer have. For example: I lost the old footage, so build this around the new captures."
                onChange={(e) => edit({ description: e.target.value })}
              />
            </label>
            <div className="label">Materials</div>
            <p className="muted small">Upload what you have now, or attach existing material. The agent also searches the materials of the period.</p>
            <MaterialAttach
              attached={open.materialIds}
              all={state.materials}
              onChange={(materialIds) => edit({ materialIds })}
              attach={{}}
              sessions={{ from: open.from, to: open.to }}
              onUploaded={(created) => {
                edit({ materialIds: [...(latest.current?.materialIds ?? []), ...created.map((m) => m.id)] });
                reload();
              }}
              onEdited={reload}
            />
            {ticked ? <div className="muted small">The draft must use the {ticked} item{ticked === 1 ? "" : "s"} you chose.</div> : null}
            <div className="row story-range">
              <label>Search from<input type="date" value={open.from} onChange={(e) => { if (e.target.value) edit({ from: e.target.value }); }} /></label>
              <label>to<input type="date" value={open.to} onChange={(e) => { if (e.target.value) edit({ to: e.target.value }); }} /></label>
              <label>Agent
                <select value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")}>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              {selectedDay ? QUICK_RANGES.map((days) => (
                <Button key={days} variant="outline" onClick={() => edit({ from: shifted(selectedDay, -days), to: shifted(selectedDay, days) })}>{selectedDay} ± {days}</Button>
              )) : null}
            </div>
            <p className="muted small">The agent reads the commits, sessions, notes and materials of this period, and all suggestions and posts. Those sessions' prompts go to the agent's provider. Nothing changes until you accept the draft. A longer period costs more.</p>
            {error ? <div className="error small">{error}</div> : null}
            <div className="row editor-actions">
              <Button disabled={!open.description.trim() && !ticked && !open.retellId} onClick={start}>Write draft</Button>
            </div>
          </div>
        </PopOutDialog>
      ) : null}

      {reviewing && draft && !open ? (
        <PopOutDialog title={`Draft: ${draft.suggestion.title}`} description={`${draft.suggestion.kind} · ${draft.suggestion.workDate}${drafts.length > 1 ? ` · ${drafts.length - 1} more after this one` : ""}`} onClose={() => setReviewing(false)}>
          <DraftReview
            key={draft.id}
            draft={draft}
            state={state}
            onAccept={async (absorb) => {
              const created = await api<Suggestion>(`/api/suggestions/story-drafts/${draft.id}/accept`, "POST", { absorb });
              await load();
              setReviewing(false);
              onAccepted(created);
            }}
            onChangeDescription={() => { setError(""); setReplaces(draft.id); setRequest(draft.request); }}
            onDiscard={async () => {
              await api(`/api/suggestions/story-drafts/${draft.id}`, "DELETE");
              await load();
              if (drafts.length < 2) setReviewing(false);
            }}
          />
        </PopOutDialog>
      ) : null}
    </>
  );
}

function DraftReview({ draft, state, onAccept, onChangeDescription, onDiscard }: {
  draft: StoryDraft;
  state: AppState;
  onAccept: (absorb: string[]) => Promise<void>;
  onChangeDescription: () => void;
  onDiscard: () => Promise<void>;
}) {
  const { suggestion: s } = draft;
  const [absorb, setAbsorb] = useState(draft.absorbs.map((a) => a.suggestionId));
  const [error, setError] = useState("");
  const materials = s.materialIds.flatMap((id) => state.materials.find((m) => m.id === id) ?? []);
  const titleOf = (id: string) => state.materials.find((m) => m.id === id)?.title ?? id;
  const run = (work: () => Promise<void>) => { setError(""); work().catch((e) => setError((e as Error).message)); };
  return (
    <div className="card-body story-draft">
      {draft.unsupported.length ? (
        <div className="proposed-edit">
          <div className="label">The evidence doesn't show</div>
          <ul>{draft.unsupported.map((text, i) => <li key={i}>{text}</li>)}</ul>
        </div>
      ) : null}
      <div><div className="label">Hook</div><p>{s.hook}</p></div>
      <div><div className="label">Summary</div><p>{s.summary}</p></div>
      <div><div className="label">Why it matters</div><p>{s.whyItMatters}</p></div>
      {draft.request.description ? <div><div className="label">Your description</div><p className="muted">{draft.request.description}</p></div> : null}
      {draft.shots.length ? (
        <div>
          <div className="label">Shots</div>
          <ul className="story-shots">
            {draft.shots.map((shot, i) => (
              <li key={i}>
                {materials.some((m) => m.id === shot.materialId) ? <span className="tag" title={titleOf(shot.materialId!)}>Available</span> : <span className="tag story-capture">Capture now</span>}
                <span>{shot.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {materials.length ? <div><div className="label">Materials</div><div className="mgrid small">{materials.map((m) => <MaterialThumb key={m.id} m={m} />)}</div></div> : null}
      {s.sources.commits.length ? <CommitList commits={s.sources.commits} /> : null}
      {s.sources.sessions?.length ? <div className="muted small">Sessions: {s.sources.sessions.length}</div> : null}
      {draft.absorbs.length ? (
        <div>
          <div className="label">Replaces</div>
          <p className="muted small">Ticked suggestions are marked as merged. Their materials don't carry over.</p>
          {draft.absorbs.map((a) => (
            <label key={a.suggestionId} className="check story-absorb">
              <input type="checkbox" checked={absorb.includes(a.suggestionId)} onChange={(e) => setAbsorb(e.target.checked ? [...absorb, a.suggestionId] : absorb.filter((id) => id !== a.suggestionId))} />
              <span><strong>{a.title}</strong> <span className="muted">{a.reason}</span></span>
            </label>
          ))}
        </div>
      ) : null}
      {draft.related.length ? (
        <div>
          <div className="label">Related, stays as it is</div>
          <ul className="small">{draft.related.map((r, i) => <li key={i}><strong>{r.title}</strong> <span className="muted">{r.reason}</span></li>)}</ul>
        </div>
      ) : null}
      {draft.leftOut.length ? (
        <div>
          <div className="label">Left out</div>
          <ul className="small">{draft.leftOut.map((l, i) => <li key={i}><strong>{l.item}</strong> <span className="muted">{l.reason}</span></li>)}</ul>
        </div>
      ) : null}
      {error ? <div className="error small">{error}</div> : null}
      <div className="row editor-actions">
        <Button onClick={() => run(() => onAccept(absorb))}>Add suggestion</Button>
        <Button variant="outline" onClick={onChangeDescription}>Change description</Button>
        <Button variant="ghost" onClick={() => run(onDiscard)}>Discard</Button>
      </div>
    </div>
  );
}
