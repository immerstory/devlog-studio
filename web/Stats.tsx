import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, useJob } from "./api";
import { PlatformIcon } from "./PlatformIcon";
import { CONNECTOR_LABEL, type EgressConnectorId } from "../shared/publications";
import type { StatItem, StatPoint } from "../shared/types";

interface Report {
  lastRun: { at: string; videos: number; error?: string } | null;
  intervalHours: number;
  items: StatItem[];
}

type Point = StatPoint;

type Metric = "views" | "likes" | "comments" | "reposts";
const METRICS: Array<{ key: Metric; label: string }> = [
  { key: "views", label: "Views" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "reposts", label: "Reposts" },
];
const DAY = 86_400_000;

/** 1,284 / 12.9K / 1.2M */
const compact = (n: number) => (n < 10_000 ? n.toLocaleString() : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n));
const latest = (s: Point[]) => s.at(-1);
/** The last snapshot at least 24 hours older than the newest one. */
const dayAgo = (s: Point[]) => {
  const last = latest(s);
  if (!last) return undefined;
  const cutoff = new Date(last.t).getTime() - DAY;
  return [...s].reverse().find((p) => new Date(p.t).getTime() <= cutoff);
};

/** Sum of each item's value at every refresh time, across the items whose platform reports this number. */
function totals(items: StatItem[], metric: Metric): Point[] {
  const reporting = items.filter((v) => hasMetric(v, metric));
  const times = [...new Set(reporting.flatMap((v) => v.series.map((p) => p.t)))].sort();
  return times.map((t) => ({
    t,
    [metric]: reporting.reduce((n, v) => n + ([...v.series].reverse().find((p) => p.t <= t)?.[metric] ?? 0), 0),
  }));
}
const hasMetric = (item: StatItem, metric: Metric) => item.series.some((p) => p[metric] !== undefined);

function Delta({ now, before }: { now?: number; before?: number }) {
  if (now === undefined || before === undefined) return <span className="muted small">no 24 h history yet</span>;
  const d = now - before;
  return <span className={`small ${d > 0 ? "delta-up" : "muted"}`}>{d > 0 ? "+" : ""}{d.toLocaleString()} in 24 h</span>;
}

/** Tiny trend line in the de-emphasis colour with the latest point in the accent. */
function Sparkline({ points, metric, width = 120, height = 28 }: { points: Point[]; metric: Metric; width?: number; height?: number }) {
  if (points.length < 2) return <span className="muted small">–</span>;
  const vals = points.map((p) => p[metric] ?? 0);
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i: number) => 2 + (i / (vals.length - 1)) * (width - 4);
  const y = (v: number) => height - 3 - (max === min ? 0.5 : (v - min) / (max - min)) * (height - 6);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.5} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(vals.length - 1)} cy={y(vals.at(-1)!)} r={3} fill="var(--chart-2)" stroke="var(--card)" strokeWidth={2} />
    </svg>
  );
}

/** Clean axis ticks: 0, 1, 2, 5 × 10^n steps. */
function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  // Counts are whole numbers, so the step never drops below 1.
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!);
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out.at(-1)! < max) out.push(out.at(-1)! + step);
  return out;
}

