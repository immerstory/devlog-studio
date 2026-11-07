import { PostsPage } from "./PostsPage";
import { ActivityPage } from "./ActivityPage";
import { CaptureTargetsContext } from "./project-context";
import React, { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, setActiveProject, projectHref, type AppState } from "./api";
import { Calendar } from "./Calendar";
import { PostView } from "./PostView";
import { ProjectSettingsPage, GlobalSettingsPage } from "./ProjectSettings";
import { MaterialsPage } from "./Materials";
import { StatsPage } from "./Stats";
import type { Project } from "../shared/projects";
import { JobDock, JOB_FINISHED } from "./JobDock";
import { PathField } from "./PathField";
import { ArchetypePicker } from "./ArchetypeFields";
import { ARCHETYPES, type ProjectArchetype } from "../shared/archetypes";
import { DESCRIPTION_HINT, descriptionExample, PUBLIC_TITLE_HINT, WORKING_COPY_HINT } from "./project-fields";
import type { Job } from "./api";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const on = () => setHash(location.hash); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  return hash;
}
export function App() {
  const hash = useHash();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [error, setError] = useState("");
  /** Titles of posts seen so far, so the task dock can name the post a task works on. */
  const [postTitles, setPostTitles] = useState<Record<string, string>>({});
  const rememberPosts = useCallback((state: AppState) => setPostTitles((t) => ({ ...t, ...Object.fromEntries(state.posts.map((p) => [p.id, p.title])) })), []);
  const reloadProjects = useCallback(async () => { try { const all = await api<Project[]>("/api/projects"); setProjects(all); if (!all.length) setNewProject(true); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { reloadProjects(); }, [reloadProjects]);
  const match = /^#\/p\/([^/]+)(\/.*)?$/.exec(hash);
  let remembered: string | null = null; try { remembered = localStorage.getItem("devlog.project"); } catch {}
  const selected = projects?.find((p) => p.slug === match?.[1]) ?? (!match ? projects?.find((p) => p.id === remembered) ?? projects?.[0] : undefined);
  setActiveProject(selected);
  useEffect(() => {
    if (!projects?.length || hash === "#/settings") return;
    if (match && selected) { try { localStorage.setItem("devlog.project", selected.id); } catch {} return; }
    let remembered: string | null = null; try { remembered = localStorage.getItem("devlog.project"); } catch {}
    const p = projects.find((p) => p.id === remembered) ?? projects[0];
    const path = match ? "/calendar" : hash.slice(1).replace(/^\/episode\//, "/post/") || "/calendar";
    location.hash = `#/p/${p.slug}${path === "/" ? "/calendar" : path}`;
  }, [projects, selected?.id, hash]);
  return <div className="app">
    <header className="top">
      <a href={selected ? projectHref() : "#/"} className="brand">Devlog Studio</a>
      <select className="project-switcher" aria-label="Project" value={selected?.id ?? ""} onChange={(e) => { if (e.target.value === "new") setNewProject(true); else { const p = projects?.find((p) => p.id === e.target.value); if (p) location.hash = `#/p/${p.slug}/calendar`; } }}>
        <option value="" disabled>Choose project</option>{projects?.map((p) => <option key={p.id} value={p.id}>{p.settings.name}{p.deletion ? " — Deleting…" : ""}</option>)}<option value="new">New project…</option>
      </select>
      <nav>{selected && <><a href={projectHref()}>Calendar</a><a href={projectHref("/activity")}>Activity</a><a href={projectHref("/posts")}>Posts</a><a href={projectHref("/materials")}>Materials</a><a href={projectHref("/stats")}>Statistics</a><a href={projectHref("/settings")}>Project settings</a></>}</nav>
      <a className="top-settings" href="#/settings">Global settings</a>
      {selected && !selected.deletion && selected.settings.captureTargets.length > 0 && <CaptureIndicator project={selected} />}
    </header>
    {error && <div className="error">{error}</div>}
    {hash === "#/settings" ? <GlobalSettingsPage /> : selected ? <ProjectContent key={selected.id} project={selected} path={match?.[2] ?? "/calendar"} reloadProjects={reloadProjects} onState={rememberPosts} /> : <p className="muted pad">{projects?.length === 0 ? "Create a project to get started." : "Loading…"}</p>}
    <JobDock
      titleFor={(job: Job) => {
        const subject = job.subject?.split(":").pop();
        const post = subject ? postTitles[subject] : undefined;
        const project = projects?.find((p) => p.id === job.projectId);
        return post ?? (project && project.id !== selected?.id ? project.settings.name : undefined);
      }}
    />
    <NewProjectDialog open={newProject} onOpenChange={setNewProject} onCreated={async (p) => { await reloadProjects(); location.hash = `#/p/${p.slug}/calendar`; }} />
  </div>;
}
function ProjectContent({ project, path, reloadProjects, onState }: { project: Project; path: string; reloadProjects: () => Promise<void>; onState: (state: AppState) => void }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => { try { const next = await api<AppState>("/api/state"); setState(next); onState(next); } catch (e) { setError((e as Error).message); } }, [onState]);
  useEffect(() => { if (!project.deletion) reload(); }, [reload, project.deletion]);
  // A task of this project finished, possibly while another page was open: show its results.
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<Job>).detail.projectId === project.id) void reload(); };
    addEventListener(JOB_FINISHED, on);
    return () => removeEventListener(JOB_FINISHED, on);
  }, [reload, project.id]);
  if (project.deletion || path === "/settings") return <ProjectSettingsPage project={project} onSaved={async () => { await reloadProjects(); await reload(); }} />;
  const post = /^\/post\/(.+)$/.exec(path);
  return <>
    {error && <div className="error">{error}</div>}
    {!state ? <p className="muted pad">Loading…</p> : path === "/stats" ? <StatsPage /> : path === "/activity" ? <ActivityPage /> : path === "/posts" ? <PostsPage /> : path === "/materials" ? <MaterialsPage materials={state.materials} reload={reload} /> : post ? <CaptureTargetsContext.Provider value={{ targets: project.settings.captureTargets, defaultId: project.settings.defaultCaptureTargetId }}><PostView id={post[1]} materials={state.materials} suggestions={state.suggestions} onChange={reload} /></CaptureTargetsContext.Provider> : <Calendar state={state} reload={reload} />}
  </>;
}
function NewProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (p: Project) => Promise<void> }) {
  const blank = { name: "", publicTitle: "", description: "", sourcePath: "", archetype: undefined as ProjectArchetype | undefined };
  const [input, setInput] = useState(blank);
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<void>) => { setBusy(true); setMessage(""); try { await work(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="new-project sm:max-w-xl"><DialogTitle>New project</DialogTitle><DialogDescription>A project has its own calendar, materials and posts. You can change these fields later in the project settings, where you also set up capture targets, voice and theme.</DialogDescription>
    <label>Name<input value={input.name} placeholder="My Project" onChange={(e) => setInput({ ...input, name: e.target.value })} /><span className="field-hint">Shown in the project switcher and used in the project's URL.</span></label>
    <ArchetypePicker value={input.archetype} hint="Sets who the agent writes for and which shots it proposes. A game also starts with content globs for engine files. You can edit the prompt text later in the project settings." onChange={(archetype) => setInput({ ...input, archetype })} />
    <label>Public title (optional)<input value={input.publicTitle} placeholder={input.name} onChange={(e) => setInput({ ...input, publicTitle: e.target.value })} /><span className="field-hint">{PUBLIC_TITLE_HINT} If empty, the name is used.</span></label>
    <label>Description for prompts (optional)<textarea rows={2} value={input.description} placeholder={input.archetype ? ARCHETYPES[input.archetype].descriptionPlaceholder : "a short phrase that says what this project is"} onChange={(e) => setInput({ ...input, description: e.target.value })} /><span className="field-hint">{DESCRIPTION_HINT} If empty, the name is used.<br />{descriptionExample(input.description.trim() || input.name.trim())}</span></label>
    <PathField kind="git" label="Git working copy" hint={<>{WORKING_COPY_HINT} You can add more working copies later in the project settings.</>} value={input.sourcePath} onChange={(sourcePath) => setInput((i) => ({ ...i, sourcePath }))} />
    <div className="row"><Button disabled={busy || !input.name || !input.archetype || !input.sourcePath} onClick={() => act(async () => { const p = await api<Project>("/api/projects", "POST", input); await onCreated(p); onOpenChange(false); setInput(blank); })}>Create project</Button></div>{message ? <div className="error small">{message}</div> : null}
  </DialogContent></Dialog>;
}

function CaptureIndicator({ project }: { project: Project }) {
  const [status, setStatus] = useState<{ ok: boolean; detail?: string } | null>(null);
  const check = useCallback(() => { setStatus(null); api<{ ok: boolean; detail: string }>(`/api/projects/${project.id}/capture/${project.settings.defaultCaptureTargetId}/status`).then(setStatus, (e) => setStatus({ ok: false, detail: e.message })); }, [project.id, project.settings.defaultCaptureTargetId]);
  useEffect(check, [check]);
  const kind = project.settings.captureTargets.find((t) => t.id === project.settings.defaultCaptureTargetId)?.kind;
  const browser = kind === "browser";
  return <Button variant="outline" size="sm" className={`pill ${status?.ok ? "ok" : status ? "bad" : ""}`} onClick={check} title={status?.detail}>{browser ? "Browser" : kind === "blender-mcp" ? "Blender" : "Unity"} {status ? status.ok ? (browser ? "ready" : "connected") : "offline" : "…"}</Button>;
}
