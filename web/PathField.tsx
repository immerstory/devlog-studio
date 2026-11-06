import React, { useEffect, useId, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, File01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "./api";

interface FolderListing {
  path: string;
  parent: string | null;
  repo: string | null;
  unity: boolean;
  roots: string[];
  folders: Array<{ name: string; path: string; git: boolean; unity: boolean }>;
  executables: Array<{ name: string; path: string }>;
}

/** What a path field holds: a Git working copy, a Unity project folder, or a program to run. */
export type PathKind = "git" | "unity" | "executable";

const listFolders = (folder: string, kind: PathKind, hidden: boolean) => {
  const query = new URLSearchParams({ path: folder });
  if (kind === "executable") query.set("executables", "1");
  if (hidden) query.set("hidden", "1");
  return api<FolderListing>(`/api/folders?${query}`);
};

/** Splits a file path into its folder and file name; a bare command name has no folder. */
const splitFile = (file: string) => {
  const m = /^(.*[\\/])([^\\/]+)$/.exec(file.trim());
  return m ? { folder: m[1], name: m[2] } : null;
};

const PICKER: Record<PathKind, { title: string; description: string; use: string; placeholder: string }> = {
  git: { title: "Choose a Git working copy", description: "Open folders until you reach the project. Folders marked Git are working copies.", use: "Use this working copy", placeholder: "C:\\Projects\\MyProject" },
  unity: { title: "Choose a Unity project", description: "Open folders until you reach the project. Folders marked Unity hold Assets and ProjectSettings.", use: "Use this project", placeholder: "C:\\Projects\\MyGame" },
  executable: { title: "Choose a program", description: "Open folders until you reach the program, then select it. Only files that can be run are listed.", use: "Use this program", placeholder: "C:\\Tools\\print-headers.exe" },
};

/** Browses the computer running Devlog Studio and returns the path chosen. */
function PathPicker({ kind, open, onOpenChange, start, onChoose }: { kind: PathKind; open: boolean; onOpenChange: (open: boolean) => void; start: string; onChoose: (chosen: string) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Tools often live in hidden folders, so programs are looked for with those shown.
  const [hidden, setHidden] = useState(kind === "executable");
  const latest = useRef(0);
  const show = async (load: Promise<FolderListing>) => {
    const request = ++latest.current;
    try {
      const next = await load;
      if (request !== latest.current) return;
      setListing(next);
      setSelected(null);
      setError("");
    } catch (e) {
      if (request === latest.current) setError((e as Error).message);
    }
  };
  const go = (folder: string, showHidden = hidden) => void show(listFolders(folder, kind, showHidden));
  // Opens at the field's value; a typed path that does not exist opens the home folder.
  useEffect(() => {
    if (!open) return;
    const folder = kind === "executable" ? splitFile(start)?.folder ?? "" : start;
    void show(listFolders(folder, kind, hidden).catch(() => listFolders("", kind, hidden)));
  }, [open]);

  const chosen = !listing ? null : kind === "git" ? listing.repo : kind === "unity" ? (listing.unity ? listing.path : null) : selected;
  const state = !listing
    ? ""
    : kind === "git"
      ? listing.repo ? `Git working copy: ${listing.repo}` : "This folder is not in a Git working copy."
      : kind === "unity"
        ? listing.unity ? `Unity project: ${listing.path}` : "This folder is not a Unity project."
        : selected ?? "Select a program.";
  const empty = listing && !listing.folders.length && !listing.executables.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="folder-picker sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{PICKER[kind].title}</DialogTitle>
          <DialogDescription>{PICKER[kind].description}</DialogDescription>
        </DialogHeader>
        <div className="folder-bar">
          <Button variant="outline" size="sm" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}>
            <HugeiconsIcon icon={ArrowUp01Icon} className="size-3.5" /> Up
          </Button>
          <code className="grow folder-path" title={listing?.path}>{listing?.path ?? "…"}</code>
          <label className="check small">
            <input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); if (listing) go(listing.path, e.target.checked); }} />
            Hidden folders
          </label>
          {listing && listing.roots.length > 1
            ? listing.roots.map((root) => (
                <Button key={root} variant="ghost" size="sm" onClick={() => go(root)}>{root.replace(/\\$/, "")}</Button>
              ))
            : null}
        </div>
        <div className="folder-list">
          {listing?.folders.map((f) => (
            <button key={f.path} type="button" className="folder-row" onClick={() => go(f.path)}>
              <HugeiconsIcon icon={Folder01Icon} className="size-4 shrink-0" />
              <span className="grow folder-name">{f.name}</span>
              {kind === "git" && f.git ? <Badge variant="secondary">Git</Badge> : null}
              {kind === "unity" && f.unity ? <Badge variant="secondary">Unity</Badge> : null}
            </button>
          ))}
          {listing?.executables.map((f) => (
            <button key={f.path} type="button" className={`folder-row ${selected === f.path ? "selected" : ""}`} aria-pressed={selected === f.path} onClick={() => setSelected(f.path)}>
              <HugeiconsIcon icon={File01Icon} className="size-4 shrink-0" />
              <span className="grow folder-name">{f.name}</span>
            </button>
          ))}
          {empty ? <p className="muted small folder-empty">{kind === "executable" ? "This folder has no subfolders or programs." : "This folder has no subfolders."}</p> : null}
        </div>
        {error ? <div className="error small">{error}</div> : null}
        <DialogFooter className="folder-footer">
          <span className="grow muted small folder-state">{state}</span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!chosen} onClick={() => { onChoose(chosen!); onOpenChange(false); }}>{PICKER[kind].use}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Checks a path against what the field expects: resolves to a confirmation, or rejects with the reason. */
