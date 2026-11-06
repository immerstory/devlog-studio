import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";

/** Something a slide or shot can show: a frame of an earlier segment, or a material. */
export interface MediaItem {
  id: string;
  /** "shot": a segment of this video; "video": a material of this video; "library": any other material. */
  source: "shot" | "video" | "library";
  thumb?: string;
  /** Larger image for the details panel. */
  preview?: string;
  title: string;
  date?: string;
  group?: string;
  annotation?: string;
  isVideo?: boolean;
}

const SOURCES: Array<{ key: "all" | MediaItem["source"]; label: string }> = [
  { key: "all", label: "All" },
  { key: "shot", label: "Shots in this video" },
  { key: "video", label: "This video's materials" },
  { key: "library", label: "Library" },
];

/** A selectable thumbnail; multi-selection shows the pick order, single selection a tick. */
function Tile({ item, order, single, active, onClick, onDoubleClick }: { item: MediaItem; order: number; single: boolean; active: boolean; onClick: () => void; onDoubleClick: () => void }) {
  const selected = order > 0;
  return (
    <div
      className={`mthumb selectable ${selected ? "selected" : ""} ${active ? "active" : ""}`}
      role="checkbox"
      aria-checked={selected}
      tabIndex={0}
      title={[item.date, item.title].filter(Boolean).join(" · ")}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter" ? (e.preventDefault(), onClick()) : undefined)}
    >
      {item.thumb ? <img src={item.thumb} loading="lazy" draggable={false} /> : <div className="ph">no image</div>}
      {item.isVideo ? <span className="badge">▶</span> : null}
      {item.group ? <span className="grp">{item.group}</span> : null}
      <div className="cap">{item.title}</div>
      <span className="check" aria-hidden="true">
        {selected ? single ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-3.5" /> : <span className="order">{order}</span> : null}
      </span>
    </div>
  );
}

/**
 * Gallery dialog for choosing media, in the style of a CMS media library: filter, search, pick in order,
 * see details, insert. `max` 1 replaces the pick on each click; double-click inserts right away.
 */
export function MediaPicker(props: { open: boolean; onOpenChange: (open: boolean) => void; title: string; items: MediaItem[]; max: number; selected: string[]; onInsert: (ids: string[]) => void }) {
  const { open, onOpenChange, title, items, max, onInsert } = props;
  const single = max === 1;
  const [picked, setPicked] = useState<string[]>(props.selected);
  const [source, setSource] = useState<"all" | MediaItem["source"]>("all");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | undefined>(props.selected[0]);
  useEffect(() => {
    if (!open) return;
    setPicked(props.selected);
    setActive(props.selected[0]);
    setQuery("");
  }, [open]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => (source === "all" || i.source === source) && (!q || `${i.title} ${i.date ?? ""} ${i.group ?? ""} ${i.annotation ?? ""}`.toLowerCase().includes(q)));
  const groups = [...new Set(shown.map((i) => i.group).filter((g): g is string => !!g))].sort();
  const counts = Object.fromEntries(SOURCES.map((s) => [s.key, s.key === "all" ? items.length : items.filter((i) => i.source === s.key).length]));

  const toggle = (id: string) => {
    setActive(id);
    if (single) return setPicked([id]);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < max ? [...p, id] : p));
  };
  const addGroup = (g: string) => {
    const members = items.filter((i) => i.group === g && i.source !== "shot").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
    setPicked((p) => [...p, ...members.map((m) => m.id).filter((id) => !p.includes(id))].slice(0, max));
  };
  const insert = (ids = picked) => {
    onInsert(ids);
    onOpenChange(false);
  };
  const detail = active ? byId.get(active) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="media-picker sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {single ? "Click to choose, double-click to use it right away." : `Click in the order the images should appear${Number.isFinite(max) ? ` (up to ${max})` : ""}. Click again to remove.`}
          </DialogDescription>
        </DialogHeader>
        <div className="mp-toolbar">
          <div className="mp-sources">
            {SOURCES.filter((s) => s.key === "all" || counts[s.key]).map((s) => (
              <Button key={s.key} size="sm" variant={source === s.key ? "default" : "outline"} onClick={() => setSource(s.key)}>
                {s.label} <span className="opacity-60">{counts[s.key]}</span>
              </Button>
            ))}
          </div>
          <input className="mp-search" placeholder="Search title, date, group, annotation" value={query} onChange={(e) => setQuery(e.target.value)} />
          {!single && groups.length ? (
            <select value="" onChange={(e) => e.target.value && addGroup(e.target.value)} title="Add every material of a group, in date order">
              <option value="">add group…</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          ) : null}
        </div>
        <div className="mp-body">
          <div className="mp-scroll">
            <div className="mgrid">
              {shown.map((i) => (
                <Tile key={i.id} item={i} order={picked.indexOf(i.id) + 1} single={single} active={active === i.id} onClick={() => toggle(i.id)} onDoubleClick={() => single && insert([i.id])} />
              ))}
            </div>
            {!shown.length ? <p className="muted">Nothing matches.</p> : null}
          </div>
          <aside className="mp-detail">
            {detail ? (
              <>
                {detail.preview || detail.thumb ? <img src={detail.preview ?? detail.thumb} /> : null}
                <div className="mp-title">{detail.title}</div>
                <div className="muted small">{[detail.source === "shot" ? "Shot in this video" : detail.date, detail.isVideo ? "video" : null, detail.group ? `group “${detail.group}”` : null].filter(Boolean).join(" · ")}</div>
                {detail.annotation ? <p className="small mp-annotation">{detail.annotation}</p> : null}
              </>
            ) : (
              <p className="muted small">Click an image to see its details.</p>
            )}
          </aside>
        </div>
        <DialogFooter className="mp-footer">
          <span className="muted small grow">{single ? (picked[0] ? byId.get(picked[0])?.title : "Nothing chosen") : `${picked.length} selected`}</span>
          {!single && picked.length ? <Button variant="ghost" onClick={() => setPicked([])}>Clear</Button> : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!picked.length} onClick={() => insert()}>{single ? "Use" : "Insert"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The images a slide shows, in order: drag to reorder, ✕ to remove, the last tile opens the picker.
 * `labels` names fixed positions (Before/After); `max` limits the count.
 */
export function ImageStrip(props: {
  ids: string[];
  items: MediaItem[];
  max: number;
  labels?: string[];
  onChange: (ids: string[]) => void;
  onAdd: () => void;
  onTileClick?: () => void;
  /** With captions: an editable caption under each image, keyed by image id; placeholder shows what appears when empty. */
  captions?: { value: Record<string, string>; placeholder: (id: string, k: number) => string; onChange: (id: string, text: string) => void };
}) {
  const { ids, items, max, labels, onChange, onAdd, onTileClick, captions } = props;
  const byId = new Map(items.map((i) => [i.id, i]));
  const [from, setFrom] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const end = () => {
    setFrom(null);
    setAt(null);
  };
  const move = (a: number, insertAt: number) => {
    const to = insertAt > a ? insertAt - 1 : insertAt;
    if (to === a) return;
    const next = [...ids];
    next.splice(to, 0, ...next.splice(a, 1));
    onChange(next);
  };
  return (
    <div className="image-strip">
      {ids.map((id, k) => {
        const item = byId.get(id);
        return (
          <div
            key={`${id}-${k}`}
            className={`strip-tile ${from === k ? "dragging" : ""} ${at === k && from !== null ? "drop-left" : ""} ${at === k + 1 && k === ids.length - 1 && from !== null ? "drop-right" : ""}`}
            draggable={ids.length > 1}
            title={[ids.length > 1 ? "Drag to reorder" : "", onTileClick ? "click to change" : ""].filter(Boolean).join(", ") || undefined}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", id);
              setFrom(k);
            }}
            onDragOver={(e) => {
              if (from === null) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setAt(e.clientX < r.left + r.width / 2 ? k : k + 1);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (from !== null && at !== null) move(from, at);
              end();
            }}
            onDragEnd={end}
          >
            <div className="mthumb" onClick={onTileClick}>
              {item?.thumb ? <img src={item.thumb} draggable={false} /> : <div className="ph">{item ? "no image" : "missing"}</div>}
              {item?.isVideo ? <span className="badge">▶</span> : null}
              <div className="cap">{item?.title ?? id}</div>
              <Button
                variant="secondary"
                size="icon-xs"
                className="x"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(ids.filter((_, j) => j !== k));
                }}
              >
                ✕
              </Button>
            </div>
            {captions ? (
              <input
                className="strip-caption"
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                placeholder={captions.placeholder(id, k) || "no caption"}
                value={captions.value[id] ?? ""}
                title="Caption under the picture"
                onChange={(e) => captions.onChange(id, e.target.value)}
              />
            ) : labels?.[k] ? (
              <div className="muted small strip-label">{labels[k]}</div>
            ) : ids.length > 1 ? (
              <div className="muted small strip-label">{k + 1}</div>
            ) : null}
          </div>
        );
      })}
      {ids.length < max ? (
        <button type="button" className="strip-add" onClick={onAdd}>
          <span>+</span>
          <span className="small">{labels?.[ids.length] ?? (ids.length ? "Add images" : "Choose images")}</span>
        </button>
      ) : null}
    </div>
  );
}