/** Single-series line chart over time with a crosshair tooltip; no legend, the heading names the series. */
function LineChart({ points, metric }: { points: Point[]; metric: Metric }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const height = 240;
  const pad = { l: 52, r: 56, t: 14, b: 28 };
  const ts = points.map((p) => new Date(p.t).getTime());
  const vals = points.map((p) => p[metric] ?? 0);
  const yTicks = ticks(Math.max(...vals, 1));
  const yMax = yTicks.at(-1)!;
  const t0 = ts[0], t1 = ts.length > 1 ? ts.at(-1)! : ts[0] + 1;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (width - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / yMax) * (height - pad.t - pad.b);
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(ts.at(-1)!).toFixed(1)},${y(0)}L${x(ts[0]).toFixed(1)},${y(0)}Z`;
  const dateFmt = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: t1 - t0 < 3 * DAY ? "2-digit" : undefined, minute: t1 - t0 < 3 * DAY ? "2-digit" : undefined });
  // Up to five evenly spaced dates; labels that would repeat (short spans) are dropped.
  const xTicks = (ts.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0)) : [t0]).filter((t, i, all) => i === 0 || dateFmt(t) !== dateFmt(all[i - 1]));
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left + pad.l;
    let best = 0;
    ts.forEach((t, i) => (Math.abs(x(t) - px) < Math.abs(x(ts[best]) - px) ? (best = i) : null));
    setHover(best);
  };
  const h = hover !== null ? { tx: x(ts[hover]), ty: y(vals[hover]), v: vals[hover], t: ts[hover] } : null;
  return (
    <div ref={wrap} className="linechart">
      <svg width={width} height={height} role="img" aria-label={`${metric} over time`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" className="axis">{compact(v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={height - 8} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} className="axis">{dateFmt(t)}</text>
        ))}
        {points.length > 1 ? <path d={area} fill="var(--chart-2)" fillOpacity={0.1} /> : null}
        <path d={line} fill="none" stroke="var(--chart-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(ts.at(-1)!)} cy={y(vals.at(-1)!)} r={4} fill="var(--chart-2)" stroke="var(--card)" strokeWidth={2} />
        <text x={x(ts.at(-1)!) + 8} y={y(vals.at(-1)!)} dy="0.32em" className="end-label">{compact(vals.at(-1)!)}</text>
        {h ? (
          <>
            <line x1={h.tx} x2={h.tx} y1={pad.t} y2={height - pad.b} stroke="var(--muted-foreground)" strokeWidth={1} />
            <circle cx={h.tx} cy={h.ty} r={4} fill="var(--chart-2)" stroke="var(--card)" strokeWidth={2} />
          </>
        ) : null}
        <rect x={pad.l} y={pad.t} width={Math.max(1, width - pad.l - pad.r)} height={height - pad.t - pad.b} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {h ? (
        <div className="chart-tip" style={{ left: Math.min(h.tx + 10, width - 170), top: Math.max(0, h.ty - 48) }}>
          <strong>{h.v.toLocaleString()}</strong>
          <span className="muted small">{new Date(h.t).toLocaleString()}</span>
        </div>
      ) : null}
    </div>
  );
}

/** "23 minutes ago" style text for a past moment. */
function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  const [unit, size] = units.find(([, n]) => s >= n)!;
  return new Intl.RelativeTimeFormat("en", { numeric: "always" }).format(-Math.floor(s / size), unit);
}

/** The current time, updated every interval so relative times stay current. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

export function StatsPage() {
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("views");
  const load = () => api<Report>("/api/stats").then(setReport, (e) => setErr(e.message));
  const job = useJob(() => load());
  const now = useNow(30_000);
  useEffect(() => {
    load();
  }, []);

  const items = report?.items ?? [];
  const [platform, setPlatform] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const platforms = useMemo(() => [...new Set(items.map((v) => v.connector))], [items]);
  const shown = useMemo(() => items.filter((v) => {
    const day = v.publishedAt ? localDay(v.publishedAt) : "";
    return (!platform || v.connector === platform) && (!from || (day && day >= from)) && (!to || (day && day <= to));
  }), [items, platform, from, to]);
  const filtered = !!(platform || from || to);
  const current = shown.find((v) => v.id === selected) ?? shown[0];
  const totalSeries = useMemo(() => Object.fromEntries(METRICS.map((m) => [m.key, totals(items, m.key)])) as Record<Metric, Point[]>, [items]);
  // A platform reports only some numbers, so the chart offers what the selected row has.
  const available = current ? METRICS.filter((m) => hasMetric(current, m.key)) : [];
  const shownMetric = available.some((m) => m.key === metric) ? metric : available[0]?.key ?? metric;

  return (
    <div className="panel pad stats-page">
      <div className="row">
        <h2 className="grow">Statistics</h2>
        <span className="muted small">
          {report?.lastRun ? `Updated ${new Date(report.lastRun.at).toLocaleString()} (${timeAgo(Date.parse(report.lastRun.at), now)})` : "Not updated yet"} · refreshes every {report?.intervalHours ?? 3} h while YouTube is connected
        </span>
        <Button variant="outline" disabled={job.running} onClick={() => job.start("/api/stats/refresh").catch((e) => setErr(e.message))}>
          {job.running ? "Refreshing…" : "Refresh now"}
        </Button>
      </div>
      {err || report?.lastRun?.error || (job.job?.status === "failed" && job.job.error) ? <div className="error">{err || report?.lastRun?.error || job.job?.error}</div> : null}
      {!items.length ? <p className="muted">Statistics appear for videos and posts published from Devlog Studio.</p> : null}

      {items.length ? (
        <>
          <div className="kpis">
            {METRICS.map((m) => {
              const s = totalSeries[m.key];
              return (
                <div key={m.key} className="kpi">
                  <span className="label">{m.label}, all posts</span>
                  <span className="kpi-value">{compact(latest(s)?.[m.key] ?? 0)}</span>
                  <Delta now={latest(s)?.[m.key]} before={dayAgo(s)?.[m.key]} />
                  <Sparkline points={s.slice(-12)} metric={m.key} />
                </div>
              );
            })}
          </div>

          <div className="stats-filters row">
            <label className="inline-field">Platform
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">All</option>
                {platforms.map((c) => <option key={c} value={c}>{CONNECTOR_LABEL[c as EgressConnectorId] ?? c}</option>)}
              </select>
            </label>
            <label className="inline-field">Published from<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="inline-field">to<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
            {filtered ? <Button variant="ghost" size="sm" onClick={() => { setPlatform(""); setFrom(""); setTo(""); }}>Clear</Button> : null}
            <span className="muted small grow">{filtered ? `${shown.length} of ${items.length} posts` : `${items.length} posts`}</span>
          </div>
          {!shown.length ? <p className="muted">No posts match these filters.</p> : null}
          <div className="stats-table-scroll">
          <table className="stats-table" hidden={!shown.length}>
            <thead>
              <tr>
                <th>Post</th>
                <th>Published</th>
                <th className="n">Views (24h)</th>
                <th className="n">Likes</th>
                <th className="n">Comments</th>
                <th className="n">Reposts</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => {
                const l = latest(v.series);
                const ago = dayAgo(v.series);
                const number = (value?: number) => (value === undefined ? "–" : value.toLocaleString());
                const trend = METRICS.find((m) => hasMetric(v, m.key))?.key ?? "views";
                return (
                  <tr key={v.id} className={current?.id === v.id ? "selected" : ""} onClick={() => setSelected(v.id)}>
                    <td>
                      <div className="stats-post"><PlatformIcon connector={v.connector} name={v.platform} /><div className="title">{v.title}</div></div>
                      {v.url ? <a className="small" href={v.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{v.url}</a> : null}
                    </td>
                    <td className="nowrap">{v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : v.status}</td>
                    <td className="n nowrap">{number(l?.views)}{l?.views !== undefined && ago?.views !== undefined ? ` (${l.views - ago.views >= 0 ? "+" : ""}${(l.views - ago.views).toLocaleString()})` : ""}</td>
                    <td className="n">{number(l?.likes)}</td>
                    <td className="n">{number(l?.comments)}</td>
                    <td className="n">{number(l?.reposts)}</td>
                    <td title={METRICS.find((m) => m.key === trend)?.label}><Sparkline points={v.series.slice(-12)} metric={trend} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {current ? (
            <div className="chart-card">
              <div className="row">
                <h3 className="grow stats-chart-title">{METRICS.find((m) => m.key === shownMetric)!.label} over time · {current.title}</h3>
                <select value={shownMetric} onChange={(e) => setMetric(e.target.value as Metric)}>
                  {available.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
              </div>
              {current.series.length ? <LineChart points={current.series} metric={shownMetric} /> : <p className="muted">No snapshots yet.</p>}
              <p className="muted small">One point per refresh. Select a row in the table to show another post.</p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
