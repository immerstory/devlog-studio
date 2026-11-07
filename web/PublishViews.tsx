import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SecretInput } from "@/components/secret-input";
import { SettingsItem, SettingsSection } from "@/components/settings-section";
import { api, mediaUrl, projectHref } from "./api";
import { PathField } from "./PathField";
import { SegTabs } from "@/components/seg-tabs";
import { ArticlePreview } from "./ArticlePreview";
import { activitySourceId, type ActivitySource } from "../shared/activity";
import type { ArticleDraft } from "../shared/outputs";
import type { ProjectSettings } from "../shared/projects";
import { CONNECTOR_LABEL, estimatedLength, TEXT_LIMIT, type EgressConnectorId, type Publication, type PublicEgressConnection } from "../shared/publications";
import type { Post } from "../shared/types";

type RunFn = (url: string, body?: object) => Promise<void>;
const STATE_LABEL: Record<Publication["state"], string> = { draft: "Draft", approved: "Approved", waiting: "Waiting", scheduled: "Scheduled", late: "Missed its time", publishing: "Publishing…", published: "Published", failed: "Failed", cancelled: "Cancelled" };
type Listed = Publication & { problems: string[] };

const POLL_MS = 3000;

/** What went out and when, in the same shape for every platform. Numbers live on the Statistics page. */
function PublishedDetails({ publication: p }: { publication: Publication }) {
  const upload = p.result?.upload;
  const content = p.result?.title ?? p.result?.sentText ?? p.content.text;
  const scheduled = upload?.status === "scheduled" && upload.publishAt;
  const when = p.result?.publishedAt;
  const facts = [
    scheduled ? `Goes public ${new Date(upload.publishAt!).toLocaleString()}` : when ? `Published ${new Date(when).toLocaleString()}` : "",
    upload?.privacy && !scheduled ? upload.privacy[0].toUpperCase() + upload.privacy.slice(1) : "",
    upload?.captions ? "Captions added" : "",
  ].filter(Boolean);
  return (
    <div className="publication-details">
      {content ? <p className="publication-content">{content}</p> : null}
      {facts.length ? <p className="muted small">{facts.join(" · ")}</p> : null}
    </div>
  );
}

