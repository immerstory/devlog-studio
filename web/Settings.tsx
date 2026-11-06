import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings-section";
import { api, apiUrl } from "./api";
import { ThemeEditor, ThemeSwatches, type ThemeSettings } from "./ThemeEditor";
import { BumperMusic, bumperSummary } from "./BumperMusic";
import type { Material, ThemeColors } from "../shared/types";


interface Cfg {
  gameTitle: string;
  agent: { default: "claude" | "codex"; claude: { executable: string; model?: string }; codex: { executable: string; args: string[]; model?: string }; timeoutMinutes: number; scriptReview: boolean };
  publishing: { attribution: string };
  youtube: {
    clientId: string;
    clientSecretSet: boolean;
    connected: boolean;
    channelTitle?: string;
    publishTime: string;
    privacyWithoutDate: "public" | "unlisted" | "private";
    categoryId: string;
    madeForKids: boolean;
    containsSyntheticMedia: boolean;
    uploadCaptions: boolean;
  };
  elevenlabs: { voiceId: string; modelId: string; stability: number; similarityBoost: number; style: number; speed: number; apiKeySet: boolean; apiKeyFromEnv: boolean };
  theme: ThemeSettings;
  discovery: { initialDays: number; contentGlobs: string[] };
}

/**
 * Discovery, narration, publishing and theme sections of the project settings page. They share one state and one
 * save, and the page decides where each one goes. `publishingExtra` renders at the top of Publishing.
 */
