import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { PageStep, PageView } from "../shared/types";
import { mediaUrl, shortTime } from "./api";
import { PopOutDialog } from "./PopOut";

const STEP_LABEL: Record<PageStep["name"], string> = {
  loaded: "Page loaded",
  cookies: "After the cookie choice",
  hidden: "After hiding",
  styled: "After CSS and script",
  start: "First frame",
  end: "Last frame",
  failed: "When it failed",
};
const RUN_LABEL: Record<PageView["by"], string> = { capture: "the capture", check: "the link check", preview: "the preview" };

const occasion = (view: PageView) => (view.problem ? `when ${RUN_LABEL[view.by]} failed` : `in ${RUN_LABEL[view.by]}`);

/** The steps of a view. A view without steps is its failure alone. */
const stepsOf = (view: PageView): PageStep[] => (view.steps?.length ? view.steps : [{ name: "failed", pageUrl: view.pageUrl, title: view.title, text: view.text, picture: view.picture, notes: [] }]);

/** A step's notes and text, and whether the page showed what the shot looks for. */
function StepDetails({ step }: { step: PageStep }) {
  const finding = (label: string, found?: boolean) => (found === undefined ? null : <li className={found ? "found" : "missing"}>{found ? "✓" : "✕"} {label} {found ? "is on the page" : "isn't on the page"}</li>);
  return (
    <div className="page-step-details">
      <p className="field-hint">{step.title ? `“${step.title}” · ` : ""}{step.pageUrl}</p>
      <ul className="small">
        {finding("The expected text", step.found)}
        {finding("The sentence to highlight", step.highlightFound)}
        {step.notes.map((note, i) => <li key={i}>{note}</li>)}
      </ul>
      <div className="label">Text on the page</div>
      <pre>{step.text || "No text."}</pre>
    </div>
  );
}

/** Every step of a run: a strip of pictures, and the chosen step's picture, notes and text. */
function PageViewDialog({ view, loadView, onClose }: { view: PageView; loadView: () => Promise<PageView | null>; onClose: () => void }) {
  const [full, setFull] = useState<PageView>();
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<number>();
  useEffect(() => {
    let open = true;
    loadView().then((loaded) => { if (open) setFull(loaded ?? view); }, (e) => { if (open) setError((e as Error).message); });
    return () => { open = false; };
  }, [view.at]);
  const steps = stepsOf(full ?? view);
  const index = Math.min(chosen ?? steps.length - 1, steps.length - 1);
  const step = steps[index];
  const when = occasion(view);
  return (
    <PopOutDialog title="What the browser sees" description={`${when[0].toUpperCase()}${when.slice(1)}, ${shortTime(view.at)}`} onClose={onClose}>
      {view.problem ? <div className="error small">{view.problem}</div> : null}
      <div className="page-steps">
        {steps.map((s, i) => (
          <button key={i} type="button" className={i === index ? "page-step chosen" : "page-step"} aria-pressed={i === index} onClick={() => setChosen(i)}>
            {s.picture ? <img src={mediaUrl(s.picture)} alt="" loading="lazy" /> : <span className="page-step-empty">No picture</span>}
            <span className="small">{i + 1}. {STEP_LABEL[s.name]}</span>
          </button>
        ))}
      </div>
      <div className="page-step-view">
        {step.picture ? (
          <a href={mediaUrl(step.picture)} target="_blank" rel="noreferrer" title="Open the picture in full size"><img src={mediaUrl(step.picture)} alt={`The browser's view: ${STEP_LABEL[step.name]}`} /></a>
        ) : null}
        {error ? <div className="error small">{error}</div> : full ? <StepDetails step={step} /> : <Spinner />}
      </div>
    </PopOutDialog>
  );
}

/** The last picture of a shot's latest failure or preview, which opens every step. */
export function PageViewCard({ view, loadView }: { view: PageView; loadView: () => Promise<PageView | null> }) {
  const [open, setOpen] = useState(false);
  const count = stepsOf(view).length;
  return (
    <div className="page-view">
      {view.picture ? (
        <button type="button" title="See every step" onClick={() => setOpen(true)}>
          <img src={mediaUrl(view.picture)} alt={`The browser's view ${occasion(view)}`} loading="lazy" />
        </button>
      ) : null}
      <div className="page-view-text">
        <p className="field-hint"><b>What the browser saw</b> {occasion(view)}, {shortTime(view.at)}{view.title ? `: “${view.title}”` : ""}</p>
        {view.pageUrl !== view.url ? <p className="field-hint">The page was at {view.pageUrl}</p> : null}
        {view.by === "preview" && view.problem ? <p className="field-hint">A capture would fail: {view.problem}</p> : null}
        <div className="row"><Button variant="outline" size="sm" onClick={() => setOpen(true)}>{count > 1 ? `See all ${count} steps` : "See the page"}</Button></div>
      </div>
      {open ? <PageViewDialog view={view} loadView={loadView} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
