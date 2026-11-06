import React from "react";
import { ListInput } from "@/components/list-input";
import { defaultPageDevice, type Format, type PageDevice, type PageShot } from "../shared/types";

/** A scroll field: digits become pixels, anything else is a CSS selector. */
const scrollValue = (raw: string): number | string => (/^\s*\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : raw.trim());
const percent = (n: number) => Math.round(n * 100);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Fields of a webpage shot: page, device, where it scrolls from and to, how it zooms, and what to hide.
 * `children` holds the shot's action buttons.
 */
export function PageShotFields({ shot, format, onChange, children }: { shot: PageShot; format: Format; onChange: (shot: PageShot) => void; children?: React.ReactNode }) {
  const set = (patch: Partial<PageShot>) => onChange({ ...shot, ...patch });
  const fallback = defaultPageDevice(format);
  return (
    <div className="page-shot">
      <input placeholder="Page URL, or a path on the target's base URL such as /pricing" value={shot.url} onChange={(e) => set({ url: e.target.value })} />
      <div className="row">
        <label>
          Device
          <select value={shot.device ?? ""} onChange={(e) => set({ device: (e.target.value || undefined) as PageDevice | undefined })}>
            <option value="">Format default ({fallback === "phone" ? "phone" : "desktop"})</option>
            <option value="phone">Phone</option>
            <option value="desktop">Desktop</option>
          </select>
        </label>
        <label title="Pixels from the top, or a CSS selector such as #features whose element is brought to the top of the view">
          Scroll from
          <input className="scrollin" value={String(shot.scrollFrom)} placeholder="0" onChange={(e) => set({ scrollFrom: scrollValue(e.target.value) })} />
        </label>
        <label title="Pixels from the top, or a CSS selector such as #features whose element is brought to the top of the view">
          to
          <input className="scrollin" value={String(shot.scrollTo)} placeholder="0" onChange={(e) => set({ scrollTo: scrollValue(e.target.value) })} />
        </label>
      </div>
      <div className="row">
        <label title="1 shows the whole page width; 2 shows half of it, around the focus point">
          Zoom from
          <input className="numin" type="number" min={1} max={4} step={0.1} value={shot.zoomFrom} onChange={(e) => set({ zoomFrom: clamp(Number(e.target.value) || 1, 1, 4) })} />
        </label>
        <label>
          to
          <input className="numin" type="number" min={1} max={4} step={0.1} value={shot.zoomTo} onChange={(e) => set({ zoomTo: clamp(Number(e.target.value) || 1, 1, 4) })} />
        </label>
        <label title="Where the zoom closes in, from the left edge of the view">
          Focus left %
          <input className="numin" type="number" min={0} max={100} value={percent(shot.focus.x)} onChange={(e) => set({ focus: { ...shot.focus, x: clamp(Number(e.target.value) / 100, 0, 1) } })} />
        </label>
        <label title="Where the zoom closes in, from the top edge of the view">
          top %
          <input className="numin" type="number" min={0} max={100} value={percent(shot.focus.y)} onChange={(e) => set({ focus: { ...shot.focus, y: clamp(Number(e.target.value) / 100, 0, 1) } })} />
        </label>
        <label title="How long the page plays after loading before filming starts, for intro animations">
          Wait (ms)
          <input className="numin" type="number" min={0} step={100} placeholder="1000" value={shot.settleMs ?? ""} onChange={(e) => set({ settleMs: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} />
        </label>
      </div>
      <div className="row">
        <label title="Seconds the page holds still before scrolling and zooming start">
          Start after (s)
          <input className="numin" type="number" min={0} step={0.5} placeholder="0" value={shot.delaySeconds ?? ""} onChange={(e) => set({ delaySeconds: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })} />
        </label>
        <label title="Average scroll speed. Empty spreads the scroll over the rest of the shot; a slow speed may not reach the end position before the shot ends.">
          Speed (px/s)
          <input className="numin" type="number" min={1} step={50} placeholder="auto" value={shot.scrollSpeed ?? ""} onChange={(e) => set({ scrollSpeed: e.target.value === "" ? undefined : Math.max(1, Number(e.target.value)) })} />
        </label>
        <label>
          Movement
          <select value={shot.easing ?? "smooth"} onChange={(e) => set({ easing: e.target.value === "linear" ? "linear" : undefined })}>
            <option value="smooth">Smooth start and stop</option>
            <option value="linear">Constant speed</option>
          </select>
        </label>
      </div>
      <label>
        Hide (CSS selectors, e.g. cookie banners)
        <ListInput value={shot.hide ?? []} onChange={(hide) => set({ hide: hide.length ? hide : undefined })} />
      </label>
      <label title="Added to the page after it loads, after the capture target's CSS">
        CSS for this shot
        <textarea className="code" rows={3} spellCheck={false} placeholder=".newsletter-popup { display: none !important; }" value={shot.css ?? ""} onChange={(e) => set({ css: e.target.value || undefined })} />
      </label>
      <div className="row">{children}</div>
    </div>
  );
}
