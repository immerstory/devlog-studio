import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SegTabs } from "@/components/seg-tabs";
import { api } from "./api";
import { spokenTurns } from "../shared/turns";
import type { Format, Post, Presentation, Script, Segment, Speaker, Turn, VerificationState } from "../shared/types";

export interface CoHostInfo {
  coHost: { enabled: boolean; name: string; captionColor: string; share: Record<Format, number> } | null;
  verification: { state: VerificationState; checkedAt?: string; flags: Array<{ key: string; turnId: string; claim: string; reason: string }>; accepted: string[] } | null;
}

/** The project's co-host and the state of this format's check, read again whenever the post changes. */
export function useCoHost(ep: Post, format: Format) {
  const [info, setInfo] = useState<CoHostInfo | null>(null);
  const refresh = useCallback(() => api<CoHostInfo>(`/api/posts/${ep.id}/co-host/${format}`).then(setInfo, () => setInfo(null)), [ep.id, format]);
  useEffect(() => { void refresh(); }, [ep, refresh]);
  return { info, refresh };
}

export const CoHostContext = createContext<{ info: CoHostInfo | null; refresh: () => Promise<void>; dirty: boolean; postId: string; format: Format } | null>(null);

const FORMAT_NAME: Record<Format, string> = { portrait: "Short", landscape: "Landscape video" };
const PRESENTATIONS = [{ value: "solo" as const, label: "Solo" }, { value: "coHost" as const, label: "Co-hosted" }];