async function checkPath(kind: PathKind, value: string): Promise<string> {
  if (kind === "git") {
    const r = await api<{ path: string; branch: string; head: string }>("/api/projects/check-source", "POST", { path: value });
    return `${r.path} · ${r.branch || "detached HEAD"} · ${r.head.slice(0, 12)}`;
  }
  if (kind === "unity") {
    const listing = await listFolders(value, kind, false);
    if (!listing.unity) throw new Error("This folder is not a Unity project: it needs Assets and ProjectSettings folders.");
    return "Unity project found.";
  }
  const file = splitFile(value);
  if (!file) return "Runs this command from the system path.";
  const listing = await listFolders(file.folder, kind, true);
  if (!listing.executables.some((f) => f.name.toLowerCase() === file.name.toLowerCase())) throw new Error("This program does not exist, or it cannot be run directly. On Windows, use an .exe file.");
  return "Program found.";
}

/** A path on this computer: typed or browsed, and checked as soon as it is entered. */
export function PathField({ kind, label, hint, value, start, onChange }: { kind: PathKind; label: React.ReactNode; hint?: React.ReactNode; value: string; /** Where the picker opens while the field is empty. */ start?: string; onChange: (path: string) => void }) {
  const id = useId();
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const latest = useRef(0);
  const check = async (path: string) => {
    const request = ++latest.current;
    if (!path.trim()) return setStatus(null);
    try {
      const text = await checkPath(kind, path);
      if (request === latest.current) setStatus({ ok: true, text });
    } catch (e) {
      if (request === latest.current) setStatus({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="grow path-field">
      <label htmlFor={id}>{label}</label>
      <div className="path-field-input">
        <input
          id={id}
          value={value}
          spellCheck={false}
          placeholder={PICKER[kind].placeholder}
          onChange={(e) => { latest.current++; setStatus(null); onChange(e.target.value); }}
          onBlur={() => void check(value)}
        />
        <Button type="button" variant="outline" onClick={() => setPicking(true)}>Browse…</Button>
      </div>
      {status ? <p className={`field-hint ${status.ok ? "field-ok" : "field-bad"}`}>{status.text}</p> : null}
      {hint ? <p className="field-hint">{hint}</p> : null}
      <PathPicker kind={kind} open={picking} onOpenChange={setPicking} start={value || start || ""} onChoose={(chosen) => { onChange(chosen); void check(chosen); }} />
    </div>
  );
}
