import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ListInput } from "@/components/list-input";
import { SettingsItem, SettingsPage, SettingsSection } from "@/components/settings-section";
import { SecretInput } from "@/components/secret-input";
import { SegTabs } from "@/components/seg-tabs";
import { useProjectRuntimeSettings } from "./Settings";
import { api, type AppState, type Job } from "./api";
import { DEFAULT_PAGE_HEADERS, type BrowserTargetConfig, type CaptureTarget, type GlobalSettings, type Project, type PublicConnection, type UnityTargetConfig } from "../shared/projects";
import { PathField } from "./PathField";
import { IntakeScheduleSection } from "./IntakeSchedule";
import { ArchetypePicker, PromptGuidanceField } from "./ArchetypeFields";
import { CoHostSection } from "./CoHostFields";
import { ActivitySourcesSection, EgressConnectionsSection } from "./PublishViews";
import { BASE_URL_HINT, CONTENT_GLOBS_HINT, FEED_GLOBS_HINT, DEFAULT_TARGET_HINT, DESCRIPTION_HINT, descriptionExample, HEADER_ARGS_HINT, HEADER_HELPER_HINT, MCP_URL_HINT, NAME_HINT, PRIMARY_SOURCE_HINT, PUBLIC_TITLE_HINT, REQUEST_HEADERS_HINT, SLUG_HINT, SOURCE_LABEL_HINT, TARGET_CSS_HINT, TARGET_NAME_HINT, UNITY_PROJECT_HINT, USER_AGENT_HINT, WORKING_COPY_HINT } from "./project-fields";

const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
function Text({ label, hint, value, onChange, type = "text" }: { label: string; hint?: React.ReactNode; value?: string | number; onChange: (v: string) => void; type?: string }) {
  return <label className="grow">{label}<input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />{hint ? <span className="field-hint">{hint}</span> : null}</label>;
}

