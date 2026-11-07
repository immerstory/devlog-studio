import { DayRecords } from "./ActivityPage";
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "./api";
import { GroupOptions, GROUPS_LIST, MaterialThumb, setGroup, UploadForm } from "./Materials";
import { PopOutButton, PopOutDialog } from "./PopOut";
import { CommitLink } from "./CommitLinks";
import type { Material, Note, StoryRequest, Suggestion } from "../shared/types";

export interface Commit {
  sourceId: string;
  sourceLabel: string;
  hash: string;
  date: string;
  subject: string;
  body: string;
  files: Array<{ path: string; added: number; removed: number }>;
}

const KINDS: Suggestion["kind"][] = ["feature", "map", "art", "fix", "tech", "story", "news", "other"];
const EMPTY_FORM = { title: "", hook: "", summary: "", highlights: "", kind: "story" as Suggestion["kind"] };

/**
 * What the selected day's new suggestion is built from: items ticked on the Activity tab and the form on
 * the Suggestions tab. Shared by both tabs and cleared when the day changes.
 */
export interface DayDraft {
  commits: Commit[];
  noteIds: string[];
  materialIds: string[];
  form: typeof EMPTY_FORM;
}

const commitRef = (c: Commit) => `${c.sourceId}:${c.hash}`;

export const emptyDraft = (): DayDraft => ({ commits: [], noteIds: [], materialIds: [], form: { ...EMPTY_FORM } });

type SetDraft = React.Dispatch<React.SetStateAction<DayDraft>>;

/** Adds or removes an item; the first item picked prefills an empty title and summary. */
function toggleIn(setDraft: SetDraft, key: "noteIds" | "materialIds", id: string, title: string, summary: string) {
  setDraft((d) => {
    const adding = !d[key].includes(id);
    const list = adding ? [...d[key], id] : d[key].filter((x) => x !== id);
    const form = adding && !d.form.title ? { ...d.form, title, summary: d.form.summary || summary } : d.form;
    return { ...d, [key]: list, form };
  });
}