/** The post's publications: what goes where, in which order. Nothing goes out without approval. */
export function PublishStep({ ep, run, busy }: { ep: Post; run: RunFn; busy: boolean }) {
  const [items, setItems] = useState<Listed[]>([]);
  const [connections, setConnections] = useState<PublicEgressConnection[]>([]);
  const [err, setErr] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [waitFor, setWaitFor] = useState("");
  const load = useCallback(() => api<Listed[]>(`/api/posts/${ep.id}/publications`).then(setItems), [ep.id]);
  useEffect(() => { void load(); api<PublicEgressConnection[]>("/api/egress/connections").then(setConnections, () => setConnections([])); }, [load, busy]);
  // A publication moves on without this page: while one is on its way, keep its state current.
  const onItsWay = items.some((p) => ["approved", "waiting", "scheduled", "publishing"].includes(p.state));
  useEffect(() => {
    if (!onItsWay) return;
    const timer = setInterval(() => void load().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [onItsWay, load]);
  const act = async (work: () => Promise<unknown>) => { setErr(""); try { await work(); await load(); } catch (e) { setErr((e as Error).message); } };

  const videoName = (p: Publication) => `YouTube ${p.content.videoFormat === "portrait" ? "Short" : "video"}`;
  const uploads = items.filter((p) => p.connector === "youtube").map((p) => ({ id: p.id, label: videoName(p) }));
  const nameOf = (id: string) => uploads.find((u) => u.id === id)?.label ?? (() => { const p = items.find((x) => x.id === id); return p ? CONNECTOR_LABEL[p.connector] : "A removed publication"; })();
  const destinations = connections.filter((c) => c.connector !== "youtube");
  const add = () => act(async () => {
    const connection = connections.find((c) => c.id === connectionId);
    if (!connection) throw new Error("Choose a connection. You can add one in Settings.");
    await api(`/api/posts/${ep.id}/publications`, "POST", { connector: connection.connector, connectionId, dependsOn: waitFor ? [{ publicationId: waitFor, when: "public" }] : [] });
    setWaitFor("");
  });
  const patch = (id: string, body: unknown) => act(() => api(`/api/publications/${id}`, "PATCH", body));
  const post = (id: string, action: string) => act(() => api(`/api/publications/${id}/${action}`, "POST"));

  return (
    <div className="panel">
      <p className="muted small">A video uploads from the Final step. Here you add other destinations, and a destination can wait until a video or article is public. Each one goes out only after you approve it, and only while this app is running.</p>
      {err ? <div className="error">{err}</div> : null}
      {items.filter((p) => p.connector === "youtube").map((p) => {
        const upload = p.result?.upload;
        const status = upload?.status === "scheduled" ? "Scheduled" : upload?.status === "uploading" ? "Uploading…" : upload?.status === "failed" ? "Failed" : upload?.videoId ? "Published" : "Not uploaded";
        return (
          <div key={p.id} className="publication">
            <div className="row">
              <strong>{videoName(p)}</strong>
              <span className={`publication-state ${p.state}`}>{status}</span>
              <span className="grow muted small">{upload?.videoId ? "" : "Upload it from the Final step."}</span>
              {upload?.videoId ? <a className="small" href={projectHref("/stats")}>Statistics</a> : null}
              {p.result?.url ? <a className="small" href={p.result.url} target="_blank" rel="noreferrer">Open</a> : null}
            </div>
            {upload?.videoId ? <PublishedDetails publication={p} /> : null}
            {upload?.error ? <div className="error small">{upload.error}</div> : null}
          </div>
        );
      })}
      {items.filter((p) => p.connector !== "youtube").map((p) => {
        const editable = p.state !== "published" && p.state !== "publishing" && p.state !== "cancelled";
        const textual = p.connector === "bluesky" || p.connector === "linkedin";
        const limit = TEXT_LIMIT[p.connector];
        return (
          <div key={p.id} className="publication">
            <div className="row">
              <strong>{CONNECTOR_LABEL[p.connector]}</strong>
              <span className={`publication-state ${p.state}`}>{STATE_LABEL[p.state]}</span>
              <span className="grow muted small">{p.dependsOn.length ? `After ${p.dependsOn.map((d) => `${nameOf(d.publicationId)} is ${d.when}`).join(", ")}` : ""}</span>
              {p.state === "published" && p.connector === "bluesky" ? <a className="small" href={projectHref("/stats")}>Statistics</a> : null}
              {p.result?.url ? <a className="small" href={p.result.url} target="_blank" rel="noreferrer">Open</a> : null}
            </div>
            {p.state === "published" ? <PublishedDetails publication={p} /> : textual ? (
              <>
                <textarea rows={3} disabled={!editable} value={p.content.text ?? ""} onChange={(e) => setItems(items.map((x) => (x.id === p.id ? { ...x, content: { ...x.content, text: e.target.value } } : x)))} onBlur={(e) => patch(p.id, { content: { text: e.target.value } })} />
                {limit ? <span className="muted small">{estimatedLength(p.content.text ?? "")} of {limit} characters, counting a link as up to 60. <code>{"{{youtube.url}}"}</code> and <code>{"{{article.url}}"}</code> become the real address when it goes out.</span> : null}
              </>
            ) : <p className="small muted">Publishes this post's article.</p>}
            {p.problems.length && editable ? <p className="small cohost-attention">{p.problems.join(" ")}</p> : null}
            {p.result?.error ? <div className="error small">{p.result.error}</div> : null}
            <div className="row">
              {editable ? <label className="inline-field small">Not before<input type="datetime-local" disabled={p.state === "publishing"} value={p.publishAt ? toLocalInput(p.publishAt) : ""} onChange={(e) => patch(p.id, { publishAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label> : null}
              {textual && editable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => run(`/api/publications/${p.id}/write`)}>{p.content.text ? "Rewrite text" : "Write text"}</Button> : null}
              {(p.state === "draft" || p.state === "failed") ? <Button size="sm" disabled={busy || !!p.problems.length} onClick={() => run(`/api/publications/${p.id}/approve`)}>{p.state === "failed" ? "Retry" : "Approve"}</Button> : null}
              {["approved", "waiting", "scheduled"].includes(p.state) ? <Button variant="outline" size="sm" onClick={() => post(p.id, "withdraw")}>Withdraw approval</Button> : null}
              {p.state === "late" ? <Button size="sm" disabled={busy} onClick={() => run(`/api/publications/${p.id}/publish-late`)}>Publish now</Button> : null}
              {editable && p.state !== "draft" ? <Button variant="ghost" size="sm" onClick={() => post(p.id, "cancel")}>Cancel</Button> : null}
              {p.state === "draft" || p.state === "cancelled" ? <Button variant="ghost" size="sm" onClick={() => act(() => api(`/api/publications/${p.id}`, "DELETE"))}>Remove</Button> : null}
            </div>
          </div>
        );
      })}
      <div className="row align-end">
        <label className="grow">Add a destination
          <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">{destinations.length ? "Choose a connection" : "No connections yet: add one in Global settings"}</option>
            {destinations.map((c) => <option key={c.id} value={c.id}>{CONNECTOR_LABEL[c.connector]}: {c.name}</option>)}
          </select>
        </label>
        <label className="grow">Wait until public
          <select value={waitFor} onChange={(e) => setWaitFor(e.target.value)}>
            <option value="">Don't wait</option>
            {uploads.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            {items.filter((p) => p.connector === "folder" || p.connector === "git-site").map((p) => <option key={p.id} value={p.id}>Article ({CONNECTOR_LABEL[p.connector]})</option>)}
          </select>
        </label>
        <Button variant="outline" disabled={!connectionId} onClick={add}>Add</Button>
      </div>
    </div>
  );
}

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/** Writes and edits the post's article, with its pictures and alt text. */
export function ArticleStep({ ep, run, busy, reload }: { ep: Post; run: RunFn; busy: boolean; reload: () => Promise<Post> }) {
  const [draft, setDraft] = useState<ArticleDraft | undefined>(ep.article?.draft);
  const [dirty, setDirty] = useState(false);
  const [images, setImages] = useState<Array<{ id: string; title: string; key: string; source: string }>>([]);
  const [err, setErr] = useState("");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [youtube, setYoutube] = useState<{ id: string; url?: string }>();
  useEffect(() => {
    api<Publication[]>(`/api/posts/${ep.id}/publications`).then((all) => {
      const upload = all.map((p) => p.result?.upload).find((u) => u?.videoId);
      setYoutube(upload ? { id: upload.videoId!, url: upload.url } : undefined);
    }, () => setYoutube(undefined));
  }, [ep.id, busy]);
  useEffect(() => { if (!dirty) setDraft(ep.article?.draft); api<typeof images>(`/api/posts/${ep.id}/article/images`).then(setImages, () => setImages([])); }, [ep]);
  const set = (patch: Partial<ArticleDraft>) => { if (draft) { setDraft({ ...draft, ...patch }); setDirty(true); } };
  const save = async () => { setErr(""); try { await api(`/api/posts/${ep.id}/article`, "PUT", draft); setDirty(false); await reload(); } catch (e) { setErr((e as Error).message); } };
  const used = draft ? [...new Set([...[...draft.body.matchAll(/\{\{image:([^}]+)\}\}/g)].map((m) => m[1]), ...(draft.coverId ? [draft.coverId] : [])])] : [];
  return (
    <div className="panel">
      <div className="row">
        <Button disabled={busy} onClick={() => run(`/api/posts/${ep.id}/article/write`)}>{draft ? "Rewrite article" : "Write article"}</Button>
        <Button variant="outline" disabled={!dirty} onClick={save}>Save edits</Button>
        {draft ? <span className="muted">{draft.body.trim().split(/\s+/).length} words</span> : null}
        {draft ? <div className="article-view"><SegTabs value={view} onChange={setView} items={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} /></div> : null}
      </div>
      {err ? <div className="error">{err}</div> : null}
      {!draft ? <p className="muted">No article yet. It uses this post's topics, answers and materials.</p> : view === "preview" ? <ArticlePreview draft={draft} pictures={images} youtube={youtube} /> : (
        <>
          <label>Title<input value={draft.title} onChange={(e) => set({ title: e.target.value })} /></label>
          <label>URL slug<input value={draft.slug ?? ""} onChange={(e) => set({ slug: e.target.value })} /></label>
          <label>Summary<textarea rows={2} value={draft.summary} onChange={(e) => set({ summary: e.target.value })} /></label>
          <label>Body (Markdown)<textarea rows={20} value={draft.body} onChange={(e) => set({ body: e.target.value })} /><span className="field-hint">A picture is <code>{"{{image:ID}}"}</code> on its own line. <code>{"{{youtube.embed}}"}</code> and <code>{"{{youtube.url}}"}</code> work when the article waits for a YouTube upload.</span></label>
          {draft.agentBody !== undefined && draft.agentBody !== draft.body ? <Button variant="link" size="xs" onClick={() => set({ body: draft.agentBody })}>Restore the agent's text</Button> : null}
          <div className="label">Pictures</div>
          <div className="article-images">
            {images.map((i) => (
              <div key={i.id} className="article-image">
                <img src={mediaUrl(i.key)} alt="" loading="lazy" />
                <div className="grow">
                  <div className="small">{i.title}</div>
                  <code className="small">{`{{image:${i.id}}}`}</code>
                  {used.includes(i.id) ? <input aria-label="Alt text" placeholder="Alt text: what the picture shows" value={draft.images?.[i.id]?.alt ?? ""} onChange={(e) => set({ images: { ...draft.images, [i.id]: { alt: e.target.value } } })} /> : <Button variant="outline" size="xs" onClick={() => set({ body: `${draft.body}\n\n{{image:${i.id}}}\n` })}>Add to the end</Button>}
                  <label className="check small"><input type="radio" name="article-cover" checked={draft.coverId === i.id} onChange={() => set({ coverId: i.id })} />Cover</label>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SourceCandidate { connector: string; label: string; detail: string; found: number; repo?: string; baseUrl?: string; tokenSet?: boolean }

/** The address and token of a self-hosted forge. The token goes to the server and doesn't come back. */
function ForgeFields({ candidate, source, onAddress }: { candidate: SourceCandidate; source?: ActivitySource; onAddress: (baseUrl: string) => void }) {
  const [token, setToken] = useState("");
  const [stored, setStored] = useState(!!candidate.tokenSet);
  const [status, setStatus] = useState("");
  const baseUrl = source?.baseUrl ?? candidate.baseUrl ?? "";
  const save = async () => {
    setStatus("Checking…");
    try {
      const r = await api<{ private: boolean }>(`/api/activity/sources/${activitySourceId("forgejo", candidate.repo)}/token`, "PUT", { token, baseUrl, repo: candidate.repo });
      setToken("");
      setStored(true);
      setStatus(`The token works. The repository is ${r.private ? "private, so its records stay private" : "public"}.`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };
  return (
    <>
      <label>Server address<input value={baseUrl} onChange={(e) => onAddress(e.target.value.trim())} /></label>
      <div className="row align-end">
        <label className="grow">Access token {stored ? "(stored; type to replace)" : "(not set)"}<SecretInput stored={stored} value={token} onChange={setToken} /></label>
        <Button type="button" variant="outline" disabled={!token.trim() || !baseUrl} onClick={save}>Save token</Button>
      </div>
      <p className="field-hint">Create it in your Forgejo or Gitea account under Settings &gt; Applications, with read access to repositories and issues. {status}</p>
    </>
  );
}

/** Which activity sources a project reads. All are off until turned on here. */
export function ActivitySourcesSection({ settings, active, onChange }: { settings: ProjectSettings; active: boolean; onChange: (sources: ActivitySource[]) => void }) {
  const [candidates, setCandidates] = useState<SourceCandidate[] | null>(null);
  const [err, setErr] = useState("");
  // Looks only when its tab opens, and only once: looking reads Git remotes and session logs, and can contact a forge.
  useEffect(() => { if (active && !candidates) api<SourceCandidate[]>("/api/activity/sources").then(setCandidates, (e) => setErr((e as Error).message)); }, [active]);
  const sources = settings.activitySources ?? [];
  const change = (c: SourceCandidate, patch: Partial<ActivitySource>) => {
    const connector = c.connector as ActivitySource["connector"];
    const id = activitySourceId(connector, c.repo);
    onChange(sources.some((s) => s.id === id) ? sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) : [...sources, { id, connector, enabled: false, repo: c.repo, baseUrl: c.baseUrl, ...patch }]);
  };
  const terms = sources.find((s) => s.redactTerms?.length)?.redactTerms ?? [];
  const isSession = (connector: ActivitySource["connector"]) => connector === "claude-sessions" || connector === "codex-sessions";
  // Until the search answers, the session tools and the saved forge sources show with their settings, so nothing waits on reading logs.
  const pending: SourceCandidate[] = [
    { connector: "claude-sessions", label: "Claude Code sessions", detail: "Counting sessions…", found: -1 },
    { connector: "codex-sessions", label: "Codex sessions", detail: "Counting sessions…", found: -1 },
    ...sources.filter((s) => !isSession(s.connector)).map((s): SourceCandidate => ({ connector: s.connector, label: s.repo ?? s.connector, detail: "Checking…", found: -1, repo: s.repo, baseUrl: s.baseUrl })),
  ];
  const shown = candidates?.filter((c) => c.connector !== "git") ?? pending;
  const hasForge = shown.some((c) => c.connector === "github" || c.connector === "forgejo");
  return (
    <SettingsSection title="Connected activity" description="Adds to the commits from the Sources section above. These appear on the Activity page, and they stay off until you turn them on.">
      {err ? <div className="error small">{err}</div> : null}
      {shown.map((c) => {
        const source = sources.find((s) => s.id === activitySourceId(c.connector, c.repo));
        return (
          <div key={`${c.connector}${c.repo ?? ""}`}>
            <label className="check"><input type="checkbox" disabled={!c.found} checked={!!source?.enabled} onChange={(e) => change(c, { enabled: e.target.checked })} />{c.label}</label>
            <p className="field-hint">{c.detail}</p>
            {isSession(c.connector as ActivitySource["connector"]) && source?.enabled ? (
              <>
                <label className="check"><input type="checkbox" checked={!!source.importImages} onChange={(e) => change(c, { importImages: e.target.checked })} />Import screenshots I sent</label>
                <p className="field-hint">Stores the images you sent to this tool. They wait under Materials &gt; From sessions until you add them, and agents can't see them there. Saving with this option on reads the older logs once.</p>
              </>
            ) : null}
            {c.connector === "forgejo" && source?.enabled && candidates ? <ForgeFields candidate={c} source={source} onAddress={(baseUrl) => change(c, { baseUrl })} /> : null}
          </div>
        );
      })}
      {candidates && !hasForge ? <p className="field-hint">Pull requests and issues appear here when a source has an origin remote on GitHub, Forgejo or Gitea.</p> : null}
      <p className="field-hint">Session logs stay on this computer. The app stores a short digest with secrets removed: times, edited files, Git commands, check results and shortened prompts. Tool output, file contents and pasted text stay out. A session that edits mostly outside this project's sources counts as other work and starts excluded. An agent sees a digest only when you select Summarize, and it may run with another provider than the tool that wrote the log. Summaries inform the writers, who can't quote them.</p>
      <label>Terms to remove from session digests
        <input value={terms.join(", ")} placeholder="For example, unannounced feature names" onChange={(e) => { const list = e.target.value.split(",").map((t) => t.trimStart()); onChange(sources.map((s) => (isSession(s.connector) ? { ...s, redactTerms: list } : s))); }} />
      </label>
    </SettingsSection>
  );
}

interface ConnectionField { key: string; label: string; placeholder?: string; hint?: React.ReactNode; kind?: "git" }
const linkedinRedirectUrl = () => `http://localhost:${location.port}/api/egress/linkedin/callback`;
const docLink = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;

/** What each platform needs, and where each value comes from. */
const CONNECTOR_SETUP: Record<EgressConnectorId, { summary: string; steps: () => React.ReactNode[]; config: ConnectionField[]; secrets: ConnectionField[] }> = {
  youtube: {
    summary: "Uploads and schedules a post's videos from its Final step. Each connection is one channel.",
    steps: () => [
      <>In the {docLink("https://console.cloud.google.com/apis/library/youtube.googleapis.com", "Google Cloud console")}, create a project and enable the <strong>YouTube Data API v3</strong>.</>,
      <>Under <strong>Google Auth Platform &gt; Clients</strong>, create an OAuth client of type <strong>Desktop app</strong>, and copy its client ID and secret. While the app is in testing, add yourself as a test user.</>,
      <>Save the connection here, then select <strong>Connect</strong> and sign in with the channel's Google account.</>,
    ],
    config: [{ key: "clientId", label: "OAuth client ID" }],
    secrets: [{ key: "clientSecret", label: "Client secret", hint: "From the same OAuth client." }],
  },
  bluesky: {
    summary: "Posts short texts with a link card to your Bluesky account.",
    steps: () => [
      <>In Bluesky, open {docLink("https://bsky.app/settings/app-passwords", "Settings > Privacy and security > App passwords")}.</>,
      <>Select <strong>Add App Password</strong> and name it, for example "Devlog Studio". This app doesn't need access to direct messages.</>,
      <>Copy the password, which looks like <code>xxxx-xxxx-xxxx-xxxx</code>. Bluesky shows it only once, so if you lose it, delete it there and create a new one.</>,
    ],
    config: [{ key: "handle", label: "Handle", placeholder: "you.bsky.social", hint: "Your full handle without the @." }],
    secrets: [{ key: "appPassword", label: "App password", hint: "Not your account password. An app password can be revoked on its own." }],
  },
  linkedin: {
    summary: "Posts to the personal profile of the account you connect, as text, a link or a video.",
    steps: () => [
      <>Create an app in the {docLink("https://www.linkedin.com/developers/apps", "LinkedIn developer portal")}. LinkedIn may ask you to link it to a LinkedIn Page.</>,
      <>On its <strong>Products</strong> tab, add <strong>Share on LinkedIn</strong> and <strong>Sign In with LinkedIn using OpenID Connect</strong>.</>,
      <>On its <strong>Auth</strong> tab, copy the client ID and client secret, and add this redirect URL: <code>{linkedinRedirectUrl()}</code></>,
      <>Save the connection here, then select <strong>Connect</strong> and sign in. Access lasts about 60 days, and then you connect again.</>,
    ],
    config: [{ key: "clientId", label: "Client ID" }],
    secrets: [{ key: "clientSecret", label: "Client secret", hint: "From the same Auth tab." }],
  },
  folder: {
    summary: "Exports each article to a folder on this computer, as article.md with an images folder.",
    steps: () => [],
    config: [
      { key: "path", label: "Folder", hint: "Each article gets its own subfolder here." },
      { key: "baseUrl", label: "Site address (optional)", placeholder: "https://example.com", hint: "Only needed if another post links to the article. The app then waits until this address answers." },
      { key: "urlPattern", label: "Article path (optional)", placeholder: "/{{slug}}/", hint: "Where an article appears on the site. {{slug}} stands for its URL slug." },
    ],
    secrets: [],
  },
  "git-site": {
    summary: "Commits each article to a new local branch of your static site, in a temporary worktree, so your checkout stays as it is.",
    steps: () => [<>Merge the branch to publish the article, or turn on pushing below. The defaults follow Hugo, so adjust the paths for other site generators.</>],
    config: [
      { key: "repoPath", label: "Site's Git working copy", kind: "git" },
      { key: "contentDir", label: "Content folder", placeholder: "content/posts", hint: "Relative to the working copy." },
      { key: "fileName", label: "File name", placeholder: "{{slug}}.md", hint: "{{slug}} stands for the article's URL slug." },
      { key: "imagesDir", label: "Images folder", placeholder: "static/images/{{slug}}", hint: "Where the picture files go, relative to the working copy." },
      { key: "imagePrefix", label: "Image path in Markdown", placeholder: "/images/{{slug}}", hint: "How the published page refers to those pictures." },
      { key: "baseUrl", label: "Site address", placeholder: "https://example.com", hint: "Lets the app wait until the article is live before a post links to it." },
      { key: "urlPattern", label: "Article path", placeholder: "/blog/{{slug}}/", hint: "Where an article appears on the site." },
    ],
    secrets: [],
  },
};

/** One named connection. A stored secret shows masked, and typing replaces it; a new connection starts empty. */
function EgressConnectionCard({ connection, connector, others, onSaved, onRemove }: { connection?: PublicEgressConnection; connector: EgressConnectorId; others: PublicEgressConnection[]; onSaved: () => Promise<unknown>; onRemove: () => void }) {
  const setup = CONNECTOR_SETUP[connector];
  const [name, setName] = useState(connection?.name ?? "");
  const [config, setConfig] = useState<Record<string, string | boolean | undefined>>(connection?.config ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [copyClientFrom, setCopyClientFrom] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => { if (connection) setConfig(connection.config); }, [connection]);
  const dirty = !connection || !!copyClientFrom || name !== connection.name || JSON.stringify(config) !== JSON.stringify(connection.config) || Object.values(secrets).some(Boolean);
  const connected = connector === "youtube" ? !!connection?.secretsSet.includes("refreshToken") : !!connection?.secretsSet.includes("accessToken");
  const accountName = String(connection?.config.channelTitle ?? connection?.config.accountName ?? "");
  const act = async (work: () => Promise<unknown>) => { setMsg(""); try { await work(); } catch (e) { setMsg((e as Error).message); } };
  const save = () => act(async () => {
    await api("/api/egress/connections", "POST", { id: connection?.id, connector, name, config, secrets, copyClientFrom: copyClientFrom || undefined });
    setSecrets({});
    setCopyClientFrom("");
    await onSaved();
    setMsg("Saved.");
  });
  const connect = () => act(async () => {
    const { url } = await api<{ url: string }>(connector === "youtube" ? `/api/youtube/connections/${connection!.id}/auth-url` : `/api/egress/connections/${connection!.id}/linkedin-auth-url`);
    window.open(url, "_blank");
  });
  const disconnect = () => act(async () => {
    await api(`/api/youtube/connections/${connection!.id}/disconnect`, "POST");
    await onSaved();
  });
  const remove = () => act(async () => {
    if (connection) await api(`/api/egress/connections/${connection.id}`, "DELETE");
    onRemove();
  });
  const steps = setup.steps();
  return (
    <SettingsItem>
      <div className="row">
        <strong className="grow">{CONNECTOR_LABEL[connector]}</strong>
        {connected ? <span className="small">Connected{accountName ? `: ${accountName}` : ""}{connection?.expiresAt ? <span className="muted"> · until {new Date(connection.expiresAt).toLocaleDateString()}</span> : null}</span> : connector === "youtube" || connector === "linkedin" ? <span className="muted small">Not connected</span> : null}
      </div>
      <p className="field-hint">{setup.summary}</p>
      {steps.length ? <ol className="connection-steps">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol> : null}
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /><span className="field-hint">Your name for this connection. You choose it when you publish a post.</span></label>
      {setup.config.map((f) => (
        f.kind === "git"
          ? <PathField key={f.key} kind="git" label={f.label} hint={f.hint} value={String(config[f.key] ?? "")} onChange={(v) => setConfig({ ...config, [f.key]: v })} />
          : <label key={f.key}>{f.label}<input value={String(config[f.key] ?? "")} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />{f.hint ? <span className="field-hint">{f.hint}</span> : null}</label>
      ))}
      {setup.secrets.map((f) => {
        const stored = !!connection?.secretsSet.includes(f.key);
        return <label key={f.key}>{f.label} {stored ? "(stored; type to replace)" : "(not set)"}<SecretInput stored={stored} value={secrets[f.key] ?? ""} onChange={(v) => setSecrets({ ...secrets, [f.key]: v })} />{f.hint ? <span className="field-hint">{f.hint}</span> : null}</label>;
      })}
      {connector === "youtube" && others.length ? <label>Copy the client from<select value={copyClientFrom} onChange={(e) => setCopyClientFrom(e.target.value)}><option value="">Choose a connection</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select><span className="field-hint">Several channels can share one OAuth client.</span></label> : null}
      {connector === "git-site" ? <label className="check"><input type="checkbox" checked={config.push === true} onChange={(e) => setConfig({ ...config, push: e.target.checked })} />Push the branch to origin</label> : null}
      <div className="row">
        <span className="small grow">{msg}</span>
        <Button variant="outline" size="sm" disabled={!name.trim() || !dirty} onClick={save}>Save connection</Button>
        {(connector === "linkedin" || connector === "youtube") && connection ? <Button variant="outline" size="sm" disabled={dirty} title={dirty ? "Save first" : undefined} onClick={connect}>{connected ? "Connect again" : "Connect"}</Button> : null}
        {connector === "youtube" && connected ? <Button variant="ghost" size="sm" onClick={disconnect}>Disconnect</Button> : null}
        <Button variant="ghost" size="sm" className="text-destructive" onClick={remove}>{connection ? "Delete" : "Discard"}</Button>
      </div>
    </SettingsItem>
  );
}

/** Named connections for publishing. Secrets stay on the server. */
export function EgressConnectionsSection() {
  const [items, setItems] = useState<PublicEgressConnection[]>([]);
  const [drafts, setDrafts] = useState<Array<{ key: string; connector: EgressConnectorId }>>([]);
  const [adding, setAdding] = useState<EgressConnectorId>("youtube");
  const load = useCallback(() => api<PublicEgressConnection[]>("/api/egress/connections").then(setItems), []);
  useEffect(() => { void load(); }, [load]);
  return (
    <SettingsSection
      title="Publishing connections"
      description="Where posts can go. A connection can serve several projects, and it saves on its own."
      action={
        <div className="row">
          <select aria-label="Platform" value={adding} onChange={(e) => setAdding(e.target.value as EgressConnectorId)}>{Object.entries(CONNECTOR_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
          <Button variant="outline" size="sm" onClick={() => setDrafts([...drafts, { key: crypto.randomUUID(), connector: adding }])}>Add connection</Button>
        </div>
      }
    >
      {!items.length && !drafts.length ? <p className="muted small">No connections yet. Choose a platform and select Add connection, and the steps appear here.</p> : null}
      {items.map((c) => <EgressConnectionCard key={c.id} connection={c} connector={c.connector} others={items.filter((o) => o.connector === c.connector && o.id !== c.id)} onSaved={load} onRemove={() => void load()} />)}
      {drafts.map((d) => {
        const drop = () => setDrafts((all) => all.filter((x) => x.key !== d.key));
        return <EgressConnectionCard key={d.key} connector={d.connector} others={items.filter((o) => o.connector === d.connector)} onSaved={async () => { await load(); drop(); }} onRemove={drop} />;
      })}
    </SettingsSection>
  );
}