const SETTINGS_TABS = [
  { value: "general", label: "General" },
  { value: "sources", label: "Sources and activity" },
  { value: "capture", label: "Capture targets" },
  { value: "output", label: "Output" },
  { value: "publishing", label: "Publishing" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

export function ProjectSettingsPage({ project, onSaved }: { project: Project; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(project);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [sourceUses, setSourceUses] = useState<Record<string, number>>({});
  const edit = (fn: (p: Project) => void) => setDraft((p) => { const next = structuredClone(p); fn(next); return next; });
  const editUnity = (i: number, fn: (c: UnityTargetConfig) => void) => edit((p) => { const t = p.settings.captureTargets[i]; if (t.kind === "unity-mcp") fn(t.config); });
  const editBrowser = (i: number, fn: (c: BrowserTargetConfig) => void) => edit((p) => { const t = p.settings.captureTargets[i]; if (t.kind === "browser") fn(t.config); });
  const act = async (fn: () => Promise<void>) => { setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } };
  useEffect(() => { setDraft(project); }, [project]);
  useEffect(() => { api<PublicConnection[]>("/api/youtube/connections").then(setConnections); }, []);
  useEffect(() => { if (!project.deletion) api<Record<string, number>>(`/api/projects/${project.id}/sources/usage`).then(setSourceUses, () => setSourceUses({})); }, [project]);
  const s = draft.settings;
  const savedSource = (sourceId: string) => project.settings.sources.some((x) => x.id === sourceId);
  const usesOf = (sourceId: string) => sourceUses[sourceId] ?? 0;
  const runtime = useProjectRuntimeSettings({ publishingExtra: (
    <label>Default YouTube connection
            <select value={s.publishing.connectionId ?? ""} onChange={(e) => edit((p) => { p.settings.publishing.connectionId = e.target.value || undefined; })}>
              <option value="">None</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.channelTitle ?? "Not connected"}</option>)}
            </select>
          </label>
  ) });

  if (project.deletion) {
    return (
      <SettingsPage title="Project settings">
        <SettingsSection title={`Deleting ${s.name}…`} description="The deletion stopped before it finished. Retrying resumes where it stopped.">
          <div className="row">
            <Button onClick={() => act(async () => { await api(`/api/projects/${project.id}?files=${project.deletion!.files}`, "DELETE"); await onSaved(); })}>Retry deletion</Button>
          </div>
          {msg && <p className="small">{msg}</p>}
        </SettingsSection>
      </SettingsPage>
    );
  }

  const save = () => act(async () => {
    setSaving(true);
    try {
      const saved = await api<Project>(`/api/projects/${project.id}/settings`, "PUT", { settings: s, slug: draft.slug });
      await runtime.save();
      await onSaved();
      location.hash = `#/p/${saved.slug}/settings`;
      setMsg("Saved.");
    } finally {
      setSaving(false);
    }
  });

  return (
    <SettingsPage
      title="Project settings"
      description={`Settings for ${s.name}. Agent, ElevenLabs key, render and YouTube connections are global settings.`}
      footer={<><Button disabled={saving} onClick={save}>Save project settings</Button>{msg && <span className="small">{msg}</span>}</>}
    >
      <SegTabs variant="line" value={tab} onChange={setTab} items={[...SETTINGS_TABS]} />
      <div className="settings-tab" hidden={tab !== "general"}>
      <SettingsSection title="General" description="Name and URL of the project, and how prompts describe it.">
        <div className="row align-top">
          <Text label="Name" hint={NAME_HINT} value={s.name} onChange={(v) => edit((p) => { p.settings.name = v; })} />
          <Text label="URL slug" hint={SLUG_HINT} value={draft.slug} onChange={(v) => edit((p) => { p.slug = v; })} />
        </div>
        <label>Public title<input value={s.publicTitle} onChange={(e) => edit((p) => { p.settings.publicTitle = e.target.value; })} /><span className="field-hint">{PUBLIC_TITLE_HINT}</span></label>
        <label>Description for prompts<textarea value={s.description} onChange={(e) => edit((p) => { p.settings.description = e.target.value; })} /><span className="field-hint">{DESCRIPTION_HINT}<br />{descriptionExample(s.description.trim())}</span></label>
        <ArchetypePicker value={s.archetype} hint="Sets the default for the guidance below. Text you customized stays, and content globs do not change." onChange={(archetype) => edit((p) => { p.settings.archetype = archetype; })} />
        <PromptGuidanceField settings={s} onChange={(guidance) => edit((p) => { if (guidance === undefined) delete p.settings.promptGuidance; else p.settings.promptGuidance = guidance; })} />
      </SettingsSection>

      {runtime.sections?.theme}
      <SettingsSection
        title="Delete project"
        description="Deletes the project's suggestions, notes, materials and posts. Videos on YouTube stay."
        className="settings-danger ring-destructive/30"
        action={<Button variant="destructive" size="sm" onClick={() => setDeleting(true)}>Delete project…</Button>}
      />
      <DeleteProjectDialog project={project} open={deleting} onOpenChange={setDeleting} onDeleted={onSaved} />
      </div>
      <div className="settings-tab" hidden={tab !== "sources"}>
      <SettingsSection
        title="Sources"
        description="Git working copies whose commits and changes feed discovery and backfill. The agent works in the primary source."
        action={<Button variant="outline" size="sm" onClick={() => edit((p) => { p.settings.sources.push({ id: id("source"), label: "Source", path: "", contentGlobs: [] }); })}>Add source</Button>}
      >
        {s.sources.map((source, i) => (
          <SettingsItem key={source.id}>
            <div className="row align-top">
              <Text label="Label" hint={SOURCE_LABEL_HINT} value={source.label} onChange={(v) => edit((p) => { p.settings.sources[i].label = v; })} />
              <PathField kind="git" label="Git working copy" hint={WORKING_COPY_HINT} value={source.path} onChange={(v) => edit((p) => { p.settings.sources[i].path = v; })} />
            </div>
            <label>Content globs<ListInput value={source.contentGlobs} onChange={(v) => edit((p) => { p.settings.sources[i].contentGlobs = v; })} /><span className="field-hint">{CONTENT_GLOBS_HINT}</span></label>
            <label>Feed files<ListInput value={source.feedGlobs ?? []} onChange={(v) => edit((p) => { if (v.length) p.settings.sources[i].feedGlobs = v; else delete p.settings.sources[i].feedGlobs; })} /><span className="field-hint">{FEED_GLOBS_HINT}</span></label>
            <div className="row">
              <label className="check"><input type="radio" name="primary-source" disabled={source.archived} checked={s.primarySourceId === source.id} onChange={() => edit((p) => { p.settings.primarySourceId = source.id; })} />Primary source</label>
              {source.archived ? <span className="muted small">Archived</span> : null}
              <span className="grow" />
              {savedSource(source.id) ? <Button variant="ghost" size="sm" disabled={!source.archived && s.primarySourceId === source.id} onClick={() => edit((p) => { p.settings.sources[i].archived = !source.archived; })}>{source.archived ? "Restore" : "Archive"}</Button> : null}
              {usesOf(source.id) ? null : <Button variant="ghost" size="sm" className="text-destructive" disabled={s.primarySourceId === source.id} title={s.primarySourceId === source.id ? "Choose another primary source first" : "Removes this source when you save. Its commits and sessions leave the Activity page."} onClick={() => edit((p) => { p.settings.sources.splice(i, 1); })}>Delete</Button>}
            </div>
            <p className="field-hint">{PRIMARY_SOURCE_HINT}{usesOf(source.id) ? ` ${usesOf(source.id)} suggestion${usesOf(source.id) === 1 ? " uses" : "s use"} this source, so it can be archived and not deleted.` : ""}</p>
          </SettingsItem>
        ))}
      </SettingsSection>

      <ActivitySourcesSection settings={s} active={tab === "sources"} onChange={(sources) => edit((p) => { p.settings.activitySources = sources; })} />

      <IntakeScheduleSection value={s.intake} saved={project.settings.intake} hasFeeds={s.sources.some((x) => !x.archived && !!x.feedGlobs?.length)} onChange={(intake) => edit((p) => { p.settings.intake = intake; })} />

      {runtime.sections?.discovery}
      </div>
      <div className="settings-tab" hidden={tab !== "capture"}>
      <SettingsSection
        title="Capture targets"
        description="Where shots are filmed: a Unity editor through Unity-MCP, or a browser for webpages. Shots without their own target use the default."
        action={
          <div className="row">
            <Button variant="outline" size="sm" onClick={() => edit((p) => { const target: CaptureTarget = { id: id("target"), label: "Unity editor", kind: "unity-mcp", config: { url: "http://localhost:8080/mcp", headerHelper: "", headerHelperArgs: [], projectPath: "" } }; p.settings.captureTargets.push(target); p.settings.defaultCaptureTargetId ??= target.id; })}>Add Unity target</Button>
            <Button variant="outline" size="sm" onClick={() => edit((p) => { const target: CaptureTarget = { id: id("target"), label: "Website", kind: "browser", config: { baseUrl: "" } }; p.settings.captureTargets.push(target); p.settings.defaultCaptureTargetId ??= target.id; })}>Add browser target</Button>
          </div>
        }
      >
        {!s.captureTargets.length ? <p className="muted small">No capture targets. Shots can still use materials and slides.</p> : null}
        {s.captureTargets.map((target, i) => (
          <SettingsItem key={target.id}>
            {target.kind === "unity-mcp" ? (
              <>
                <p className="muted small">
                  Films in the open Unity editor through <a href="https://github.com/IvanMurzak/Unity-MCP" target="_blank" rel="noreferrer">Unity-MCP</a>. Devlog Studio sends its capture code to that server's <code>script-execute</code> tool, so other MCP servers work only if they offer a compatible tool. The code uses the Universal Render Pipeline with render graph, so the project needs URP on Unity 6.
                </p>
                <div className="row align-top">
                  <Text label="Name" hint={TARGET_NAME_HINT} value={target.label} onChange={(v) => edit((p) => { p.settings.captureTargets[i].label = v; })} />
                  <Text label="MCP URL" hint={MCP_URL_HINT} value={target.config.url} onChange={(v) => editUnity(i, (c) => { c.url = v; })} />
                </div>
                <PathField kind="unity" label="Expected Unity project" hint={UNITY_PROJECT_HINT} value={target.config.projectPath} start={s.sources.find((x) => x.id === s.primarySourceId)?.path} onChange={(v) => editUnity(i, (c) => { c.projectPath = v; })} />
                <PathField kind="executable" label="Header helper" hint={HEADER_HELPER_HINT} value={target.config.headerHelper} onChange={(v) => editUnity(i, (c) => { c.headerHelper = v; })} />
                <label>Header helper arguments<ListInput value={target.config.headerHelperArgs} onChange={(v) => editUnity(i, (c) => { c.headerHelperArgs = v; })} /><span className="field-hint">{HEADER_ARGS_HINT}</span></label>
              </>
            ) : (
              <>
                <div className="row align-top">
                  <Text label="Name" hint={TARGET_NAME_HINT} value={target.label} onChange={(v) => edit((p) => { p.settings.captureTargets[i].label = v; })} />
                  <Text label="Base URL" hint={BASE_URL_HINT} value={target.config.baseUrl} onChange={(v) => editBrowser(i, (c) => { c.baseUrl = v; })} />
                </div>
                <Text label="User agent" hint={USER_AGENT_HINT} value={target.config.userAgent} onChange={(v) => editBrowser(i, (c) => { c.userAgent = v || undefined; })} />
                <label>
                  CSS for every page
                  <textarea className="code" rows={3} spellCheck={false} value={target.config.css ?? ""} onChange={(e) => editBrowser(i, (c) => { c.css = e.target.value || undefined; })} />
                  <span className="field-hint">{TARGET_CSS_HINT}</span>
                </label>
                <label>
                  Request headers
                  <ListInput lines rows={3} value={target.config.headers ?? DEFAULT_PAGE_HEADERS} onChange={(v) => editBrowser(i, (c) => { c.headers = v; })} />
                  <span className="field-hint">{REQUEST_HEADERS_HINT}</span>
                </label>
                <p className="muted small">Webpage shots are filmed in headless Chrome, frame by frame, with the page's own animations playing. Sites with a bot check show a challenge page instead of their content; the shot then fails with that reason.</p>
              </>
            )}
            <div className="row">
              <label className="check"><input type="radio" name="default-target" checked={s.defaultCaptureTargetId === target.id} onChange={() => edit((p) => { p.settings.defaultCaptureTargetId = target.id; })} />Default capture target</label>
              <span className="grow" />
              <Button variant="outline" size="sm" onClick={() => act(async () => { const result = await api<{ ok: boolean; detail?: string; error?: string }>(`/api/projects/${project.id}/capture/${target.id}/status`); setMsg(result.detail ?? result.error ?? (result.ok ? "Connected" : "Offline")); })}>Check</Button>
              <Button variant="ghost" size="sm" onClick={() => edit((p) => { p.settings.captureTargets.splice(i, 1); if (p.settings.defaultCaptureTargetId === target.id) p.settings.defaultCaptureTargetId = p.settings.captureTargets[0]?.id; })}>Remove</Button>
            </div>
            <p className="field-hint">{DEFAULT_TARGET_HINT} <strong>Check</strong> tests the connection and the project.</p>
          </SettingsItem>
        ))}
      </SettingsSection>
      </div>
      <div className="settings-tab" hidden={tab !== "output"}>
      <SettingsSection title="Outputs" description="What new posts offer, and the template exported articles use.">
        <div className="row">
          {(["portrait", "landscape"] as const).map((output) => (
            <label className="check" key={output}>
              <input type="checkbox" checked={s.outputs.enabled.includes(output)} onChange={(e) => edit((p) => { p.settings.outputs.enabled = e.target.checked ? [...new Set([...p.settings.outputs.enabled, output])] : p.settings.outputs.enabled.filter((v) => v !== output); })} />
              {output === "portrait" ? "Portrait video" : "Landscape video"}
            </label>
          ))}
        </div>
        <label>Article template<textarea rows={12} value={s.outputs.articleTemplate} onChange={(e) => edit((p) => { p.settings.outputs.articleTemplate = e.target.value; })} /></label>
      </SettingsSection>

      {runtime.sections?.narration}
      <CoHostSection settings={s} onChange={(coHost) => edit((p) => { p.settings.coHost = coHost; })} />
      </div>
      <div className="settings-tab" hidden={tab !== "publishing"}>
      {runtime.sections?.publishing}
      </div>
    </SettingsPage>
  );
}