export function useProjectRuntimeSettings({ publishingExtra }: { publishingExtra?: React.ReactNode }) {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; name: string; category: string }>>([]);
  const [audioMsg, setAudioMsg] = useState("");
  const [voiceCheck, setVoiceCheck] = useState("");
  const [images, setImages] = useState<Material[]>([]);
  const [editingTheme, setEditingTheme] = useState(false);
  const loadImages = () => api<Material[]>("/api/materials").then((all) => setImages(all.filter((m) => m.kind === "image")), () => setImages([]));
  useEffect(() => {
    loadImages();
  }, []);
  const [voicesError, setVoicesError] = useState("");
  const loadVoices = () => api<typeof voices>("/api/voices").then((v) => { setVoices(v); setVoicesError(""); }, (e) => { setVoices([]); setVoicesError((e as Error).message); });
  useEffect(() => {
    api<Cfg>("/api/project-config").then(setCfg);
    loadVoices();
  }, []);
  const save = async () => {
    if (!cfg) return;
    setCfg(await api<Cfg>("/api/project-config", "PUT", cfg));
    loadVoices();
  };
  const checkVoice = async (id: string) => {
    setVoiceCheck("Checking…");
    try {
      const v = await api<{ name: string; category: string }>(`/api/voices/${encodeURIComponent(id)}`);
      setVoiceCheck(`✓ ${v.name} (${v.category})`);
    } catch (e) {
      setVoiceCheck(`✗ ${(e as Error).message}`);
    }
  };
  if (!cfg) return { save, sections: null };
  const set = (fn: (c: Cfg) => void) => {
    const n = structuredClone(cfg);
    fn(n);
    setCfg(n);
  };
  const el = cfg.elevenlabs;
  const num = (v: string) => Number(v);
  const discovery = (
      <SettingsSection title="Discovery" description="How far the first progress check looks back when no earlier check exists.">
        <div className="row">
          <label>First check looks back (days)<input type="number" value={cfg.discovery.initialDays} onChange={(e) => set((c) => (c.discovery.initialDays = num(e.target.value)))} /></label>
        </div>
      </SettingsSection>
  );
  const narration = (
      <SettingsSection title="Narration" description="The ElevenLabs voice and voice settings for this project. The API key is a global setting.">
        <div className="row align-end">
          <label className="grow">
            Voice ID
            <input value={el.voiceId} placeholder="e.g. a Voice Library or cloned voice ID" onChange={(e) => { set((c) => (c.elevenlabs.voiceId = e.target.value.trim())); setVoiceCheck(""); }} />
          </label>
          <Button variant="outline" disabled={!el.voiceId || !(el.apiKeySet || el.apiKeyFromEnv)} onClick={() => checkVoice(el.voiceId)}>Check voice</Button>
          <span className="small">{voiceCheck}</span>
        </div>
        <div className="row">
          <label className="grow">Or pick from your account's voices
            <select value={voices.some((v) => v.id === el.voiceId) ? el.voiceId : ""} onChange={(e) => { set((c) => (c.elevenlabs.voiceId = e.target.value)); setVoiceCheck(""); }}>
              <option value="">{voices.length ? "— choose —" : el.apiKeySet || el.apiKeyFromEnv ? "(voices unavailable)" : "(set the API key to list voices)"}</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.category})</option>)}
            </select>
            {voicesError && (el.apiKeySet || el.apiKeyFromEnv) ? <span className="small">{/missing the permission (\w+)/.exec(voicesError) ? `The API key lacks the ${/missing the permission (\w+)/.exec(voicesError)![1]} permission. Enter the voice ID directly, or grant it in ElevenLabs.` : voicesError}</span> : null}
          </label>
          <label>Model<input value={el.modelId} onChange={(e) => set((c) => (c.elevenlabs.modelId = e.target.value))} /></label>
        </div>
        <div className="row">
          <label>Stability<input type="number" step="0.05" min="0" max="1" value={el.stability} onChange={(e) => set((c) => (c.elevenlabs.stability = num(e.target.value)))} /></label>
          <label>Similarity<input type="number" step="0.05" min="0" max="1" value={el.similarityBoost} onChange={(e) => set((c) => (c.elevenlabs.similarityBoost = num(e.target.value)))} /></label>
          <label>Style<input type="number" step="0.05" min="0" max="1" value={el.style} onChange={(e) => set((c) => (c.elevenlabs.style = num(e.target.value)))} /></label>
          <label>Speed<input type="number" step="0.05" min="0.7" max="1.2" value={el.speed} onChange={(e) => set((c) => (c.elevenlabs.speed = num(e.target.value)))} /></label>
        </div>
      </SettingsSection>
  );
  const publishing = (
      <SettingsSection title="Publishing" description="YouTube defaults and the text every description ends with.">
        {publishingExtra}
        <label>
          Attribution: appended to every video description (music licence ID, credits, links)
          <textarea rows={4} placeholder={"Music: “Track title” by Artist, licence ID …\nVoice: ElevenLabs\nMade with Unity"} value={cfg.publishing?.attribution ?? ""} onChange={(e) => set((c) => (c.publishing = { ...c.publishing, attribution: e.target.value }))} />
        </label>
        <div className="row">
          <label>Default publish time<input type="time" value={cfg.youtube.publishTime} onChange={(e) => set((c) => (c.youtube.publishTime = e.target.value))} /></label>
          <label>Without a publish date
            <select value={cfg.youtube.privacyWithoutDate} onChange={(e) => set((c) => (c.youtube.privacyWithoutDate = e.target.value as Cfg["youtube"]["privacyWithoutDate"]))}>
              <option value="public">publish publicly on approval</option>
              <option value="unlisted">upload unlisted</option>
              <option value="private">upload private</option>
            </select>
          </label>
          <label>Category ID<input value={cfg.youtube.categoryId} title="20 = Gaming" onChange={(e) => set((c) => (c.youtube.categoryId = e.target.value.trim()))} /></label>
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={cfg.youtube.uploadCaptions} onChange={(e) => set((c) => (c.youtube.uploadCaptions = e.target.checked))} /> Upload the subtitles as a caption track</label>
          <label className="check"><input type="checkbox" checked={cfg.youtube.madeForKids} onChange={(e) => set((c) => (c.youtube.madeForKids = e.target.checked))} /> Made for kids</label>
          <label className="check"><input type="checkbox" checked={cfg.youtube.containsSyntheticMedia} onChange={(e) => set((c) => (c.youtube.containsSyntheticMedia = e.target.checked))} /> Contains realistic altered or synthetic content</label>
        </div>
      </SettingsSection>
  );
  const theme = (
      <SettingsSection
        title="Theme"
        description="Colours, fonts, slide backgrounds, intro and outro, edited beside a live preview."
        action={<Button variant="outline" size="sm" onClick={() => setEditingTheme(true)}>Edit theme…</Button>}
      >
        <ThemeSwatches colors={cfg.theme.colors} />
        <dl className="theme-summary">
          <dt>Slide font</dt><dd>{cfg.theme.displayFont?.name ?? "Default handwriting font"}</dd>
          <dt>Logo</dt><dd>{cfg.theme.logo?.name ?? "None"}</dd>
          <dt>Backgrounds</dt><dd>{cfg.theme.backgroundMaterialIds.length ? `${cfg.theme.backgroundMaterialIds.length} image(s)` : "The video's own captures"}</dd>
          <dt>Intro</dt><dd>{bumperSummary(cfg.theme.intro)}</dd>
          <dt>Outro</dt><dd>{bumperSummary(cfg.theme.outro)}</dd>
        </dl>
        <ThemeEditor
          open={editingTheme}
          onOpenChange={setEditingTheme}
          theme={cfg.theme}
          images={images}
          reloadImages={loadImages}
          onSaved={(theme) => setCfg({ ...cfg, theme })}
        />
        {(["intro", "outro"] as const).map((placement) => (
          <BumperMusic key={placement} placement={placement} choice={cfg.theme[placement]} onChanged={async (msg) => { setAudioMsg(msg); setCfg(await api<Cfg>("/api/project-config")); }} />
        ))}
        {audioMsg ? <p className="small">{audioMsg}</p> : null}
      </SettingsSection>
  );
  return { save, sections: { discovery, narration, publishing, theme } };
}