/** Solo or co-hosted, per video format. It appears only when the project has a co-host or a format already uses one. */
export function PresentationChoice({ ep, setEp }: { ep: Post; setEp: (post: Post) => void }) {
  const formats = ep.outputs.filter((o): o is Format => o !== "article");
  const { info } = useCoHost(ep, formats[0] ?? "portrait");
  const [err, setErr] = useState("");
  const used = formats.some((f) => ep.presentation?.[f] === "coHost");
  if (!info?.coHost?.enabled && !used) return null;
  const change = async (format: Format, presentation: Presentation) => {
    const hasScript = !!ep.scripts[format];
    if (hasScript && !confirm(`Change this ${FORMAT_NAME[format].toLowerCase()} to ${presentation === "coHost" ? "co-hosted" : "solo"}?\n\nIts script, narration and render record are deleted, and it returns to Questions. Your answers, the other format and rendered files stay.`)) return;
    setErr("");
    try {
      setEp(await api<Post>(`/api/posts/${ep.id}/presentation/${format}`, "PUT", { presentation, confirm: hasScript }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="presentation-choice">
      {formats.map((format) => (
        <div key={format} className="row">
          <span className="presentation-format">{FORMAT_NAME[format]}</span>
          <SegTabs value={ep.presentation?.[format] ?? "solo"} onChange={(value) => change(format, value as Presentation)} items={PRESENTATIONS} />
        </div>
      ))}
      <p className="field-hint">Choose before writing the script. The questions and your answers are the same for both.</p>
      {err ? <div className="error">{err}</div> : null}
    </div>
  );
}

const SPEAKER_LABEL: Record<Speaker, string> = { developer: "Developer", coHost: "Co-host" };

/** The ordered lines of one co-hosted segment. */
export function TurnsEditor({ seg, onChange }: { seg: Segment; onChange: (seg: Segment) => void }) {
  const context = useContext(CoHostContext);
  const turns = seg.turns ?? [];
  const setTurns = (next: Turn[]) => onChange({ ...seg, turns: next });
  const setTurn = (i: number, patch: Partial<Turn>) => setTurns(turns.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const move = (i: number, by: number) => {
    const next = [...turns];
    next.splice(i + by, 0, ...next.splice(i, 1));
    setTurns(next);
  };
  const verification = context?.dirty ? null : context?.info?.verification;
  const shownFlags = verification && verification.state !== "outOfDate" ? verification.flags : [];
  const setKept = async (key: string, keep: boolean) => {
    await api(`/api/posts/${context!.postId}/verification/${context!.format}/flags/${key}`, "PUT", { keep });
    await context!.refresh();
  };
  const color = context?.info?.coHost?.captionColor;
  return (
    <div className="turns">
      {turns.map((turn, i) => (
        <div key={turn.id} className="turn">
          <div className="row">
            <select aria-label="Speaker" value={turn.speaker} onChange={(e) => setTurn(i, { speaker: e.target.value as Speaker })}>
              {(["developer", "coHost"] as const).map((s) => <option key={s} value={s}>{SPEAKER_LABEL[s]}</option>)}
            </select>
            <span className="grow" />
            <Button variant="ghost" size="icon-xs" aria-label="Move line up" disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
            <Button variant="ghost" size="icon-xs" aria-label="Move line down" disabled={i === turns.length - 1} onClick={() => move(i, 1)}>↓</Button>
            <Button variant="ghost" size="icon-xs" aria-label="Remove line" className="text-destructive" onClick={() => setTurns(turns.filter((_, k) => k !== i))}>✕</Button>
          </div>
          <textarea rows={2} aria-label="Line" style={turn.speaker === "coHost" && color ? { borderLeft: `4px solid ${color}` } : undefined} value={turn.text} onChange={(e) => setTurn(i, { text: e.target.value })} />
          {turn.agentText !== undefined && turn.agentText !== turn.text ? (
            <div className="muted small edited">
              Edited · agent wrote: “{turn.agentText}”
              <Button variant="link" size="xs" onClick={() => setTurn(i, { text: turn.agentText! })}>restore</Button>
            </div>
          ) : null}
          {shownFlags.filter((f) => f.turnId === turn.id).map((flag) => {
            const kept = verification!.accepted.includes(flag.key);
            return (
              <div key={flag.key} className={`claim-flag ${kept ? "kept" : ""}`}>
                <span className="grow"><strong>{kept ? "Kept" : "No source"}:</strong> {flag.claim}. <span className="muted">{flag.reason}</span></span>
                <Button variant="outline" size="xs" onClick={() => setKept(flag.key, !kept)}>{kept ? "Undo" : "Keep anyway"}</Button>
              </div>
            );
          })}
        </div>
      ))}
      <Button variant="outline" size="xs" onClick={() => setTurns([...turns, { id: `turn-${crypto.randomUUID()}`, speaker: turns.at(-1)?.speaker === "coHost" ? "developer" : "coHost", text: "" }])}>Add line</Button>
    </div>
  );
}

const countWords = (turns: Turn[]) => turns.reduce((n, t) => n + t.text.trim().split(/\s+/).filter(Boolean).length, 0);

/** The state of the check, with the word share against its target. */
export function CoHostPanel({ script, format, dirty, busy, onCheck }: { script: Script; format: Format; dirty: boolean; busy: boolean; onCheck: () => void }) {
  const info = useContext(CoHostContext)?.info;
  const turns = script.segments.flatMap(spokenTurns);
  const total = countWords(turns);
  const share = total ? Math.round((countWords(turns.filter((t) => t.speaker === "coHost")) / total) * 100) : 0;
  const v = info?.verification;
  const open = v ? v.flags.filter((f) => !v.accepted.includes(f.key)).length : 0;
  const stale = dirty || !v || v.state === "outOfDate";
  return (
    <div className="cohost-panel">
      <span className="small">
        {info?.coHost?.name || "Co-host"}: {share}% of words{info?.coHost ? ` (target ${Math.round(info.coHost.share[format] * 100)}%)` : ""}
      </span>
      <span className={`small grow ${!stale && !open ? "" : "cohost-attention"}`}>
        {stale ? "Co-host lines need a check before approval." : open ? `${open} flagged line${open === 1 ? "" : "s"} to resolve before approval.` : "Co-host lines are verified."}
      </span>
      <Button variant="outline" size="sm" disabled={busy} onClick={onCheck} title={dirty ? "Saves your edits, then checks" : "Runs one read-only agent pass. It flags lines and doesn't rewrite them."}>Check co-host lines</Button>
    </div>
  );
}
