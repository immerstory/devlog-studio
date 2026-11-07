import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { GridViewIcon, ListViewIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { api, apiUrl, fmtDate, mediaUrl } from "./api";
import { usePersistent } from "./persistent";
import { SegTabs } from "@/components/seg-tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Material, MaterialDeletion } from "../shared/types";
import { MediaPicker, type MediaItem } from "./MediaPicker";
import { isMedia, pastedMedia, pasteTarget, UPLOAD_FORM_ATTRIBUTE } from "./paste";

/** Uploads files with shared date, annotation and tags; optional attachment to a suggestion or episode. */
export async function uploadMaterials(files: File[], fields: { date: string; title?: string; annotation: string; tags: string; group?: string }, attach?: { suggestionId?: string; postId?: string }): Promise<Material[]> {
  const form = new FormData();
  // Fields first, so the server knows them before the file streams arrive.
  form.append("date", fields.date);
  if (fields.title) form.append("title", fields.title);
  form.append("annotation", fields.annotation);
  form.append("tags", fields.tags);
  if (fields.group?.trim()) form.append("group", fields.group.trim());
  for (const f of files) form.append("file", f, f.name);
  const qs = new URLSearchParams(Object.entries(attach ?? {}).filter(([, v]) => !!v) as Array<[string, string]>).toString();
  const res = await fetch(apiUrl(`/api/materials${qs ? `?${qs}` : ""}`), { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as Material[];
}

/** Id of the datalist that offers existing group names to group inputs. */
export const GROUPS_LIST = "material-groups";

/** Existing group names, offered by every input with list={GROUPS_LIST}. */
export function GroupOptions({ materials }: { materials: Material[] }) {
  const names = [...new Set(materials.map((m) => m.group).filter((g): g is string => !!g))].sort();
  return (
    <datalist id={GROUPS_LIST}>
      {names.map((n) => <option key={n} value={n} />)}
    </datalist>
  );
}

/** Sets or clears (empty name) the group of the given materials. */
export const setGroup = (ids: string[], group: string) => api("/api/materials/group", "POST", { ids, group });

/** Local preview of a picked file before upload: image, or a video's first frame. */
function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const video = file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(file.name);
  return (
    <div className="mthumb" title={file.name} onClick={(e) => e.stopPropagation()}>
      {url ? video ? <video src={`${url}#t=0.5`} muted playsInline preload="metadata" /> : <img src={url} /> : null}
      {video ? <span className="badge">▶</span> : null}
      <div className="cap">{file.name}</div>
      <Button
        variant="secondary"
        size="icon-xs"
        className="x"
        title="Remove from upload"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ✕
      </Button>
    </div>
  );
}

export function UploadForm({ attach, defaultDate, onDone, compact }: { attach?: { suggestionId?: string; postId?: string }; defaultDate?: string; onDone: (m: Material[]) => void; compact?: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  const [date, setDate] = useState(defaultDate ?? fmtDate(new Date()));
  const [title, setTitle] = useState("");
  const [annotation, setAnnotation] = useState("");
  const [tags, setTags] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLDivElement>(null);
  // The form follows its context: switching the selected day moves the upload date with it.
  useEffect(() => {
    if (defaultDate) setDate(defaultDate);
  }, [defaultDate]);

  const add = (list: Iterable<File> | null) => {
    const picked = [...(list ?? [])].filter(isMedia);
    setFiles((f) => [...f, ...picked]);
    // A file's own date is a better default than today for historical material.
    if (picked[0] && !defaultDate && files.length === 0) setDate(fmtDate(new Date(picked[0].lastModified)));
    // Reset the field so choosing the same file again (after removing it) registers.
    if (input.current) input.current.value = "";
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const clipboard = e.clipboardData;
      const pasted = pastedMedia([...(clipboard?.files ?? [])], new Date());
      if (!pasted.length || form.current !== pasteTarget()) return;
      // Office apps put text and a picture of it on the clipboard; in a text field, the text is what's meant.
      const inTextField = e.target instanceof HTMLElement && e.target.matches("input, textarea, [contenteditable]");
      if (inTextField && clipboard?.getData("text/plain")) return;
      e.preventDefault();
      add(pasted);
      form.current?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });
  const clearAll = () => {
    setFiles([]);
    setTitle("");
    if (input.current) input.current.value = "";
  };
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const m = await uploadMaterials(files, { date, title: files.length === 1 ? title : undefined, annotation, tags, group }, attach);
      setFiles([]);
      setTitle("");
      setAnnotation("");
      setTags("");
      setGroup("");
      onDone(m);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={form} {...{ [UPLOAD_FORM_ATTRIBUTE]: "" }} className={`upload ${compact ? "compact" : ""}`}>
      <div
        className={`drop ${over ? "over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        {files.length ? (
          <>
            <div className="mgrid small upload-previews">
              {files.map((f, i) => (
                <FilePreview key={`${f.name}-${f.size}-${f.lastModified}-${i}`} file={f} onRemove={() => setFiles((list) => list.filter((_, k) => k !== i))} />
              ))}
            </div>
            <div className="small">Drop, paste or click to add more</div>
          </>
        ) : (
          "Drop or paste screenshots or videos here, or click to choose"
        )}
        <input ref={input} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => add(e.target.files)} />
      </div>
      {files.length ? (
        <>
          <div className="row">
            <label>Date shown<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            {files.length === 1 ? <label className="grow">Title<input value={title} placeholder={files[0].name} onChange={(e) => setTitle(e.target.value)} /></label> : null}
            <label className="grow">Tags<input value={tags} placeholder="prototype, onboarding, abandoned" onChange={(e) => setTags(e.target.value)} /></label>
            <label className="grow">Group<input value={group} list={GROUPS_LIST} placeholder={files.length > 1 ? "Keep these together, e.g. Landing page drafts" : "optional"} onChange={(e) => setGroup(e.target.value)} /></label>
          </div>
          <label>
            Annotation: the story behind it
            <textarea rows={3} value={annotation} placeholder="What it shows, what you were trying, why it changed…" onChange={(e) => setAnnotation(e.target.value)} />
          </label>
          <div className="row">
            <Button disabled={busy} onClick={submit}>{busy ? "Uploading…" : "Upload"}</Button>
            <Button variant="ghost" size="sm" onClick={clearAll}>Clear selection</Button>
            <span className="muted small">{files.length} file(s)</span>
          </div>
        </>
      ) : null}
      {err ? <div className="error small">{err}</div> : null}
    </div>
  );
}

/** A material thumbnail. Passing `selected` (true or false) makes it selectable and shows a check in the top-right corner. */
export function MaterialThumb({ m, onRemove, onClick, selected }: { m: Material; onRemove?: () => void; onClick?: () => void; selected?: boolean }) {
  const selectable = selected !== undefined;
  return (
    <div
      className={`mthumb ${selected ? "selected" : ""} ${selectable ? "selectable" : ""}`}
      title={`${m.date} · ${m.title}\n${m.annotation}`}
      onClick={onClick}
      role={selectable ? "checkbox" : undefined}
      aria-checked={selectable ? selected : undefined}
    >
      <img src={mediaUrl(m.thumbKey)} loading="lazy" />
      {m.kind === "video" ? <span className="badge">▶ {m.durationSeconds ? `${Math.round(m.durationSeconds)} s` : ""}</span> : null}
      {m.group ? <span className="grp" title={`Group: ${m.group}`}>{m.group}</span> : null}
      <div className="cap">{m.title}</div>
      {selectable ? (
        <span className="check" aria-hidden="true">
          {selected ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-3.5" /> : null}
        </span>
      ) : null}
      {onRemove ? (
        <Button
          variant="secondary"
          size="icon-xs"
          className="x"
          title="Detach"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </Button>
      ) : null}
    </div>
  );
}

/** Attached materials with editing and removal, the gallery picker for existing ones, and an upload form. `onEdited` runs after a material is saved or deleted. */
export function MaterialAttach({ attached, all, onChange, attach, defaultDate, onUploaded, onEdited }: { attached: string[]; all: Material[]; onChange: (ids: string[]) => void; attach: { suggestionId?: string; postId?: string }; defaultDate?: string; onUploaded: (m: Material[]) => void; onEdited: () => unknown }) {
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const byId = useMemo(() => new Map(all.map((m) => [m.id, m])), [all]);
  const items = useMemo<MediaItem[]>(
    () => all.map((m) => ({ id: m.id, source: "library", thumb: mediaUrl(m.thumbKey), preview: largeImage(m), title: m.title, date: m.date, group: m.group, annotation: m.annotation, isVideo: m.kind === "video" })),
    [all],
  );
  return (
    <div className="mattach">
      <div className="mgrid small">
        {attached.map((id) => byId.get(id)).filter((m): m is Material => !!m).map((m) => (
          <MaterialThumb key={m.id} m={m} onClick={() => setEditing(m.id)} onRemove={() => onChange(attached.filter((x) => x !== m.id))} />
        ))}
      </div>
      <div className="row">
        <Button variant="outline" onClick={() => setPicking(true)}>Attach existing…</Button>
      </div>
      {/* Pre-selected with the attached materials, so the picker also removes and reorders them. */}
      <MediaPicker open={picking} onOpenChange={setPicking} title="Attach materials" items={items} max={Infinity} selected={attached.filter((id) => byId.has(id))} onInsert={onChange} />
      {editing ? <GroupOptions materials={all} /> : null}
      <MaterialDialog
        m={editing ? byId.get(editing) : undefined}
        onClose={() => setEditing(null)}
        onSaved={onEdited}
        onDeleted={(warning) => {
          setNotice(warning ?? "");
          onChange(attached.filter((x) => x !== editing));
          onEdited();
        }}
      />
      {notice ? <p role="status" className="small">{notice}</p> : null}
      <UploadForm compact attach={attach} defaultDate={defaultDate} onDone={onUploaded} />
    </div>
  );
}

/** Date, title, annotation, tags and group of a material, with save and delete. */
function MaterialFields({ m, onSaved, onDeleted }: { m: Material; onSaved: () => void; onDeleted: (warning?: string) => void }) {
  const [draft, setDraft] = useState({ date: m.date, title: m.title, annotation: m.annotation, tags: m.tags.join(", "), group: m.group ?? "" });
  const [err, setErr] = useState("");
  const dirty = draft.date !== m.date || draft.title !== m.title || draft.annotation !== m.annotation || draft.tags !== m.tags.join(", ") || draft.group.trim() !== (m.group ?? "");
  const save = async () => {
    try {
      await api(`/api/materials/${m.id}`, "PATCH", { ...draft, tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean) });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mfields">
      <div className="row">
        <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        <input className="grow" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </div>
      <textarea rows={3} placeholder="Annotation: the story behind it" value={draft.annotation} onChange={(e) => setDraft({ ...draft, annotation: e.target.value })} />
      <div className="row">
        <input className="grow" placeholder="Tags" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
        <input className="grow" placeholder="Group" list={GROUPS_LIST} value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} />
      </div>
      <div className="row">
        <Button disabled={!dirty} onClick={save}>Save</Button>
        <Button
          variant="ghost"
          size="xs"
          className="text-destructive"
          onClick={async () => {
            if (!confirm(`Delete "${m.title}" permanently?`)) return;
            try {
              const result = await api<MaterialDeletion>(`/api/materials/${m.id}`, "DELETE");
              onDeleted(result.warning);
            } catch (error) { setErr((error as Error).message); }
          }}
        >
          delete
        </Button>
        <span className="muted small">{m.fileName}</span>
      </div>
      {err ? <div className="error small">{err}</div> : null}
    </div>
  );
}

const materialKey = (m: Material) => `${m.id}-${m.date}-${m.title}-${m.annotation.length}-${m.group ?? ""}`;

function MaterialCard({ m, onSaved, onDeleted }: { m: Material; onSaved: () => void; onDeleted: (warning?: string) => void }) {
  return (
    <div className="mcard">
      <a href={mediaUrl(m.key)} target="_blank" className="mmedia">
        <img src={mediaUrl(m.thumbKey)} loading="lazy" />
        {m.kind === "video" ? <span className="badge">▶ {m.durationSeconds ? `${Math.round(m.durationSeconds)} s` : ""}</span> : null}
      </a>
      <MaterialFields m={m} onSaved={onSaved} onDeleted={onDeleted} />
    </div>
  );
}

/** URL of a material's large still. The stored preview of a GIF is one JPEG frame, so a GIF uses its original file to keep moving. */
export const largeImage = (m: Material) => mediaUrl(/\.gif$/i.test(m.key) ? m.key : m.previewKey);

/** Editing a material: a large preview beside the fields. Saving or deleting closes it. */
function MaterialDialog({ m, onClose, onSaved, onDeleted }: { m: Material | undefined; onClose: () => void; onSaved: () => unknown; onDeleted: (warning?: string) => void }) {
  return (
    <Dialog open={!!m} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="material-dialog sm:max-w-4xl">
        {m ? (
          <>
            <DialogHeader>
              <DialogTitle>{m.title}</DialogTitle>
              <DialogDescription>
                {m.date} · {m.kind}
                {m.width && m.height ? ` · ${m.width} × ${m.height}` : ""}
                {m.durationSeconds ? ` · ${Math.round(m.durationSeconds)} s` : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="md-body">
              <a href={mediaUrl(m.key)} target="_blank" className="md-media" title="Open the original">
                {m.kind === "video" ? <video src={mediaUrl(m.key)} poster={mediaUrl(m.previewKey)} controls muted playsInline preload="metadata" /> : <img src={largeImage(m)} />}
              </a>
              <MaterialFields
                key={materialKey(m)}
                m={m}
                onSaved={() => {
                  onSaved();
                  onClose();
                }}
                onDeleted={(warning) => {
                  onDeleted(warning);
                  onClose();
                }}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function MaterialsPage({ materials, reload }: { materials: Material[]; reload: () => void }) {
  const [query, setQuery] = useState("");
  const [layout, setLayout] = usePersistent<"list" | "grid">("materialsLayout", "list");
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const onDeleted = (warning?: string) => { setNotice(warning ?? "Material deleted."); reload(); };
  const shown = materials.filter((m) => !query || `${m.title} ${m.annotation} ${m.tags.join(" ")} ${m.group ?? ""} ${m.date}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="panel pad materials-page">
      <GroupOptions materials={materials} />
      <h2>Materials</h2>
      {notice && <p role="status">{notice}</p>}
      <p className="muted">Screenshots and videos with the story behind them: experiments, abandoned versions, moments the repository no longer shows. Progress checks, backfills, questions and scripts use their dates and annotations, and scripts can show them. Materials with the same group name belong together: when several of them are used, the agent tells their story as one beat and shows them as one polaroid stack. Only the materials you choose are used; to use a whole group, choose it with <em>add group…</em> in the picker.</p>
      <UploadForm onDone={reload} />
      <div className="row">
        <input className="grow" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <SegTabs
          value={layout}
          onChange={setLayout}
          items={[
            { value: "list", label: <span className="flex items-center" title="List: edit inline"><HugeiconsIcon icon={ListViewIcon} className="size-4" /><span className="sr-only">List</span></span> },
            { value: "grid", label: <span className="flex items-center" title="Grid: click to edit"><HugeiconsIcon icon={GridViewIcon} className="size-4" /><span className="sr-only">Grid</span></span> },
          ]}
        />
      </div>
      {layout === "list" ? (
        <div className="mlist">
          {shown.map((m) => (
            <MaterialCard key={materialKey(m)} m={m} onSaved={reload} onDeleted={onDeleted} />
          ))}
        </div>
      ) : (
        <div className="mgrid materials-grid">
          {shown.map((m) => (
            <MaterialThumb key={m.id} m={m} onClick={() => setEditing(m.id)} />
          ))}
        </div>
      )}
      {!shown.length ? <p className="muted">{materials.length ? "Nothing matches." : "No materials yet."}</p> : null}
      <MaterialDialog m={materials.find((m) => m.id === editing)} onClose={() => setEditing(null)} onSaved={reload} onDeleted={onDeleted} />
    </div>
  );
}