function DeleteProjectDialog({ project, open, onOpenChange, onDeleted }: { project: Project; open: boolean; onOpenChange: (v: boolean) => void; onDeleted: () => Promise<void> }) {
  const [name, setName] = useState(""); const [files, setFiles] = useState(false); const [state, setState] = useState<AppState | null>(null); const [jobs, setJobs] = useState<Job[]>([]); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) return; setName(""); setFiles(false); setError(""); api<AppState>(`/api/projects/${project.id}/state`).then(setState); const refresh = () => api<Array<Job & { projectId?: string }>>("/api/jobs").then((all) => setJobs(all.filter((j) => j.projectId === project.id && j.status === "running"))); refresh(); const timer = setInterval(refresh, 1000); return () => clearInterval(timer); }, [open, project.id]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogTitle>Delete {project.settings.name}?</DialogTitle><DialogDescription>This permanently deletes this project's records.</DialogDescription><p>{state ? `${state.suggestions.length} suggestions, ${state.notes.length} notes, ${state.materials.length} materials and ${state.posts.length} posts.` : "Loading contents…"}</p><p>Videos on YouTube are never deleted.</p><label className="check"><input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} />Also delete stored files</label><Text label={`Type ${project.settings.name} to confirm`} value={name} onChange={setName} />{jobs.length > 0 && <p>Wait for running jobs: {jobs.map((j) => j.kind).join(", ")}</p>}<Button variant="destructive" disabled={busy || !state || name !== project.settings.name || jobs.length > 0} onClick={async () => { setBusy(true); try { await api(`/api/projects/${project.id}?files=${files}`, "DELETE"); onOpenChange(false); await onDeleted(); location.hash = "#/"; } catch (e) { setError((e as Error).message); await onDeleted(); } finally { setBusy(false); } }}>Delete</Button>{error && <p className="error">{error}</p>}</DialogContent></Dialog>;
}

