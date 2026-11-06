import React, { useRef } from "react";
import { Button } from "@/components/ui/button";
import { FORMAT_SIZE, type Format } from "../shared/types";
import { clampFrame, defaultFraming, frameRect, MAX_ZOOM, type Framing, type ShotFrame } from "../shared/framing";

/** Height of a portrait preview and width of a landscape one, in CSS pixels. */
const PREVIEW_LONG_SIDE = 180;

/** One draggable preview in the video's aspect ratio: drag to move the focus point, slider to zoom. */
function FramePane({ label, src, iw, ih, format, frame, onChange }: { label: string; src: string; iw: number; ih: number; format: Format; frame: ShotFrame; onChange: (f: ShotFrame) => void }) {
  const { width: fw, height: fh } = FORMAT_SIZE[format];
  const vw = fw > fh ? PREVIEW_LONG_SIDE : Math.round((PREVIEW_LONG_SIDE * fw) / fh);
  const vh = fw > fh ? Math.round((PREVIEW_LONG_SIDE * fh) / fw) : PREVIEW_LONG_SIDE;
  const r = frameRect(iw, ih, vw, vh, frame);
  const drag = useRef<{ x: number; y: number; frame: ShotFrame } | null>(null);
  const set = (f: ShotFrame) => onChange(clampFrame(iw, ih, vw, vh, f));
  return (
    <div className="frame-pane">
      <div className="muted small">{label}</div>
      <div
        className="frame-view"
        style={{ width: vw, height: vh }}
        title="Drag to choose what fills the screen"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, frame };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          set({ ...d.frame, x: d.frame.x - (e.clientX - d.x) / r.width, y: d.frame.y - (e.clientY - d.y) / r.height });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img src={src} draggable={false} style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      </div>
      <label className="frame-zoom small">
        <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={frame.zoom} onChange={(e) => set({ ...frame, zoom: Number(e.target.value) })} />
        <span className="muted">{frame.zoom.toFixed(2)}×</span>
      </label>
    </div>
  );
}

/** Start and end frame of a material shot. Without stored framing it shows the default and saves on the first change. */
export function FramingEditor(props: { src: string; width: number; height: number; kind: "image" | "video"; format: Format; framing?: Framing; onChange: (f: Framing | undefined) => void }) {
  const { src, width, height, kind, format, onChange } = props;
  const framing = props.framing ?? defaultFraming(kind);
  return (
    <div className="framing">
      <div className="frame-panes">
        <FramePane label="Start" src={src} iw={width} ih={height} format={format} frame={framing.start} onChange={(start) => onChange({ ...framing, start })} />
        <span className="frame-arrow muted">→</span>
        <FramePane label="End" src={src} iw={width} ih={height} format={format} frame={framing.end} onChange={(end) => onChange({ ...framing, end })} />
      </div>
      <div className="row">
        <Button variant="outline" size="xs" onClick={() => onChange({ ...framing, end: { ...framing.start } })} title="Hold the start frame for the whole shot">Hold start</Button>
        <Button variant="outline" size="xs" onClick={() => onChange({ start: framing.end, end: framing.start })} title="Swap start and end">Swap</Button>
        <Button variant="ghost" size="xs" disabled={!props.framing} onClick={() => onChange(undefined)}>Reset</Button>
      </div>
    </div>
  );
}
