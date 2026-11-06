import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, projectHref } from "./api";
import { JOB_FINISHED } from "./JobDock";
import { PlatformIcon } from "./PlatformIcon";
import { CONNECTOR_LABEL, type EgressConnectorId } from "../shared/publications";
import type { PostOverview } from "../shared/types";

const STAGES: Array<{ value: string; label: string }> = [
  { value: "questions", label: "Questions" },
  { value: "script", label: "Script" },
  { value: "capture", label: "Shots" },
  { value: "preview", label: "Preview" },
  { value: "narrated", label: "Narrated" },
  { value: "final", label: "Final" },
];
const OUTPUT_LABEL: Record<string, string> = { portrait: "Short", landscape: "Video", article: "Article" };

/** Scheduled posts first, latest date on top; then unscheduled ones, newest first. */
const byPublishDate = (a: PostOverview, b: PostOverview) => {
  if (a.publishDate && b.publishDate) return b.publishDate.localeCompare(a.publishDate);
  if (a.publishDate) return -1;
  if (b.publishDate) return 1;
  return b.createdAt.localeCompare(a.createdAt);
};

/** Every post with its status and what to do next. How a post is doing is on the Statistics page. */
export function PostsPage() {
  const [posts, setPosts] = useState<PostOverview[] | null>(null);
  const [err, setErr] = useState("");
  const [stage, setStage] = useState("");
  const [platform, setPlatform] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const load = useCallback(() => api<PostOverview[]>("/api/posts").then(setPosts, (e) => setErr((e as Error).message)), []);
  useEffect(() => {
    void load();
    const on = () => void load();
    addEventListener(JOB_FINISHED, on);
    return () => removeEventListener(JOB_FINISHED, on);
  }, [load]);

  const all = useMemo(() => [...(posts ?? [])].sort(byPublishDate), [posts]);
  const platforms = useMemo(() => [...new Set(all.flatMap((p) => p.destinations.map((d) => d.connector)))], [all]);
  const needing = all.filter((p) => p.attention.length).length;
  const shown = all.filter((p) =>
    (!stage || p.stage === stage)
    && (!platform || p.destinations.some((d) => d.connector === platform))
    && (!from || (p.publishDate && p.publishDate >= from))
    && (!to || (p.publishDate && p.publishDate <= to))
    && (!attentionOnly || p.attention.length > 0));
  const filtered = !!(stage || platform || from || to || attentionOnly);
  const clear = () => { setStage(""); setPlatform(""); setFrom(""); setTo(""); setAttentionOnly(false); };

  return (
    <div className="panel pad posts-page">
      <h2>Posts</h2>
      {err ? <div className="error">{err}</div> : null}
      {posts && !posts.length ? <p className="muted">No posts yet. In the <a href={projectHref("/calendar")}>Calendar</a>, select suggestions and choose Create post.</p> : null}
      {all.length ? (
        <>
          <div className="stats-filters row">
            <label className="inline-field">Stage
              <select value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">All</option>
                {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label className="inline-field">Platform
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">All</option>
                {platforms.map((c) => <option key={c} value={c}>{CONNECTOR_LABEL[c as EgressConnectorId] ?? c}</option>)}
              </select>
            </label>
            <label className="inline-field">Publish date from<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="inline-field">to<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="check"><input type="checkbox" checked={attentionOnly} disabled={!needing && !attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />Needs attention ({needing})</label>
            {filtered ? <Button variant="ghost" size="sm" onClick={clear}>Clear</Button> : null}
            <span className="muted small grow">{filtered ? `${shown.length} of ${all.length} posts` : `${all.length} posts`}</span>
          </div>
          {!shown.length ? <p className="muted">No posts match these filters.</p> : null}
          <div className="stats-table-scroll">
            <table className="stats-table posts-table" hidden={!shown.length}>
              <thead>
                <tr><th>Post</th><th>Stage</th><th>Outputs</th><th>Destinations</th><th>Publish date</th></tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) location.hash = projectHref(`/post/${p.id}`); }}>
                    <td>
                      <a className="title" href={projectHref(`/post/${p.id}`)}>{p.title}</a>
                      <div className="muted small">{p.topics} topic{p.topics === 1 ? "" : "s"}</div>
                      {p.attention.map((reason) => <div key={reason} className="posts-attention small">{reason}</div>)}
                    </td>
                    <td className="nowrap"><span className={`tag stage-${p.stage}`}>{STAGES.find((s) => s.value === p.stage)?.label ?? p.stage}</span></td>
                    <td className="nowrap">{p.outputs.map((o) => OUTPUT_LABEL[o] ?? o).join(", ")}</td>
                    <td>
                      <div className="posts-destinations">
                        {p.destinations.map((d) => {
                          const body = <><PlatformIcon connector={d.connector} name={d.name} /><span className={`small posts-state ${d.state.toLowerCase().replace(/\W+/g, "-")}`}>{d.state}</span></>;
                          return d.url ? <a key={d.id} className="posts-destination" href={d.url} target="_blank" rel="noreferrer">{body}</a> : <span key={d.id} className="posts-destination">{body}</span>;
                        })}
                      </div>
                    </td>
                    <td className="nowrap">{p.publishDate ? new Date(`${p.publishDate}T00:00:00`).toLocaleDateString() : <span className="muted">Not scheduled</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