type PublicGlobal = Omit<GlobalSettings, "elevenlabs"> & { elevenlabs: { apiKeySet: boolean; apiKeyFromEnv: boolean } };
const GLOBAL_TABS = [
  { value: "general", label: "General" },
  { value: "ai", label: "Agent and voice" },
  { value: "publishing", label: "Publishing" },
] as const;
type GlobalTab = (typeof GLOBAL_TABS)[number]["value"];

export function GlobalSettingsPage() {
  const [tab, setTab] = useState<GlobalTab>("general");
  const [cfg, setCfg] = useState<PublicGlobal | null>(null); const [key, setKey] = useState(""); const [msg, setMsg] = useState("");
  useEffect(() => { api<PublicGlobal>("/api/settings").then(setCfg, (e) => setMsg(e.message)); }, []);
  const edit = (fn: (c: PublicGlobal) => void) => setCfg((c) => { if (!c) return c; const n = structuredClone(c); fn(n); return n; });
  const save = async (clearApiKey = false) => { if (!cfg) return; try { setCfg(await api<PublicGlobal>("/api/settings", "PUT", { ...cfg, elevenlabs: { apiKey: key, clearApiKey } })); setKey(""); setMsg("Saved."); } catch (e) { setMsg((e as Error).message); } };
  if (!cfg) return <p className="pad">{msg || "Loading…"}</p>;
  return (
    <SettingsPage
      title="Global settings"
      description="Settings shared by every project."
      footer={<><Button onClick={() => save()}>Save global settings</Button>{msg && <span className="small">{msg}</span>}<span className="muted small">Publishing connections save on their own.</span></>}
    >
      <SegTabs variant="line" value={tab} onChange={setTab} items={[...GLOBAL_TABS]} />
      <div className="settings-tab" hidden={tab !== "general"}>
      <SettingsSection title="Server">
        <div className="row"><Text label="Port (restart required)" type="number" value={cfg.port} onChange={(v) => edit((c) => { c.port = Number(v); })} /></div>
      </SettingsSection>

      <SettingsSection title="Render" description="Frame rate of every video, and the scale of draft renders.">
        <div className="row">
          <Text label="Frames per second" type="number" value={cfg.render.fps} onChange={(v) => edit((c) => { c.render.fps = Number(v); })} />
          <Text label="Draft scale" type="number" value={cfg.render.draftScale} onChange={(v) => edit((c) => { c.render.draftScale = Number(v); })} />
        </div>
      </SettingsSection>
      </div>
      <div className="settings-tab" hidden={tab !== "ai"}>
      <SettingsSection title="Agent" description="The CLI that writes suggestions and scripts. It runs read-only in the project's sources.">
        <label>Default CLI<select value={cfg.agent.default} onChange={(e) => edit((c) => { c.agent.default = e.target.value as "claude" | "codex"; })}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
        {(["claude", "codex"] as const).map((agent) => (
          <div className="row" key={agent}>
            <Text label={`${agent} executable`} value={cfg.agent[agent].executable} onChange={(v) => edit((c) => { c.agent[agent].executable = v; })} />
            <Text label={`${agent} model (empty uses CLI default)`} value={cfg.agent[agent].model} onChange={(v) => edit((c) => { c.agent[agent].model = v || undefined; })} />
          </div>
        ))}
        <label>Codex launcher arguments<ListInput value={cfg.agent.codex.args} onChange={(v) => edit((c) => { c.agent.codex.args = v; })} /></label>
        <div className="row"><Text label="Timeout (minutes)" type="number" value={cfg.agent.timeoutMinutes} onChange={(v) => edit((c) => { c.agent.timeoutMinutes = Number(v); })} /></div>
        <label className="check"><input type="checkbox" checked={cfg.agent.scriptReview} onChange={(e) => edit((c) => { c.agent.scriptReview = e.target.checked; })} />Read-through pass after writing scripts</label>
      </SettingsSection>

      <SettingsSection title="ElevenLabs" description="The API key for narration. Each project chooses its own voice.">
        <div className="row align-end">
          <label className="grow">API key {cfg.elevenlabs.apiKeyFromEnv ? "(environment override)" : cfg.elevenlabs.apiKeySet ? "(stored; type to replace)" : "(not set)"}<SecretInput stored={cfg.elevenlabs.apiKeySet} value={key} onChange={setKey} /></label>
          {cfg.elevenlabs.apiKeySet && <Button variant="outline" onClick={() => save(true)}>Remove stored key</Button>}
        </div>
      </SettingsSection>
      </div>
      <div className="settings-tab" hidden={tab !== "publishing"}>
      <EgressConnectionsSection />

      <SettingsSection title="Statistics" description="How often YouTube views, likes and comments are fetched.">
        <div className="row"><Text label="Refresh interval (hours)" type="number" value={cfg.statsIntervalHours} onChange={(v) => edit((c) => { c.statsIntervalHours = Number(v); })} /></div>
      </SettingsSection>
      </div>
    </SettingsPage>
  );
}

