import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, apiUrl } from "./api";

interface SceneObject {
  name: string;
  path: string;
  scene: string;
  active: boolean;
  childCount: number;
}

/**
 * Picks a GameObject in the open Unity editor through MCP (read-only): search by name,
 * browse the hierarchy of all loaded scenes, or take the editor's current selection.
 */
export function ObjectPicker({ onPick, targetId }: { targetId?: string; onPick: (path: string) => void }) {
  const endpoint = targetId ? apiUrl("/api/state").replace(/state$/, `capture/${targetId}`) : "/api/unity";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState("");
  const [items, setItems] = useState<SceneObject[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErr("");
    setBusy(true);
    const url = query.trim() ? `${endpoint}/objects?q=${encodeURIComponent(query.trim())}&limit=60` : `${endpoint}/children?path=${encodeURIComponent(browse)}`;
    // Debounced so typing does not queue editor calls.
    const timer = setTimeout(
      () =>
        api<SceneObject[]>(url)
          .then(setItems, (e) => {
            setItems(null);
            setErr(e.message);
          })
          .finally(() => setBusy(false)),
      query.trim() ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [open, query, browse, targetId]);

  const pick = (path: string) => {
    onPick(path);
    setOpen(false);
  };
  const useSelection = async () => {
    setErr("");
    try {
      const sel = await api<SceneObject[]>(`${endpoint}/selection`);
      if (!sel.length) return setErr("Nothing is selected in Unity. Select an object in the Hierarchy or Scene view first.");
      pick(sel[0].path);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const crumbs = browse ? browse.split("/") : [];
  return (
    <div className="picker-wrap">
      <div className="row">
        <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>{open ? "Close picker" : "Pick object…"}</Button>
        <Button variant="outline" size="sm" onClick={useSelection} title="Use the object selected in Unity's Hierarchy or Scene view">Use Unity selection</Button>
      </div>
      {open ? (
        <div className="object-picker">
          <input placeholder="Search objects by name" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          {!query.trim() ? (
            <div className="crumbs">
              <button className="crumb" onClick={() => setBrowse("")}>Scenes</button>
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  <span className="muted">/</span>
                  <button className="crumb" onClick={() => setBrowse(crumbs.slice(0, i + 1).join("/"))}>{c}</button>
                </React.Fragment>
              ))}
            </div>
          ) : null}
          {err ? <div className="error small">{err}</div> : null}
          {busy && !items ? <div className="muted small">Loading…</div> : null}
          <div className="objects">
            {(items ?? []).map((o, i) => (
              <div key={`${i}:${o.path}`} className={`object ${o.active ? "" : "inactive"}`}>
                <div className="grow" onClick={() => (o.childCount && !query.trim() ? setBrowse(o.path) : undefined)} style={{ cursor: o.childCount && !query.trim() ? "pointer" : "default" }}>
                  <div className="name">
                    {o.name}
                    {o.childCount && !query.trim() ? <span className="muted"> › {o.childCount}</span> : null}
                  </div>
                  {query.trim() ? <div className="muted small path">{o.path}</div> : <div className="muted small">{o.scene}{o.active ? "" : " · inactive"}</div>}
                </div>
                <Button size="xs" onClick={() => pick(o.path)}>Use</Button>
              </div>
            ))}
            {items && !items.length ? <div className="muted small">No objects.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
