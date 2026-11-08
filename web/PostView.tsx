import { pruneSegmentReferences, scriptCaptureTargets } from "../shared/references";
import { CaptureTargetsContext } from "./project-context";
import { outputStage } from "../shared/outputs";
import { spokenTurns } from "../shared/turns";
import { ArticleStep, PublishStep } from "./PublishViews";
import { CoHostContext, CoHostPanel, PresentationChoice, TurnsEditor, useCoHost } from "./CoHostScript";
import type { PublicConnection } from "../shared/projects";
import React, { useCallback, useContext, useEffect, useState } from "react";
import { ListInput } from "@/components/list-input";
import { Button } from "@/components/ui/button";
import { VideoPlayer } from "./VideoPlayer";
import { api, apiUrl, projectHref, mediaUrl, useJob } from "./api";
import { largeImage, MaterialAttach, MaterialThumb } from "./Materials";
import { sessionPeriod } from "./SessionImages";
import { SuggestionCard } from "./Calendar";
import { SegTabs } from "@/components/seg-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ObjectPicker } from "./ObjectPicker";
import { FramingEditor } from "./FramingEditor";
import { PageShotFields } from "./PageShotFields";
import { ImageStrip, MediaPicker, type MediaItem } from "./MediaPicker";
import { Spinner } from "@/components/ui/spinner";
import { HugeiconsIcon } from "@hugeicons/react";
import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { autoFov, COMPARE_CAPTIONS, FOV_RANGE, STACK_MAX_IMAGES, ANGLE_FRAMING, DISTANCE_PADDING, MOTION_DEFAULTS, type PageCheck, type YouTubeUpload, type ShotAngle, type ShotDistance, type Post, type Format, type MotionType, type Script, type Segment, type TimelineProps, type Visual, type CaptureVisual, type SceneShot, type PageShot, type Material, type Suggestion, newPageShot } from "../shared/types";

const FORMAT_LABEL: Record<Format, string> = { portrait: "Short 9:16", landscape: "Video 16:9" };
const MOTION_UNIT: Record<MotionType, string> = { still: "", orbit: "°", push: "× distance", pan: "m", turn: "°", rise: "m" };
/** Name and one-line description of each camera move, for the move picker. */
const MOTIONS: Array<{ type: MotionType; label: string; help: string }> = [
  { type: "still", label: "Still", help: "No camera move: one frame, held for the whole segment." },
  { type: "orbit", label: "Orbit", help: "Swings around the shot's centre by the given degrees, from half to one side of the framing to half to the other." },
  { type: "push", label: "Push in", help: "Moves toward the shot's centre (the target, or what the middle of the Scene view shows) by the given fraction of the distance." },
  { type: "pan", label: "Pan", help: "Slides sideways by the given metres, view direction unchanged, centred on the framing." },
  { type: "turn", label: "Turn", help: "Swivels on the spot by the given degrees, centred on the framing." },
  { type: "rise", label: "Rise", help: "Moves straight up by the given metres." },
];
/** Where push and orbit centre a Scene view pose, for the label under the shot. */
function sceneCentre(position: [number, number, number], pivot?: [number, number, number], object?: string) {
  if (!pivot) return "centre 20 m ahead";
  const metres = Math.hypot(pivot[0] - position[0], pivot[1] - position[1], pivot[2] - position[2]);
  const distance = metres < 10 ? metres.toFixed(1) : Math.round(metres).toString();
  return object ? `centre on ${object}, ${distance} m ahead` : `nothing in the middle of the view; centre ${distance} m ahead`;
}
const MOTION_HELP = Object.fromEntries(MOTIONS.map((m) => [m.type, m.help])) as Record<MotionType, string>;
const STEPS = ["Questions", "Script & shots", "Preview", "Narration", "Final", "Article", "Publish"] as const;
type Step = (typeof STEPS)[number];

