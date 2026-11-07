import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { SessionImage } from "../shared/activity";
import { DayRecords } from "./ActivityPage";
import { api, mediaUrl, projectHref, useJob } from "./api";
import { GROUPS_LIST } from "./Materials";

/** Which images a material picker offers: those of these activity records first, then those of this period. */
export interface SessionContext { records?: string[]; from?: string; to?: string }

const PERIOD_DAYS = 7;
const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** The days around some work dates, for offering images from around that work. */
export function sessionPeriod(dates: string[]): { from?: string; to?: string } {
  const known = dates.filter(Boolean).sort();
  return known.length ? { from: shiftDate(known[0], -PERIOD_DAYS), to: shiftDate(known[known.length - 1], PERIOD_DAYS) } : {};
}

export const toolName = (tool: SessionImage["tool"]) => (tool === "claude" ? "Claude Code" : "Codex");
export const largeSessionImage = (image: SessionImage) => mediaUrl(/\.gif$/i.test(image.key) ? image.key : image.previewKey);

/** A large view of an image with the fields it gets as a material. */
function SessionImageDialog({ image, onClose, onChanged, onAdded }: { image: SessionImage; onClose: () => void; onChanged: () => void; onAdded: () => void }) {
  const [draft, setDraft] = useState({ date: image.date, title: image.title, annotation: image.message, tags: "", group: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      await api(`/api/session-images/${image.id}/material`, "POST", { ...draft, tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean) });
      onAdded();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const setStatus = async (status: "inbox" | "dismissed") => {
    try {
      await api(`/api/session-images/${image.id}`, "PATCH", { status });
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
          <DialogTitle>{image.title}</DialogTitle>
          <DialogDescription>
            {[image.date, toolName(image.tool), image.sessionTitle, image.width && image.height ? `${image.width} × ${image.height}` : ""].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <div className="md-body">
          <a href={mediaUrl(image.key)} target="_blank" className="md-media" title="Open the original">
            <img src={largeSessionImage(image)} />
          </a>
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
              {image.status === "dismissed"
                ? <Button variant="outline" onClick={() => setStatus("inbox")}>Restore</Button>
                : <Button variant="outline" onClick={() => setStatus("dismissed")}>Dismiss</Button>}
            </div>
            {err ? <div className="error small">{err}</div> : null}
            <details className="small">
              <summary>Sessions on this day</summary>
              <DayRecords day={image.date} />
            </details>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Images from session logs, by day. Nothing here reaches an agent until the developer adds it to the materials. */
export function SessionImagesInbox({ images, reload, onAdded }: { images: SessionImage[] | null; reload: () => void; onAdded: () => void }) {
  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<"all" | SessionImage["tool"]>("all");
  const [dismissed, setDismissed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const jobs = useJob(() => reload());
  const wanted = dismissed ? "dismissed" : "inbox";
  const q = query.trim().toLowerCase();
  const shown = (images ?? []).filter((i) => i.status === wanted && (tool === "all" || i.tool === tool) && (!q || `${i.title} ${i.message} ${i.sessionTitle ?? ""} ${i.date}`.toLowerCase().includes(q)));
  const days = useMemo(() => {
    const byDay = new Map<string, SessionImage[]>();
    for (const image of shown) byDay.set(image.date, [...(byDay.get(image.date) ?? []), image]);
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [images, tool, dismissed, q]);
  const open = images?.find((i) => i.id === openId);
  const setStatus = async (image: SessionImage, status: "inbox" | "dismissed") => {
    try {
      await api(`/api/session-images/${image.id}`, "PATCH", { status });
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const dismissedCount = images?.filter((i) => i.status === "dismissed").length ?? 0;
  return (
    <>
      <p className="muted">Images you sent to Claude Code and Codex. They stay here until you add them, and agents can't see them here. Check each image before you add it, because a screenshot can show secrets, other projects or your desktop.</p>
      <div className="row si-toolbar">
        <input className="grow" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select aria-label="Tool" value={tool} onChange={(e) => setTool(e.target.value as typeof tool)}>
          <option value="all">All tools</option>
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <label className="check"><input type="checkbox" checked={dismissed} onChange={(e) => setDismissed(e.target.checked)} />Dismissed ({dismissedCount})</label>
        <Button variant="outline" disabled={jobs.running} onClick={() => jobs.start("/api/session-images/scan").catch((e: Error) => setErr(e.message))}>{jobs.running ? "Checking logs…" : "Check logs for new images"}</Button>
      </div>
      {err ? <div className="error small">{err}</div> : null}
      {days.map(([date, list]) => (
        <section key={date} className="si-day">
          <div className="label">{date}</div>
          <div className="mgrid materials-grid">
            {list.map((image) => (
              <div key={image.id} className="si-card">
                <div className="mthumb" role="button" tabIndex={0} title="Open" onClick={() => setOpenId(image.id)} onKeyDown={(e) => (e.key === "Enter" ? setOpenId(image.id) : undefined)}>
                  <img src={mediaUrl(image.thumbKey)} loading="lazy" />
                </div>
                <div className="muted small">{toolName(image.tool)}</div>
                <div className="small si-message" title={image.message}>{image.message || image.sessionTitle || "No message"}</div>
                <div className="row">
                  <Button size="xs" onClick={() => setOpenId(image.id)}>+ Add</Button>
                  {image.status === "dismissed"
                    ? <Button size="xs" variant="ghost" onClick={() => setStatus(image, "inbox")}>Restore</Button>
                    : <Button size="xs" variant="ghost" onClick={() => setStatus(image, "dismissed")}>✕ Dismiss</Button>}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {images && !days.length ? (
        images.length
          ? <p className="muted">Nothing matches.</p>
          : <p className="muted">No images yet. To collect them, turn on <em>Import screenshots I sent</em> under <a href={projectHref("/settings")}>Project settings</a>, Sources and activity.</p>
      ) : null}
      {open ? <SessionImageDialog key={open.id} image={open} onClose={() => setOpenId(null)} onChanged={reload} onAdded={onAdded} /> : null}
    </>
  );
}