/** The selected day's notes, commits and materials. Ticked items feed the new suggestion on the Suggestions tab. */
export function DayActivity(props: { day: string | null; materials: Material[]; notes: Note[]; draft: DayDraft; setDraft: SetDraft; onChanged: () => void }) {
  const { day, materials, notes, draft, setDraft, onChanged } = props;
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [groupName, setGroupName] = useState("");

  useEffect(() => {
    setCommits(null);
    setErr("");
    if (!day) return;
    api<Commit[]>(`/api/git/day?date=${day}`).then(setCommits, (e) => setErr(e.message));
  }, [day]);

  if (!day) return <p className="muted">Select a day in the calendar to see its notes, commits and materials.</p>;

  const dayNotes = notes.filter((n) => n.date === day);
  const dayMaterials = materials.filter((m) => m.date === day);
  const pickedMaterials = dayMaterials.filter((m) => draft.materialIds.includes(m.id));
  const regroup = async (name: string) => {
    setErr("");
    try {
      await setGroup(pickedMaterials.map((m) => m.id), name);
      setGroupName("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const picked = new Set(draft.commits.map((c) => commitRef(c)));
  const toggleCommit = (c: Commit) =>
    setDraft((d) => {
      const adding = !d.commits.some((x) => commitRef(x) === commitRef(c));
      const list = adding ? [...d.commits, c] : d.commits.filter((x) => commitRef(x) !== commitRef(c));
      const form = adding && !d.form.title ? { ...d.form, title: c.subject, summary: d.form.summary || c.body } : d.form;
      return { ...d, commits: list, form };
    });
  const addNote = async () => {
    try {
      await api("/api/notes", "POST", { date: day, text: noteText });
      setNoteText("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const removeNote = async (n: Note) => {
    if (!confirm("Remove this note?")) return;
    await api(`/api/notes/${n.id}`, "DELETE");
    setDraft((d) => ({ ...d, noteIds: d.noteIds.filter((id) => id !== n.id) }));
    onChanged();
  };
  const selected = draft.noteIds.length + draft.commits.length + draft.materialIds.length;

  return (
    <div className="gitday">
      <p className="muted small">
        Tick notes, commits and materials to build a new suggestion on the Suggestions tab.{selected ? ` ${selected} selected.` : ""}
      </p>
      {err ? <div className="error small">{err}</div> : null}

      <div className="label">Notes</div>
      {dayNotes.length ? (
        <div className="commits">
          {dayNotes.map((n) => (
            <div key={n.id} className={`commit ${draft.noteIds.includes(n.id) ? "picked" : ""}`}>
              <input type="checkbox" checked={draft.noteIds.includes(n.id)} onChange={() => toggleIn(setDraft, "noteIds", n.id, n.text.slice(0, 80), n.text)} />
              <div className="grow note-text" onClick={() => toggleIn(setDraft, "noteIds", n.id, n.text.slice(0, 80), n.text)}>{n.text}</div>
              <Button variant="ghost" size="xs" className="text-destructive" onClick={() => removeNote(n)}>remove</Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">No notes for {day}.</p>
      )}
      <div className="row">
        <input className="grow" placeholder="Add a note for this day" value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => (e.key === "Enter" && noteText.trim() ? addNote() : undefined)} />
        <Button variant="outline" size="sm" disabled={!noteText.trim()} onClick={addNote}>Add note</Button>
      </div>

      <div className="label">Commits</div>
      {!commits && !err ? <p className="muted small">Loading…</p> : null}
      {commits && !commits.length ? <p className="muted small">No commits on {day}.</p> : null}
      {commits?.length ? (
        <div className="commits">
          {commits.map((c) => (
            <div key={commitRef(c)} className={`commit ${picked.has(commitRef(c)) ? "picked" : ""}`}>
              <input type="checkbox" checked={picked.has(commitRef(c))} onChange={() => toggleCommit(c)} />
              <div className="grow" onClick={() => setOpen(open === commitRef(c) ? null : commitRef(c))}>
                <div className="subject">{c.subject}</div>
                <div className="muted small">
                  {new Set(commits.map((c) => c.sourceId)).size > 1 ? `${c.sourceLabel} · ` : ""}<CommitLink commit={commitRef(c)} /> · {new Date(c.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {c.files.length} file(s)
                </div>
                {open === commitRef(c) ? (
                  <div className="commit-detail">
                    {c.body ? <pre>{c.body}</pre> : null}
                    <div className="muted small">{c.files.slice(0, 20).map((f) => f.path).join("\n")}{c.files.length > 20 ? `\n… ${c.files.length - 20} more` : ""}</div>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="label">Materials</div>
      {dayMaterials.length ? (
        <>
          <p className="muted small">Click materials to include them. Group selected materials to keep them together: the agent shows a group as one polaroid stack.</p>
          <div className="mgrid small">
            {dayMaterials.map((m) => (
              <MaterialThumb key={m.id} m={m} selected={draft.materialIds.includes(m.id)} onClick={() => toggleIn(setDraft, "materialIds", m.id, m.title, m.annotation)} />
            ))}
          </div>
          {pickedMaterials.length ? (
            <div className="row">
              <GroupOptions materials={materials} />
              <input className="grow" placeholder="Group name, e.g. Landing page drafts" list={GROUPS_LIST} value={groupName} onChange={(e) => setGroupName(e.target.value)} />
              <Button variant="outline" size="sm" disabled={!groupName.trim() || pickedMaterials.length < 2} title={pickedMaterials.length < 2 ? "Select at least two materials" : undefined} onClick={() => regroup(groupName)}>
                Group {pickedMaterials.length} selected
              </Button>
              {pickedMaterials.some((m) => m.group) ? <Button variant="ghost" size="sm" onClick={() => regroup("")}>Ungroup</Button> : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted small">No materials dated {day}.</p>
      )}
      {day ? <DayRecords day={day} /> : null}
      <UploadForm
        compact
        defaultDate={day}
        onDone={(m) => {
          setDraft((d) => ({ ...d, materialIds: [...d.materialIds, ...m.filter((n) => n.date === day).map((n) => n.id)] }));
          onChanged();
        }}
      />
    </div>
  );
}

/** The selected day's new suggestion: written by hand or by the agent from the items ticked on the Activity tab. */
export function NewSuggestion(props: {
  day: string;
  materials: Material[];
  notes: Note[];
  draft: DayDraft;
  setDraft: SetDraft;
  onShowActivity: () => void;
  onCreated: (suggestionId?: string) => void;
  onWriteUp: (parts: Pick<StoryRequest, "description" | "commits" | "notes" | "materialIds">) => void;
}) {
  const { day, materials, notes, draft, setDraft, onShowActivity, onCreated, onWriteUp } = props;
  const [open, setOpen] = useState(false);
  const [poppedOut, setPoppedOut] = useState(false);
  const [msg, setMsg] = useState("");
  const form = draft.form;
  const setForm = (f: typeof form) => setDraft((d) => ({ ...d, form: f }));
  const chosenNotes = notes.filter((n) => draft.noteIds.includes(n.id));
  const chosenMaterials = materials.filter((m) => draft.materialIds.includes(m.id));
  const text = [form.title, form.highlights, form.summary].filter(Boolean).join("\n");
  const selected = chosenNotes.length + draft.commits.length + chosenMaterials.length;
  const anything = selected > 0 || text.trim().length > 0;
  // Ticking items on the Activity tab opens the form, so the selection is visible here.
  const expanded = open || selected > 0 || !!form.title;

  const create = async () => {
    setMsg("");
    try {
      const created = await api<Suggestion>("/api/suggestions", "POST", {
        workDate: day,
        title: form.title.trim() || draft.commits[0]?.subject || chosenNotes[0]?.text.slice(0, 80) || chosenMaterials[0]?.title || "Untitled",
        hook: form.hook,
        summary: form.summary || chosenNotes.map((n) => n.text).join("\n\n"),
        highlights: form.highlights,
        kind: form.kind,
        materialIds: draft.materialIds,
        sources: {
          commits: draft.commits.map((c) => commitRef(c)),
          files: [...new Set(draft.commits.flatMap((c) => c.files.map((f) => f.path)))].slice(0, 30),
          notes: chosenNotes.map((n) => n.text),
        },
      });
      setDraft(emptyDraft());
      setOpen(false);
      setPoppedOut(false);
      onCreated(created.id);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (!expanded)
    return (
      <div className="row new-suggestion-closed">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>New suggestion for {day}</Button>
        <span className="muted small">or tick items on the <button className="crumb" onClick={onShowActivity}>Activity</button> tab</span>
      </div>
    );

  const discard = <Button variant="ghost" size="xs" onClick={() => { setDraft(emptyDraft()); setOpen(false); setPoppedOut(false); }}>Discard</Button>;
  const editor = (
    <div className="card-body writeup">
      {poppedOut ? null : (
        <div className="row">
          <strong className="grow">New suggestion for {day}</strong>
          {discard}
          <PopOutButton onClick={() => setPoppedOut(true)} />
        </div>
      )}
      <div className="small">
        {selected ? (
          <>
            From {[chosenNotes.length && `${chosenNotes.length} note(s)`, draft.commits.length && `${draft.commits.length} commit(s)`, chosenMaterials.length && `${chosenMaterials.length} material(s)`].filter(Boolean).join(", ")} ticked on{" "}
          </>
        ) : (
          <>Tick notes, commits and materials on </>
        )}
        <button className="crumb" onClick={onShowActivity}>Activity</button>
        {selected ? "" : ", write your own text, or both"}.
      </div>
      {chosenNotes.length || draft.commits.length || chosenMaterials.length ? (
        <ul className="draft-items small">
          {chosenNotes.map((n) => <li key={n.id}>Note: {n.text}</li>)}
          {draft.commits.map((c) => <li key={commitRef(c)}>Commit: {c.subject}</li>)}
          {chosenMaterials.map((m) => <li key={m.id}>Material: {m.title}</li>)}
        </ul>
      ) : null}
      <label>Title<input value={form.title} placeholder="How the first prototype started" onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
      <label>Hook<input value={form.hook} onChange={(e) => setForm({ ...form, hook: e.target.value })} /></label>
      <label>Summary<textarea rows={poppedOut ? 12 : 3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>
      <label>What I want to highlight<textarea rows={poppedOut ? 8 : 2} value={form.highlights} placeholder="Your angle and anecdotes" onChange={(e) => setForm({ ...form, highlights: e.target.value })} /></label>
      <label>Kind
        <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Suggestion["kind"] })}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <div className="row editor-actions">
        <Button disabled={!anything} onClick={create}>Create suggestion</Button>
        <Button variant="outline" disabled={!anything} title="The agent uses the ticked items and your text, and searches the activity, suggestions and posts around this day. You review its draft before anything changes." onClick={() => { setPoppedOut(false); onWriteUp({ description: text, commits: draft.commits.map((c) => commitRef(c)), notes: chosenNotes.map((n) => n.text), materialIds: draft.materialIds }); }}>
          Write up with agent
        </Button>
        {poppedOut ? discard : null}
      </div>
      {msg ? <div className="error small">{msg}</div> : null}
    </div>
  );
  return poppedOut ? <PopOutDialog title={`New suggestion for ${day}`} onClose={() => setPoppedOut(false)}>{editor}</PopOutDialog> : editor;
}