export function PostView({ id, materials, suggestions, onChange }: { id: string; materials: Material[]; suggestions: Suggestion[]; onChange: () => void }) {
  const [ep, setEp] = useState<Post | null>(null);
  const [step, setStep] = useState<Step>("Questions");
  const [format, setFormat] = useState<Format>("portrait");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const e = await api<Post>(`/api/posts/${id}`);
    setEp(e);
    return e;
  }, [id]);
  const [epMaterials, setEpMaterials] = useState<Material[]>([]);
  const loadMaterials = useCallback(() => api<Material[]>(`/api/posts/${id}/materials`).then(setEpMaterials, () => setEpMaterials([])), [id]);
  useEffect(() => {
    loadMaterials();
  }, [loadMaterials, materials, ep?.materialIds.length]);
  const jobs = useJob(() => {
    load();
    onChange();
  });

  useEffect(() => {
    load().then((e) => {
      const first = e.outputs.find((o): o is Format => o !== "article") ?? "portrait";
      setFormat(first);
      const stage = outputStage(e, first);
      setStep(stage === "questions" ? "Questions" : stage === "script" || stage === "capture" ? "Script & shots" : stage === "preview" ? "Preview" : stage === "narrated" ? "Narration" : "Final");
    }, (e) => setErr(e.message));
    api<{ agent: { default: "claude" | "codex" } }>("/api/settings").then((s) => setAgent(s.agent.default));
  }, [load]);

  if (!ep) return <p className="pad">{err || "Loading…"}</p>;

  const save = async (body: Partial<Post>) => {
    setErr("");
    try {
      setEp(await api<Post>(`/api/posts/${id}`, "PATCH", body));
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const run = async (url: string, body?: object) => {
    setErr("");
    try {
      await jobs.start(url, { agent, ...body });
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="episode">
      <div className="ep-head">
        <input className="ep-title" value={ep.title} onChange={(e) => setEp({ ...ep, title: e.target.value })} onBlur={() => save({ title: ep.title })} />
        <label className="inline-field">
          Publish
          <PublishFields date={ep.publishDate} time={ep.publishTime} onSave={save} />
        </label>
        <label className="check"><input type="checkbox" checked={ep.outputs.includes("portrait")} onChange={(e) => save({ outputs: e.target.checked ? [...new Set([...ep.outputs, "portrait" as Format])] : ep.outputs.filter((f) => f !== "portrait") })} /> Short 9:16</label>
        <label className="check"><input type="checkbox" checked={ep.outputs.includes("landscape")} onChange={(e) => save({ outputs: e.target.checked ? [...new Set([...ep.outputs, "landscape" as Format])] : ep.outputs.filter((f) => f !== "landscape") })} /> Video 16:9</label>
        <select value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")} title="Agent CLI">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <Button
          variant="ghost"
          size="sm"
          title="Delete this post and return its suggestions to the approved list"
          onClick={async () => {
            const lost = [ep.questions.length ? "questions and answers" : "", Object.keys(ep.scripts).length ? "scripts" : "", Object.values(ep.renders).some((r) => r?.draft || r?.final) ? "captures and renders" : ""].filter(Boolean);
            if (!confirm(`Turn "${ep.title}" back into suggestions?

The post is deleted${lost.length ? `, with its ${lost.join(", ")}` : ""}. Its suggestions return to the approved list. Final videos in the output folder stay.`)) return;
            setErr("");
            try {
              await api(`/api/posts/${ep.id}`, "DELETE");
              onChange();
              location.hash = projectHref("/calendar");
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Back to suggestions…
        </Button>
      </div>
      <div className="steps">
        <SegTabs variant="line" value={step} onChange={setStep} items={STEPS.map((s, i) => ({ value: s, label: `${i + 1}. ${s}` }))} />
        {step !== "Questions" && step !== "Article" && step !== "Publish" ? (
          <div className="right row">
            <span className="muted small">Format</span>
            <SegTabs value={format} onChange={setFormat} items={ep.outputs.filter((f): f is Format => f !== "article").map((f) => ({ value: f, label: FORMAT_LABEL[f] }))} />
          </div>
        ) : null}
      </div>
      {err ? <div className="error">{err}</div> : null}

      {step === "Questions" ? <QuestionsStep ep={ep} setEp={setEp} save={save} run={run} busy={jobs.running} next={() => setStep("Script & shots")} materials={materials} epMaterials={epMaterials} onUploaded={() => { onChange(); load(); }} topics={ep.suggestionIds.map((sid) => suggestions.find((s) => s.id === sid)).filter((s): s is Suggestion => !!s)} onPatchTopic={async (sid, body) => { setErr(""); try { await api(`/api/suggestions/${sid}`, "PATCH", body); onChange(); loadMaterials(); } catch (e) { setErr((e as Error).message); } }} /> : null}
      {step === "Script & shots" ? <ScriptStep key={format} ep={ep} format={format} epMaterials={epMaterials} allMaterials={materials} run={run} busy={jobs.running} reload={load} /> : null}
      {step === "Preview" ? <PreviewStep ep={ep} format={format} run={run} busy={jobs.running} narrated={false} /> : null}
      {step === "Narration" ? <NarrationStep ep={ep} format={format} run={run} busy={jobs.running} /> : null}
      {step === "Final" ? <FinalStep ep={ep} format={format} run={run} busy={jobs.running} reload={load} /> : null}
      {step === "Article" ? <ArticleStep ep={ep} run={run} busy={jobs.running} reload={load} /> : null}
      {step === "Publish" ? <PublishStep ep={ep} run={run} busy={jobs.running} /> : null}
    </div>
  );
}

type RunFn = (url: string, body?: object) => Promise<void>;

function QuestionsStep(props: {
  ep: Post;
  setEp: (e: Post) => void;
  save: (b: Partial<Post>) => Promise<void>;
  run: RunFn;
  busy: boolean;
  next: () => void;
  materials: Material[];
  epMaterials: Material[];
  onUploaded: () => void;
  topics: Suggestion[];
  onPatchTopic: (id: string, body: Partial<Suggestion>) => Promise<void>;
}) {
  const { ep, setEp, save, run, busy, next, materials, epMaterials, onUploaded, topics, onPatchTopic } = props;
  const fromSuggestions = epMaterials.filter((m) => !ep.materialIds.includes(m.id));
  return (
    <div className="panel">
      <div className="materials-box">
        <div className="label">Topics</div>
        <p className="muted small">The suggestions this video tells. Edit them here before the agent researches; questions and the script read them as saved.</p>
        {topics.map((s) => (
          <SuggestionCard key={s.id} s={s} materials={materials} inPost startOpen={topics.length === 1} onPatch={(body) => void onPatchTopic(s.id, body)} reload={onUploaded} />
        ))}
      </div>
      <div className="materials-box">
        <div className="label">Materials for this video</div>
        <p className="muted small">Screenshots and videos with their story. The agent reads the annotations and looks at the images before it asks questions and writes the script; the script can show them.</p>
        {fromSuggestions.length ? (
          <>
            <div className="muted small">From the topics ({fromSuggestions.length}); change these on the topic above:</div>
            <div className="mgrid small">
              {fromSuggestions.map((m) => (
                <MaterialThumb key={m.id} m={m} onClick={() => window.open(mediaUrl(m.key), "_blank")} />
              ))}
            </div>
            <div className="muted small">Added for this video:</div>
          </>
        ) : null}
        <MaterialAttach attached={ep.materialIds} all={materials} onChange={(ids) => save({ materialIds: ids })} attach={{ postId: ep.id }} onUploaded={onUploaded} onEdited={onUploaded} sessions={{ records: topics.flatMap((t) => t.sources.sessions ?? []), ...sessionPeriod(topics.map((t) => t.workDate)) }} />
      </div>
      <label>
        Direction for this video (optional)
        <textarea rows={3} value={ep.brief} placeholder="Angle, tone, what must be in it, what to avoid…" onChange={(e) => setEp({ ...ep, brief: e.target.value })} onBlur={() => save({ brief: ep.brief })} />
      </label>
      <div className="row">
        <Button disabled={busy} onClick={() => run(`/api/posts/${ep.id}/questions`)}>
          {ep.questions.length ? "Ask more questions" : "Let the agent research and ask questions"}
        </Button>
        <Button variant="outline" onClick={next}>Skip to script</Button>
      </div>
      <PresentationChoice ep={ep} setEp={setEp} />
      {ep.questions.map((q, i) => (
        <div key={q.id} className="question">
          <div className="q">{q.question}</div>
          {q.why ? <div className="muted small">{q.why}</div> : null}
          <textarea
            rows={2}
            value={q.answer}
            onChange={(e) => {
              const questions = [...ep.questions];
              questions[i] = { ...q, answer: e.target.value };
              setEp({ ...ep, questions });
            }}
            onBlur={() => save({ questions: ep.questions })}
          />
        </div>
      ))}
      {ep.questions.length ? (
        <Button onClick={async () => { await save({ questions: ep.questions }); next(); }}>Save answers and continue</Button>
      ) : null}
    </div>
  );
}

/**
 * The publish date and time, saved on leaving a field. They keep their own draft, so typing changes nothing else on
 * the page: while a year is typed, the field passes through dates such as 0002-11-08.
 */
function PublishFields({ date, time, onSave }: { date?: string; time?: string; onSave: (body: Partial<Post>) => Promise<void> }) {
  const [draft, setDraft] = useState({ date: date ?? "", time: time ?? "" });
  useEffect(() => { setDraft({ date: date ?? "", time: time ?? "" }); }, [date, time]);
  return (
    <>
      <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} onBlur={() => { if (draft.date !== (date ?? "")) void onSave({ publishDate: draft.date || undefined }); }} />
      <input type="time" value={draft.time} title="Publish time; empty uses the default from Settings" onChange={(e) => setDraft({ ...draft, time: e.target.value })} onBlur={() => { if (draft.time !== (time ?? "")) void onSave({ publishTime: draft.time || undefined }); }} />
    </>
  );
}

function ScriptStep(props: { ep: Post; format: Format; epMaterials: Material[]; allMaterials: Material[]; run: RunFn; busy: boolean; reload: () => Promise<Post> }) {
  const { targets } = useContext(CaptureTargetsContext);
  const { ep, format, epMaterials, allMaterials, run, busy, reload } = props;
  /** Which control started the running job: "all", or a segment id plus its action. */
  const [pending, setPending] = useState<{ segment?: string; action: string } | null>(null);
  useEffect(() => {
    if (!busy) setPending(null);
  }, [busy]);
  const [script, setScript] = useState<Script | undefined>(ep.scripts[format]);
  const [baseTargets, setBaseTargets] = useState(() => scriptCaptureTargets(ep.scripts[format]));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) { setScript(ep.scripts[format]); setBaseTargets(scriptCaptureTargets(ep.scripts[format])); }
  }, [ep, format]);
  const [pageChecks, setPageChecks] = useState<{ checks: Record<string, PageCheck | null>; unlisted: string[] }>({ checks: {}, unlisted: [] });
  useEffect(() => {
    api<{ checks: Record<string, PageCheck | null>; unlisted: string[] }>(`/api/posts/${ep.id}/links/${format}`).then(setPageChecks, () => setPageChecks({ checks: {}, unlisted: [] }));
  }, [ep, format, busy]);
  const hasPages = !!script?.segments.some((s) => s.visual.type === "capture" && s.visual.shot.model === "page");
  const missingImages = script?.segments.filter((s) => s.visual.type === "material" && !s.visual.materialId && s.visual.description.trim()).length ?? 0;

  const update = (fn: (s: Script) => void) => {
    if (!script) return;
    const next = structuredClone(script);
    fn(next);
    setScript(next);
    setDirty(true);
  };
  const persist = async () => {
    if (!script) return;
    const saved = await api<Post>(`/api/posts/${ep.id}/script/${format}`, "PUT", { ...script, baseCaptureTargets: baseTargets });
    setScript(saved.scripts[format]);
    setBaseTargets(scriptCaptureTargets(saved.scripts[format]));
    setDirty(false);
    await reload();
  };
  /** Capture actions save pending edits first, so they always use what is on screen. */
  /** Saves pending edits, then goes back to a segment's previous take for this format. */
  const previousTake = async (segmentId: string) => {
    if (dirty) await persist();
    await api(`/api/posts/${ep.id}/segments/${segmentId}/previous-take/${format}`, "POST");
    await reload();
  };
  const runSaved: RunFn = async (url, body) => {
    if (dirty) await persist();
    await run(url, body);
  };
  /**
   * Drag-and-drop reordering. A row becomes draggable only while its handle is pressed, so text fields and
   * selects inside it keep working. `dropAt` is the insertion index: 0 is before the first segment, length after the last.
   */
  const [armed, setArmed] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const endDrag = () => {
    setArmed(null);
    setDragFrom(null);
    setDropAt(null);
  };
  // A press released anywhere other than the handle, without a drag, disarms the row as well.
  useEffect(() => {
    if (armed === null) return;
    const up = () => setArmed(null);
    window.addEventListener("pointerup", up, { once: true });
    return () => window.removeEventListener("pointerup", up);
  }, [armed]);
  const moveSegment = (from: number, insertAt: number) => {
    const to = insertAt > from ? insertAt - 1 : insertAt;
    if (to !== from) update((s) => s.segments.splice(to, 0, ...s.segments.splice(from, 1)));
  };
  const words = script?.segments.flatMap(spokenTurns).reduce((n, t) => n + t.text.trim().split(/\s+/).length, 0) ?? 0;
  const coHosted = ep.presentation?.[format] === "coHost";
  const { info: coHostInfo, refresh: refreshCoHost } = useCoHost(ep, format);

  return (
    <CoHostContext.Provider value={{ info: coHostInfo, refresh: refreshCoHost, dirty, postId: ep.id, format }}>
    <div className="panel">
      <div className="row">
        <Button disabled={busy} onClick={() => run(`/api/posts/${ep.id}/script/${format}`)}>
          {script ? "Rewrite script" : "Write script & shot list"}
        </Button>
        <Button variant="outline" disabled={!dirty} onClick={persist}>Save edits</Button>
        {dirty ? <span className="small" style={{ color: "var(--highlight)" }}>Unsaved changes</span> : null}
        {script ? <span className="muted">{script.segments.length} segments · {words} words · ≈{Math.round(words / 2.5)} s</span> : null}
        <span className="grow" />
        {missingImages ? (
          <Button variant="outline" disabled={busy} title="Codex generates an image for each material segment without one, from its description. The video credits each as an AI-generated image." onClick={() => { setPending({ action: "images" }); runSaved(`/api/posts/${ep.id}/images/${format}`); }}>
            {pending?.action === "images" ? <Spinner /> : null}
            {pending?.action === "images" ? "Generating images…" : `Generate missing images (${missingImages})`}
          </Button>
        ) : null}
        {hasPages ? (
          <Button variant="outline" disabled={busy} title={dirty ? "Saves your edits, then opens each webpage shot's page without filming it" : "Opens each webpage shot's page without filming it"} onClick={() => { setPending({ action: "links" }); runSaved(`/api/posts/${ep.id}/links/${format}`); }}>
            {pending?.action === "links" ? <Spinner /> : null}
            {pending?.action === "links" ? "Checking links…" : "Check links"}
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={busy || !script}
          onClick={() => {
            setPending({ action: "all" });
            runSaved(`/api/posts/${ep.id}/capture/${format}`);
          }}
          title={dirty ? "Saves your edits, then captures" : ""}
        >
          {pending?.action === "all" ? <Spinner /> : null}
          {pending?.action === "all" ? "Capturing…" : "Capture shots"}
        </Button>
      </div>
      {!script ? <p className="muted">No script yet.{coHosted ? " The agent writes this one as a conversation." : ""}</p> : null}
      {script && coHosted ? <CoHostPanel script={script} format={format} dirty={dirty} busy={busy} onCheck={() => runSaved(`/api/posts/${ep.id}/verify/${format}`)} /> : null}
      {script ? (
        <>
          <label>Title<input value={script.title} onChange={(e) => update((s) => (s.title = e.target.value))} /></label>
          {script.segments.map((seg, i) => (
            <div
              key={seg.id}
              className={`seg-drag ${dragFrom === i ? "dragging" : ""} ${dropAt === i && dragFrom !== null ? "drop-before" : ""} ${dropAt === i + 1 && i === script.segments.length - 1 && dragFrom !== null ? "drop-after" : ""}`}
              draggable={armed === i}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", seg.id);
                setDragFrom(i);
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const r = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null && dropAt !== null) moveSegment(dragFrom, dropAt);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
            <SegmentEditor
              pageCheck={pageChecks.checks[seg.id]}
              linkUnlisted={pageChecks.unlisted.includes(seg.id)}
              onHandle={(down) => setArmed(down ? i : null)}
              ep={ep}
              seg={seg}
              index={i}
              all={script.segments}
              epMaterials={epMaterials}
              allMaterials={allMaterials}
              busy={busy}
              pending={pending?.segment === seg.id ? pending.action : undefined}
              onStart={(action) => setPending({ segment: seg.id, action })}
              format={format}
              onChange={(next) => update((s) => (s.segments[i] = next))}
              onMove={(d) => moveSegment(i, d < 0 ? i - 1 : i + 2)}
              onDelete={() => update((s) => { const removed = s.segments.splice(i, 1); pruneSegmentReferences(s, removed.map((segment) => segment.id)); })}
              run={runSaved}
              onPreviousTake={() => previousTake(seg.id)}
            />
            </div>
          ))}
          <div className="row">
            <Button variant="outline" onClick={() => update((s) => s.segments.push({ id: `seg-${Date.now().toString(36)}`, narration: "", ...(coHosted ? { turns: [] } : {}), visual: targets.length ? { type: "capture", description: "", shot: { model: "scene", motion: { type: "still" } } } : { type: "material", description: "" } }))}>Add segment</Button>
          </div>
          <details>
            <summary>Platform metadata</summary>
            <label>Title<input value={script.metadata.title} onChange={(e) => update((s) => (s.metadata.title = e.target.value))} /></label>
            <label>Description<textarea rows={4} value={script.metadata.description} onChange={(e) => update((s) => (s.metadata.description = e.target.value))} /><span className="field-hint">Viewers see it. Leave out hashtags: for a Short, the published description ends with #Shorts and hashtags made from the first two tags, which YouTube shows above the title.</span></label>
            <label>Tags<ListInput value={script.metadata.tags} onChange={(tags) => update((s) => (s.metadata.tags = tags))} /><span className="field-hint">YouTube's Tags field: viewers don't see them, and YouTube says they play only a minimal role in discovery, mostly for words people often misspell. Use 5–8 terms that describe what the video shows, without #, and put the two broadest first: a Short turns them into its hashtags. Unrelated or too many tags can count as misleading metadata.</span></label>
          </details>
        </>
      ) : null}
    </div>
    </CoHostContext.Provider>
  );
}

function SegmentEditor(props: {
  ep: Post;
  seg: Segment;
  index: number;
  all: Segment[];
  epMaterials: Material[];
  allMaterials: Material[];
  busy: boolean;
  /** The action of this segment that started the running job, if any. */
  pending?: string;
  onStart: (action: string) => void;
  format: Format;
  onChange: (s: Segment) => void;
  /** Moves the segment one place up (-1) or down (1); used by the handle's arrow keys. */
  onMove: (d: number) => void;
  /** Reports pressing (true) and releasing (false) the drag handle. */
  onHandle: (down: boolean) => void;
  onDelete: () => void;
  run: RunFn;
  onPreviousTake: () => Promise<void>;
  /** The latest check of a webpage shot's page. */
  pageCheck?: PageCheck | null;
  /** The feed entries behind the post don't name this source shot's link. */
  linkUnlisted?: boolean;
}) {
  const { ep, seg, index, all, epMaterials, allMaterials, busy, pending, onStart, format, onChange, onMove, onHandle, onDelete, run, onPreviousTake, pageCheck, linkUnlisted } = props;
  const takes = seg.takes?.[format] ?? [];
  // Slides aren't captured, and a material segment's note to record its footage is stale once a material is chosen.
  const captureError = seg.visual.type === "slide" || (seg.visual.type === "material" && seg.visual.materialId) ? undefined : seg.captureError;
  const takeButton = takes.length > 1 ? (
    <Button
      variant="ghost"
      disabled={busy}
      title={`Take ${takes.length} of ${takes.length}. Goes back to the previous capture and the settings that produced it.`}
      onClick={() => {
        const previous = takes[takes.length - 2];
        const when = previous.capturedAt ? new Date(previous.capturedAt).toLocaleString() : "an earlier capture";
        if (confirm(`Discard this take and go back to the previous one (${when})?`)) void onPreviousTake().catch((e) => alert((e as Error).message));
      }}
    >
      Previous take
    </Button>
  ) : null;
  const byId = new Map(allMaterials.map((m) => [m.id, m]));
  const others = allMaterials.filter((m) => !epMaterials.some((e) => e.id === m.id));
  const { targets, defaultId } = useContext(CaptureTargetsContext);
  type EditableVisual = Exclude<Visual, CaptureVisual> | (Omit<CaptureVisual, "shot"> & SceneShot) | (Omit<CaptureVisual, "shot"> & PageShot);
  /** Browser targets film page shots; Unity and Blender targets film scene shots. */
  const shotFor = (targetId: string | undefined, current?: SceneShot | PageShot): SceneShot | PageShot => {
    const kind = targets.find((t) => t.id === (targetId ?? defaultId))?.kind;
    const model = kind === "browser" ? "page" : "scene";
    if (current?.model === model) return current;
    return model === "page" ? newPageShot() : { model: "scene", motion: { type: "still" } };
  };
  const blender = (id: string | undefined) => targets.find((t) => t.id === (id ?? defaultId))?.kind === "blender-mcp";
  const v: EditableVisual = seg.visual.type === "capture" ? { type: "capture", description: seg.visual.description, targetId: seg.visual.targetId, ...seg.visual.shot } : seg.visual;
  const setVisual = (nv: EditableVisual) => {
    if (nv.type === "capture") {
      const { type, description, targetId, ...shot } = nv;
      onChange({ ...seg, visual: { type, description, targetId, shot } });
    } else onChange({ ...seg, visual: nv });
  };
  const media = seg.media?.[format];
  const chosen = v.type === "material" && v.materialId ? byId.get(v.materialId) : undefined;
  const thumb = chosen ? mediaUrl(chosen.thumbKey) : media ? `${mediaUrl(media.replace(/\.mp4$/, ".jpg"))}?v=${seg.capturedAt ?? 0}` : undefined;
  const videoSrc = chosen ? (chosen.kind === "video" ? mediaUrl(chosen.key) : chosen.clipKey ? mediaUrl(chosen.clipKey) : undefined) : media && /\.mp4$/.test(media) ? `${mediaUrl(media)}?v=${seg.capturedAt ?? 0}` : undefined;
  const [picker, setPicker] = useState<"material" | "slide" | null>(null);
  const materialItem = (m: Material, source: MediaItem["source"]): MediaItem => ({ id: m.id, source, thumb: mediaUrl(m.thumbKey), preview: largeImage(m), title: m.title, date: m.date, group: m.group, annotation: m.annotation, isVideo: m.kind === "video" });
  const materialItems = [...epMaterials.map((m) => materialItem(m, "video")), ...others.map((m) => materialItem(m, "library"))];
  /** A segment's frame as slides show it: its material, or its capture for this format. */
  const segmentThumb = (s: Segment) => {
    if (s.visual.type === "material") return s.visual.materialId && byId.get(s.visual.materialId) ? mediaUrl(byId.get(s.visual.materialId)!.thumbKey) : undefined;
    const key = s.media?.[format];
    return key ? `${mediaUrl(key.replace(/\.mp4$/, ".jpg"))}?v=${s.capturedAt ?? 0}` : undefined;
  };
  const slideItems: MediaItem[] = [
    ...all.filter((s) => s.id !== seg.id && s.visual.type !== "slide").map((s): MediaItem => ({ id: s.id, source: "shot", thumb: segmentThumb(s), title: `#${all.indexOf(s) + 1} ${s.onScreen || (s.visual.type !== "slide" ? s.visual.description : "")}`.trim(), annotation: s.narration })),
    ...materialItems,
  ];
  const changeType = (type: Visual["type"]) => {
    if (type === "capture") setVisual({ type, description: "", ...shotFor(undefined) });
    if (type === "material") setVisual({ type, description: "" });
    if (type === "slide") setVisual({ type, layout: "bullets", heading: "" });
  };
  return (
    <div className={`segment ${captureError ? "has-error" : ""}`}>
      <div className="seg-index">
        <span>{index + 1}</span>
        <span
          className="seg-handle"
          role="button"
          tabIndex={0}
          aria-label={`Move segment ${index + 1}: drag, or press the up and down arrow keys`}
          title="Drag to reorder"
          onPointerDown={() => onHandle(true)}
          onPointerUp={() => onHandle(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && index > 0) onMove(-1);
            else if (e.key === "ArrowDown" && index < all.length - 1) onMove(1);
            else return;
            e.preventDefault();
          }}
        >
          <HugeiconsIcon icon={DragDropVerticalIcon} className="size-4" />
        </span>
        <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={onDelete}>✕</Button>
      </div>
      <div className="seg-text">
        {ep.presentation?.[format] === "coHost" ? <TurnsEditor seg={seg} onChange={onChange} /> : <textarea rows={3} placeholder="Narration" value={seg.narration} onChange={(e) => onChange({ ...seg, narration: e.target.value })} />}
        {ep.presentation?.[format] !== "coHost" && seg.agentNarration !== undefined && seg.agentNarration !== seg.narration ? (
          <div className="muted small edited" title={`Agent's version: ${seg.agentNarration || "(no narration)"}`}>
            Edited · agent wrote: “{seg.agentNarration || "(no narration)"}”
            <Button variant="link" size="xs" onClick={() => onChange({ ...seg, narration: seg.agentNarration ?? "" })}>restore</Button>
          </div>
        ) : null}
        <input placeholder="On-screen label (optional)" value={seg.onScreen ?? ""} onChange={(e) => onChange({ ...seg, onScreen: e.target.value || undefined })} />
      </div>
      <div className="seg-visual">
        <div className="row">
          <select value={v.type} onChange={(e) => changeType(e.target.value as Visual["type"])}>
            <option value="capture" disabled={!targets.length}>Capture shot</option>
            <option value="material">Material</option>
            <option value="slide">Slide</option>
          </select>
          {v.type === "capture" && v.model === "scene" ? (
            <>
              <Select value={v.motion.type} onValueChange={(type) => setVisual({ ...v, motion: { type: type as MotionType, amount: MOTION_DEFAULTS[type as MotionType] } })}>
                <SelectTrigger size="sm" className="motion-trigger" title={MOTION_HELP[v.motion.type]}>
                  <SelectValue>{MOTIONS.find((m) => m.type === v.motion.type)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {MOTIONS.map((m) => (
                    <SelectItem key={m.type} value={m.type} className="motion-item">
                      <span className="motion-label">{m.label}</span>
                      <span className="motion-help">{m.help}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {v.motion.type !== "still" ? (
                <>
                <input className="numin" type="number" step="any" value={v.motion.amount ?? MOTION_DEFAULTS[v.motion.type]} onChange={(e) => setVisual({ ...v, motion: { ...v.motion, amount: Number(e.target.value) } })} title={MOTION_HELP[v.motion.type]} />
                <span className="muted small">{MOTION_UNIT[v.motion.type]}</span>
                </>
              ) : null}
            </>
          ) : null}
          {v.type === "slide" ? (
            <select value={v.layout} onChange={(e) => setVisual({ ...v, layout: e.target.value as typeof v.layout })}>
              {["title", "bullets", "image", "compare", "stack", "outro"].map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          ) : null}
        </div>
        {v.type === "capture" ? (
          <>
            <label>
              Capture target
              <select
                value={v.targetId ?? ""}
                onChange={(e) => {
                  const targetId = e.target.value || undefined;
                  const { type: _t, description, targetId: _old, ...shot } = v;
                  setVisual({ type: "capture", description, targetId, ...shotFor(targetId, shot as SceneShot | PageShot) });
                }}
              >
                <option value="">Project default</option>
                {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
            </label>
            <input placeholder="What the shot shows" value={v.description} onChange={(e) => setVisual({ ...v, description: e.target.value })} />
          </>
        ) : null}
        {v.type === "capture" && v.model === "page" ? (
          <PageShotFields shot={v} format={format} check={pageCheck} unlisted={linkUnlisted} onChange={(shot) => setVisual({ ...v, ...shot })}>
            <Button variant="outline" disabled={busy} onClick={() => { onStart("recapture"); run(`/api/posts/${ep.id}/capture/${format}`, { segmentId: seg.id }); }}>
              {pending === "recapture" ? <Spinner /> : null}
              {pending === "recapture" ? "Filming…" : media ? "Film again" : "Film page"}
            </Button>
            {takeButton}
          </PageShotFields>
        ) : null}
        {v.type === "capture" && v.model === "scene" ? (
          <>
            <input placeholder={`Target object path (or use ${blender(v.targetId) ? "3D view" : "Scene view"})`} value={v.target ?? ""} onChange={(e) => setVisual({ ...v, target: e.target.value || undefined, pose: undefined, pivot: undefined })} />
            <ObjectPicker targetId={v.targetId} editor={blender(v.targetId) ? "Blender" : "Unity"} onPick={(path) => setVisual({ ...v, target: path, pose: undefined, pivot: undefined })} />
            {v.target && !v.pose ? (
              <div className="row">
                <select value={v.angle ?? "three-quarter"} onChange={(e) => setVisual({ ...v, angle: e.target.value as ShotAngle })}>
                  {Object.keys(ANGLE_FRAMING).map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <select value={v.distance ?? "medium"} onChange={(e) => setVisual({ ...v, distance: e.target.value as ShotDistance })}>
                  {Object.keys(DISTANCE_PADDING).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            ) : null}
            <div className="row" title="Vertical field of view in degrees. Lower values zoom in (telephoto), higher values widen the view. An end value zooms the lens during the shot.">
              <span className="muted small">FOV</span>
              <input
                className="numin fovin"
                type="number"
                min={FOV_RANGE.min}
                max={FOV_RANGE.max}
                step="any"
                placeholder={`auto ${Math.round(autoFov(format, v.pose?.fov))}`}
                value={v.fov ?? ""}
                onChange={(e) => setVisual({ ...v, fov: e.target.value === "" ? undefined : Math.min(FOV_RANGE.max, Math.max(FOV_RANGE.min, Number(e.target.value))) })}
              />
              <span className="muted small">→</span>
              <input
                className="numin fovin"
                type="number"
                min={FOV_RANGE.min}
                max={FOV_RANGE.max}
                step="any"
                placeholder="same"
                value={v.fovEnd ?? ""}
                onChange={(e) => setVisual({ ...v, fovEnd: e.target.value === "" ? undefined : Math.min(FOV_RANGE.max, Math.max(FOV_RANGE.min, Number(e.target.value))) })}
              />
              <span className="muted small">° vertical</span>
            </div>
            {blender(v.targetId) ? (
              <label className="check" title="Plays the Blender file's timeline during the shot, and repeats it when the shot is longer.">
                <input type="checkbox" checked={!!v.playTimeline} onChange={(e) => setVisual({ ...v, playTimeline: e.target.checked || undefined })} />
                Play the timeline
              </label>
            ) : null}
            <div className="row">
              <Button variant="outline" disabled={busy} title={blender(v.targetId) ? "Frame the shot in Blender's 3D view, then click" : "Frame the shot in Unity's Scene view, then click"} onClick={() => { onStart("scene"); run(`/api/posts/${ep.id}/segments/${seg.id}/scene-view`); }}>
                {pending === "scene" ? <Spinner /> : null}
                {pending === "scene" ? "Capturing…" : blender(v.targetId) ? "Use 3D view" : "Use Scene view"}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => { onStart("recapture"); run(`/api/posts/${ep.id}/capture/${format}`, { segmentId: seg.id }); }}>
                {pending === "recapture" ? <Spinner /> : null}
                {pending === "recapture" ? "Capturing…" : "Recapture"}
              </Button>
              {takeButton}
              {v.pose ? (
                <span className="muted small" title="Push and orbit move around this centre. To change it, point the middle of the Scene view at another spot and use the Scene view again.">
                  Scene view pose · {sceneCentre(v.pose.position, v.pivot, v.pivotObject)}
                </span>
              ) : null}
            </div>
          </>
        ) : null}
        {v.type === "material" ? (
          <>
            <input placeholder="What it shows, or what to record" value={v.description} onChange={(e) => setVisual({ ...v, description: e.target.value })} />
            <div className="row">
              <ImageStrip ids={v.materialId ? [v.materialId] : []} items={materialItems} max={1} onChange={(ids) => setVisual({ ...v, materialId: ids[0], framing: undefined })} onAdd={() => setPicker("material")} onTileClick={() => setPicker("material")} />
              {chosen?.kind === "video" ? <label className="small">Start at<input className="numin" type="number" step="0.1" min="0" value={v.trimStart ?? 0} onChange={(e) => setVisual({ ...v, trimStart: Number(e.target.value) })} title="Start offset in seconds" /></label> : null}
              <a href={projectHref("/materials")} className="small">upload in Materials</a>
              {v.description.trim() && (!chosen || chosen.generated) ? (
                <Button variant="outline" size="sm" disabled={busy} title="Codex generates an image from the description and adds it to the materials. The video credits it as an AI-generated image." onClick={() => { onStart("image"); run(`/api/posts/${ep.id}/images/${format}`, { segmentId: seg.id }); }}>
                  {pending === "image" ? <Spinner /> : null}
                  {pending === "image" ? "Generating…" : chosen ? "Generate again" : "Generate image"}
                </Button>
              ) : null}
            </div>
            <MediaPicker
              open={picker === "material"}
              onOpenChange={(o) => setPicker(o ? "material" : null)}
              title="Choose material"
              items={materialItems}
              max={1}
              selected={v.materialId ? [v.materialId] : []}
              onInsert={(ids) => setVisual({ ...v, materialId: ids[0], framing: ids[0] === v.materialId ? v.framing : undefined })}
            />
            {chosen?.width && chosen.height ? (
              <details className="framing-box">
                <summary className="small">Framing{v.framing ? " · custom" : ""}</summary>
                <FramingEditor
                  src={mediaUrl(chosen.previewKey)}
                  width={chosen.width}
                  height={chosen.height}
                  kind={chosen.kind}
                  format={format}
                  framing={v.framing}
                  onChange={(framing) => setVisual({ ...v, framing })}
                />
              </details>
            ) : null}
          </>
        ) : null}
        {v.type === "slide" ? (
          <>
            <input placeholder="Heading" value={v.heading} onChange={(e) => setVisual({ ...v, heading: e.target.value })} />
            {v.layout === "bullets" ? <textarea rows={3} placeholder="One bullet per line" value={(v.bullets ?? []).join("\n")} onChange={(e) => setVisual({ ...v, bullets: e.target.value.split("\n") })} /> : null}
            {v.layout === "image" || v.layout === "compare" || v.layout === "stack" ? (() => {
              const max = v.layout === "image" ? 1 : v.layout === "compare" ? 2 : STACK_MAX_IMAGES;
              const ids = (v.imageFrom ?? []).slice(0, max);
              const labels = v.layout === "compare" ? COMPARE_CAPTIONS : undefined;
              const titleOf = (id: string) => slideItems.find((i) => i.id === id)?.title ?? "";
              const captions = {
                value: v.captions ?? {},
                placeholder: (id: string, k: number) => (v.layout === "compare" ? COMPARE_CAPTIONS[k] ?? "" : v.layout === "stack" && v.titleCaptions ? titleOf(id) : ""),
                onChange: (id: string, text: string) => {
                  const next = { ...(v.captions ?? {}) };
                  if (text) next[id] = text;
                  else delete next[id];
                  setVisual({ ...v, captions: Object.keys(next).length ? next : undefined });
                },
              };
              return (
                <>
                  {v.layout === "stack" ? (
                    <div className="row">
                      <span className="muted small">Polaroids</span>
                      <select value={v.entrance ?? "drop"} onChange={(e) => setVisual({ ...v, entrance: e.target.value as "drop" | "slide" })}>
                        <option value="drop">drop from the top</option>
                        <option value="slide">slide in from the sides</option>
                      </select>
                      <label className="row small" title="Pictures without their own caption show their image title">
                        <input type="checkbox" checked={!!v.titleCaptions} onChange={(e) => setVisual({ ...v, titleCaptions: e.target.checked || undefined })} />
                        Image titles as captions
                      </label>
                    </div>
                  ) : null}
                  <ImageStrip ids={ids} items={slideItems} max={max} labels={labels} captions={captions} onChange={(imageFrom) => setVisual({ ...v, imageFrom })} onAdd={() => setPicker("slide")} onTileClick={() => setPicker("slide")} />
                  <MediaPicker
                    open={picker === "slide"}
                    onOpenChange={(o) => setPicker(o ? "slide" : null)}
                    title={v.layout === "compare" ? "Choose before and after" : v.layout === "stack" ? "Choose polaroids" : "Choose image"}
                    items={slideItems}
                    max={max}
                    selected={ids}
                    onInsert={(imageFrom) => setVisual({ ...v, imageFrom })}
                  />
                </>
              );
            })() : null}
          </>
        ) : null}
        {captureError && !pending ? <div className="error small">{captureError}</div> : null}
      </div>
      <div className={`seg-thumb ${pending ? "working" : ""}`}>
        {videoSrc ? (
          <video key={videoSrc} src={videoSrc} poster={thumb} className={format} controls muted loop playsInline preload="metadata" />
        ) : thumb ? (
          <img src={thumb} className={format} />
        ) : (
          <div className={`ph ${format}`}>{v.type === "slide" ? "slide" : "no capture"}</div>
        )}
        {pending ? <div className="thumb-busy"><Spinner className="size-6" /></div> : null}
      </div>
    </div>
  );
}

function useTimeline(ep: Post, format: Format, narrated: boolean) {
  const [t, setT] = useState<TimelineProps | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setErr("");
    api<TimelineProps>(`/api/posts/${ep.id}/timeline/${format}${narrated ? "?narrated=1" : ""}`).then(setT, (e) => {
      setT(null);
      setErr(e.message);
    });
  }, [ep, format, narrated]);
  return { t, err };
}

function Preview({ t }: { t: TimelineProps }) {
  const portrait = t.format === "portrait";
  return (
    <div className={`player ${portrait ? "portrait" : "landscape"}`}>
      <VideoPlayer timeline={t} />
    </div>
  );
}

function PreviewStep({ ep, format, run, busy, narrated }: { ep: Post; format: Format; run: RunFn; busy: boolean; narrated: boolean }) {
  const { t, err } = useTimeline(ep, format, narrated);
  const draft = ep.renders[format]?.draft;
  return (
    <div className="panel">
      <p className="muted">Unnarrated preview with subtitles timed at a typical narration pace. Nothing here costs ElevenLabs credits.</p>
      {err ? <div className="error">{err}</div> : null}
      {t ? (
        <>
          <div className="muted small">{(t.durationInFrames / t.fps).toFixed(1)} s · {t.segments.filter((s) => !s.media && s.visual.type !== "slide").length} missing shot(s)</div>
          <Preview t={t} />
        </>
      ) : null}
      <div className="row">
        <Button variant="outline" disabled={busy} onClick={() => run(`/api/posts/${ep.id}/render/${format}`, { quality: "draft" })}>Render draft MP4</Button>
        {draft ? <a href={mediaUrl(draft)} target="_blank">Open draft MP4</a> : null}
      </div>
    </div>
  );
}

function NarrationStep({ ep, format, run, busy }: { ep: Post; format: Format; run: RunFn; busy: boolean }) {
  const [est, setEst] = useState<{ characters: number; bySpeaker?: { developer: number; coHost: number }; subscription?: { used: number; limit: number; resetsAt: string } } | null>(null);
  useEffect(() => {
    api<typeof est>(`/api/posts/${ep.id}/tts-estimate/${format}`).then(setEst, () => setEst(null));
  }, [ep, format]);
  const takes = ep.narration[format];
  const lineTake = (id: string) => takes?.find((t) => (t.turnId ?? t.segmentId) === id);
  const complete = !!takes && (ep.scripts[format]?.segments.flatMap(spokenTurns).every((t) => lineTake(t.id)) ?? false);
  return (
    <div className="panel">
      <p>
        Narration uses ElevenLabs and costs credits. Unchanged lines reuse cached audio for free.
      </p>
      {est ? (
        <p>
          <strong>{est.characters.toLocaleString()}</strong> billable characters for this format{ep.presentation?.[format] === "coHost" && est.bySpeaker ? ` (developer ${est.bySpeaker.developer.toLocaleString()}, co-host ${est.bySpeaker.coHost.toLocaleString()})` : ""}.
          {est.subscription ? <span className="muted"> Account: {est.subscription.used.toLocaleString()} / {est.subscription.limit.toLocaleString()} used, resets {new Date(est.subscription.resetsAt).toLocaleDateString()}.</span> : null}
        </p>
      ) : null}
      <div className="row">
        <Button
          disabled={busy || !ep.scripts[format]}
          onClick={() => {
            if (est && est.characters > 0 && !confirm(`Generate narration for ${est.characters} characters with ElevenLabs?`)) return;
            run(`/api/posts/${ep.id}/narrate/${format}`, { confirm: true });
          }}
        >
          {complete ? "Regenerate changed lines" : "Generate narration"}
        </Button>
      </div>
      {takes?.length ? (
        <div className="takes">
          <div className="label">Lines</div>
          {(ep.scripts[format]?.segments ?? [])
            .flatMap((seg, i) => spokenTurns(seg).map((turn) => ({ turn, i, take: lineTake(turn.id), coHosted: !!seg.turns })))
            .map(({ turn, i, take, coHosted }) => (
              <div key={turn.id} className="take">
                <span className="muted small">#{i + 1}{coHosted ? (turn.speaker === "coHost" ? " Co-host" : " Developer") : ""}</span>
                <span className="grow">{turn.text}</span>
                {take ? (
                  <>
                    <audio controls preload="none" src={`${mediaUrl(take.file)}?v=${take.generatedAt ?? 0}`} />
                    <span className="muted small">{(take.durationMs / 1000).toFixed(1)} s</span>
                  </>
                ) : (
                  <span className="muted small">no take yet</span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Ask ElevenLabs for a new take of this line, even if it is unchanged"
                  onClick={() => {
                    if (!confirm(`Regenerate line #${i + 1} with ElevenLabs (${turn.text.trim().length} characters)?`)) return;
                    run(`/api/posts/${ep.id}/narrate/${format}`, { confirm: true, force: [turn.id] });
                  }}
                >
                  Regenerate voice
                </Button>
              </div>
            ))}
        </div>
      ) : null}
      {complete ? <PreviewNarrated ep={ep} format={format} /> : <p className="muted">After narration, the preview uses the real voice and exact subtitle timing.</p>}
    </div>
  );
}

function PreviewNarrated({ ep, format }: { ep: Post; format: Format }) {
  const { t, err } = useTimeline(ep, format, true);
  if (err) return <div className="error">{err}</div>;
  return t ? <Preview t={t} /> : null;
}

function FinalStep({ ep, format, run, busy, reload }: { ep: Post; format: Format; run: RunFn; busy: boolean; reload: () => Promise<Post> }) {
  const r = ep.renders[format];
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [connectionId, setConnectionId] = useState(r?.connectionId ?? "");
  const [yt, setYt] = useState<{ connected: boolean; channelTitle?: string } | null>(null);
  const [publishAt, setPublishAt] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    Promise.all([api<PublicConnection[]>("/api/youtube/connections"), api<{ youtube: { connected: boolean; channelTitle?: string }; }>("/api/project-config")]).then(([all, c]) => { setConnections(all); setYt(c.youtube); });
    api<{ settings: { publishing: { connectionId?: string } } }>(apiUrl("/api/state").replace(/state$/, "settings")).then((p) => { if (!r?.connectionId) setConnectionId(p.settings.publishing.connectionId ?? ""); });
  }, []);
  useEffect(() => {
    api<{ publishAt: string | null }>(`/api/posts/${ep.id}/publish-moment`).then((m) => setPublishAt(m.publishAt), () => setPublishAt(null));
  }, [ep.publishDate, ep.publishTime, ep.id]);
  const finalUrl = r?.final ? `/output/${r.final.split(/[\\/]output[\\/]/)[1]?.replace(/\\/g, "/")}` : undefined;
  const [upload, setUpload] = useState<YouTubeUpload | null>(null);
  useEffect(() => { api<YouTubeUpload | null>(`/api/posts/${ep.id}/upload/${format}`).then(setUpload, () => setUpload(null)); }, [ep, format, busy]);
  const uploaded = !!upload?.videoId;
  const act = async (fn: () => Promise<unknown>) => {
    setErr("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => { const selected = connections.find((c) => c.id === connectionId); if (selected) setYt({ connected: selected.connected, channelTitle: selected.channelTitle }); }, [connections, connectionId]);
  const when = publishAt ? `scheduled for ${new Date(publishAt).toLocaleString()}` : "published right away";

  return (
    <div className="panel">
      <label>YouTube connection<select disabled={busy || !!r?.approvedAt || uploaded} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}><option value="">Choose connection</option>{connections.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.channelTitle ?? "Disconnected"}</option>)}</select></label>
      <p className="muted">Full-resolution H.264/AAC MP4 at -14 LUFS, with an .srt file. Watch it, check the text, then give the final OK.</p>
      <div className="row">
        <Button variant={r?.final ? "outline" : "default"} disabled={busy} onClick={() => run(`/api/posts/${ep.id}/render/${format}`, { quality: "final" })}>
          {r?.final ? "Render final again" : `Render final ${FORMAT_LABEL[format]}`}
        </Button>
        {r?.final ? <Button variant="outline" onClick={() => api("/api/open", "POST", { file: r.final })}>Show in folder</Button> : null}
      </div>
      {finalUrl ? <video className={`final ${format}`} src={finalUrl} controls /> : null}

      {r?.package ? (
        <div className="publish-box">
          <div className="label">Published as</div>
          <div className="title">{r.package.title}</div>
          <pre className="meta-text">{r.package.description}</pre>
          <div className="muted small">Tags: {r.package.tags.join(", ")}</div>
          <div className="muted small">Change the title, description or tags in Script &amp; shots → Platform metadata, and the attribution in Settings; then render the final again.</div>

          <div className="approval">
            {uploaded ? (
              <div>
                <strong>{upload!.status === "scheduled" ? "Scheduled on YouTube" : "On YouTube"}</strong>{" "}
                <a href={upload!.url} target="_blank" rel="noreferrer">{upload!.url}</a>
                <div className="muted small">
                  {upload!.status === "scheduled" && upload!.publishAt ? `Goes public ${new Date(upload!.publishAt).toLocaleString()}.` : `Uploaded ${upload!.privacy ?? "public"}.`}
                  {upload!.captions ? " Captions added." : ""}
                </div>
              </div>
            ) : r.approvedAt ? (
              <div className="row">
                <strong>Approved {new Date(r.approvedAt).toLocaleString()}</strong>
                {upload?.status === "uploading" && busy ? <span className="row muted small"><Spinner /> Uploading…</span> : null}
                {upload?.status === "failed" ? <span className="error small">Upload failed: {upload.error}</span> : null}
                {yt?.connected && upload?.status !== "uploading" ? (
                  <Button disabled={busy} onClick={() => run(`/api/posts/${ep.id}/upload/${format}`)}>{upload?.status === "failed" ? "Retry upload" : "Upload to YouTube"}</Button>
                ) : null}
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => api(`/api/posts/${ep.id}/approve/${format}`, "DELETE"))}>Withdraw approval</Button>
              </div>
            ) : (
              <div className="row">
                {yt?.connected ? (
                  <Button disabled={busy} onClick={() => act(() => run(`/api/posts/${ep.id}/approve/${format}`, { upload: true, connectionId }))}>
                    Approve &amp; upload to YouTube
                  </Button>
                ) : (
                  <Button disabled={busy} onClick={() => act(() => api(`/api/posts/${ep.id}/approve/${format}`, "POST", { connectionId }))}>Approve</Button>
                )}
                <span className="muted small">
                  {yt?.connected
                    ? `Uploads to ${yt.channelTitle ?? "your channel"}, ${when}. Set the publish date and time at the top.`
                    : "Connect YouTube in Settings to upload automatically on approval."}
                </span>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {err ? <div className="error">{err}</div> : null}
    </div>
  );
}
