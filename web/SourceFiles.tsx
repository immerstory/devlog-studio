import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { InboxFile } from "../shared/types";
import { api, apiUrl, projectHref, useJob } from "./api";
import { GROUPS_LIST } from "./Materials";

export const inboxFileUrl = (file: InboxFile) => apiUrl(`/api/source-files/${file.id}/file?v=${file.blob}`);
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

function Preview({ file, className }: { file: InboxFile; className?: string }) {
  return file.kind === "video"
    ? <video className={className} src={inboxFileUrl(file)} muted preload="metadata" />
    : <img className={className} src={inboxFileUrl(file)} loading="lazy" />;
}

/** A large view of a file with the fields it gets as a material. Changed fields stay when the source changes. */
function InboxFileDialog({ file, busy, onClose, onChanged, onAdd }: { file: InboxFile; busy: boolean; onClose: () => void; onChanged: () => void; onAdd: (ids: string[], fields?: object) => Promise<void> }) {
  const [draft, setDraft] = useState({ date: file.fields.date, title: file.fields.title, annotation: file.fields.annotation, tags: file.fields.tags.join(", "), group: file.fields.group ?? "" });
  const [err, setErr] = useState("");
  const add = async () => {
    setErr("");
    const tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const changed = {
      ...(draft.date !== file.fields.date ? { date: draft.date } : {}),
      ...(draft.title !== file.fields.title ? { title: draft.title } : {}),
      ...(draft.annotation !== file.fields.annotation ? { annotation: draft.annotation } : {}),
      ...(tags.join("\n") !== file.fields.tags.join("\n") ? { tags } : {}),
      ...(draft.group !== (file.fields.group ?? "") ? { group: draft.group } : {}),
    };
    try {
      await onAdd([file.id], changed);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const setStatus = async (status: InboxFile["status"]) => {
    try {
      await api(`/api/source-files/${file.id}`, "PATCH", { status });
      onChanged();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="material-dialog sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{file.fields.title}</DialogTitle>
          <DialogDescription>{file.path}</DialogDescription>
        </DialogHeader>
        <div className="md-body">
          <a href={inboxFileUrl(file)} target="_blank" className="md-media" title="Open the original"><Preview file={file} /></a>
          <div className="mfields">
            <div className="row">
              <input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
              <input className="grow" aria-label="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </div>
            <textarea rows={6} placeholder="Annotation: the story behind it" value={draft.annotation} onChange={(e) => setDraft({ ...draft, annotation: e.target.value })} />
            <div className="row">
              <input className="grow" placeholder="Tags" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
              <input className="grow" placeholder="Group" list={GROUPS_LIST} value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} />
            </div>
            <div className="row">
              <Button disabled={busy} onClick={add}>{busy ? "Adding…" : "Add to materials"}</Button>
              {file.status === "dismissed"
                ? <Button variant="outline" onClick={() => setStatus("inbox")}>Restore</Button>
                : <Button variant="outline" onClick={() => setStatus("dismissed")}>Dismiss</Button>}
            </div>
            {err ? <div className="error small">{err}</div> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Files that inbox rules matched, by folder. Nothing here reaches an agent until the developer adds it to the materials. */
export function SourceFilesInbox({ files, reload, onAdded }: { files: InboxFile[] | null; reload: () => void; onAdded: () => void }) {
  const [query, setQuery] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const importing = useJob(() => reload());
  const adding = useJob(() => onAdded());
  const wanted = dismissed ? "dismissed" : "inbox";
  const q = query.trim().toLowerCase();
  const folders = useMemo(() => {
    const byFolder = new Map<string, InboxFile[]>();
    for (const f of files ?? []) {
      if (f.status !== wanted || (q && !`${f.path} ${f.fields.title} ${f.fields.annotation} ${f.fields.tags.join(" ")} ${f.fields.date}`.toLowerCase().includes(q))) continue;
      byFolder.set(folderOf(f.path), [...(byFolder.get(folderOf(f.path)) ?? []), f]);
    }
    return [...byFolder.entries()];
  }, [files, wanted, q]);
  const open = files?.find((f) => f.id === openId);
  const run = (p: Promise<unknown>) => p.catch((e: Error) => setErr(e.message));
  const add = async (ids: string[], fields?: object) => { setErr(""); await adding.start("/api/source-files/add", { ids, fields }); };
  const setStatus = async (list: InboxFile[], status: InboxFile["status"]) => {
    setErr("");
    for (const f of list) await api(`/api/source-files/${f.id}`, "PATCH", { status });
    reload();
  };
  const dismissedCount = files?.filter((f) => f.status === "dismissed").length ?? 0;
  return (
    <>
      <p className="muted">Images and videos that material rules with <em>Import to: Inbox</em> found in your sources. They stay here until you add them, and agents can't see them here. An added file becomes a material that follows its source. Open a file to check or change its fields before you add it.</p>
      <div className="row si-toolbar">
        <input className="grow" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check"><input type="checkbox" checked={dismissed} onChange={(e) => setDismissed(e.target.checked)} />Dismissed ({dismissedCount})</label>
        <Button variant="outline" disabled={importing.running} onClick={() => run(importing.start("/api/source-files/import"))}>{importing.running ? "Checking sources…" : "Check sources"}</Button>
      </div>
      {err ? <div className="error small">{err}</div> : null}
      {folders.map(([folder, list]) => (
        <section key={folder} className="si-day">
          <div className="row">
            <div className="label grow">{folder} · {list.length}</div>
            {dismissed ? null : <Button size="xs" disabled={adding.running} onClick={() => run(add(list.map((f) => f.id)))}>+ Add all</Button>}
            <Button size="xs" variant="ghost" onClick={() => run(setStatus(list, dismissed ? "inbox" : "dismissed"))}>{dismissed ? "Restore all" : "✕ Dismiss all"}</Button>
          </div>
          <div className="mgrid materials-grid sf-grid">
            {list.map((f) => (
              <div key={f.id} className="sf-card">
                <div className="mthumb" role="button" tabIndex={0} title="Open to check or change its fields before you add it" onClick={() => setOpenId(f.id)} onKeyDown={(e) => (e.key === "Enter" ? setOpenId(f.id) : undefined)}>
                  <Preview file={f} />
                </div>
                <div className="small sf-title" title={f.path}>{f.fields.title}</div>
                <div className="sf-actions">
                  <span className="muted small grow">{f.fields.date}</span>
                  <Button size="xs" disabled={adding.running} title="Adds it with the fields from its source" onClick={() => run(add([f.id]))}>+ Add</Button>
                  <Button size="xs" variant="ghost" onClick={() => run(setStatus([f], dismissed ? "inbox" : "dismissed"))}>{dismissed ? "Restore" : "✕ Dismiss"}</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {files && !folders.length ? (
        files.length
          ? <p className="muted">Nothing matches.</p>
          : <p className="muted">No files yet. Under <a href={projectHref("/settings")}>Project settings</a>, Sources, add a material rule with <em>Import to: Inbox</em>.</p>
      ) : null}
      {open ? <InboxFileDialog key={open.id} file={open} busy={adding.running} onClose={() => setOpenId(null)} onChanged={reload} onAdd={add} /> : null}
    </>
  );
}
