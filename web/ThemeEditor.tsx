import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SegTabs } from "@/components/seg-tabs";
import { VideoPlayer } from "./VideoPlayer";
import { api, apiUrl } from "./api";
import { MaterialAttach } from "./Materials";
import { THEME_COLOR_LABELS, themeColors, type Format, type Material, type ThemeColors, type TimelineProps } from "../shared/types";
import { installedExtensions } from "../video/extensions";
import { BUMPER_STYLES, bumperStyle, newBumperChoice, type BumperChoice, type BumperParam, type BumperPlacement, type ThemeAsset } from "../shared/bumpers";

export interface ThemeSettings {
  colors?: Partial<ThemeColors>;
  logo?: ThemeAsset;
  displayFont?: ThemeAsset;
  backgroundMaterialIds: string[];
  intro?: BumperChoice;
  outro?: BumperChoice;
  subtitlesOnTitleSlides?: boolean;
}

/** Swatches of a theme's colours, for the summary on the settings page. */
export function ThemeSwatches({ colors }: { colors?: Partial<ThemeColors> }) {
  const c = themeColors(colors);
  return (
    <div className="theme-swatches">
      {(Object.keys(THEME_COLOR_LABELS) as Array<keyof ThemeColors>).map((key) => (
        <span key={key} className="theme-swatch" style={{ background: c[key] }} title={`${THEME_COLOR_LABELS[key]}: ${c[key]}`} />
      ))}
    </div>
  );
}

/** Uploads a font or image for the theme. Nothing is stored in the theme until it is saved. */
function AssetField({ label, kind, value, onChange, emptyText }: { label: string; kind: "font" | "image"; value?: ThemeAsset; onChange: (asset?: ThemeAsset) => void; emptyText: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (file: File) => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetch(apiUrl(`/api/theme/files?kind=${kind}`), { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onChange(data as ThemeAsset);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="asset-field">
      <span className="label">{label}</span>
      <div className="row">
        <span className={value ? "asset-name" : "asset-name muted"}>{busy ? "Uploading…" : value?.name ?? emptyText}</span>
        <span className="grow" />
        <Button variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>{value ? "Replace…" : "Upload…"}</Button>
        {value ? <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>Remove</Button> : null}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={kind === "font" ? ".ttf,.otf,.woff,.woff2" : ".png,.jpg,.jpeg,.webp,.svg"}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
      {error ? <span className="error small">{error}</span> : null}
    </div>
  );
}

function ParamField({ param, value, onChange }: { param: BumperParam; value: unknown; onChange: (v: unknown) => void }) {
  if (param.type === "font") return <AssetField label={param.label} kind="font" value={value as ThemeAsset | undefined} onChange={onChange} emptyText={param.help ?? "No font"} />;
  const help = param.help ? <span className="muted small">{param.help}</span> : null;
  if (param.type === "number")
    return (
      <label>
        {param.label}
        <input type="number" min={param.min} max={param.max} step={param.step} value={Number(value ?? param.default)} onChange={(e) => onChange(Number(e.target.value))} />
        {help}
      </label>
    );
  return (
    <label>
      {param.label}
      {param.type === "multiline" ? <textarea rows={2} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} /> : <input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      {help}
    </label>
  );
}

/** Style picker and parameters for the intro or the outro. Music is kept when the style changes. */
function BumperFields({ placement, choice, onChange }: { placement: BumperPlacement; choice?: BumperChoice; onChange: (choice?: BumperChoice) => void }) {
  const style = bumperStyle(choice?.style);
  return (
    <>
      <label>
        {placement === "intro" ? "Intro" : "Outro"}
        <select
          value={choice?.style ?? ""}
          onChange={(e) => onChange(e.target.value ? { ...newBumperChoice(e.target.value), audio: choice?.audio } : undefined)}
        >
          <option value="">None</option>
          {BUMPER_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        {style ? <span className="muted small">{style.description} {placement === "intro" ? "Plays over the first segment before its narration." : "Plays over the end of the last segment."}</span> : null}
      </label>
      {style && choice
        ? style.params.map((p) => (
            <ParamField key={p.key} param={p} value={choice.params[p.key]} onChange={(v) => onChange({ ...choice, params: { ...choice.params, [p.key]: v } })} />
          ))
        : null}
    </>
  );
}

/**
 * Edits the theme beside a live preview: sample slides with the draft colours, fonts, backgrounds,
 * intro and outro. Saving stores the theme; closing discards the draft. Uploaded files stay in
 * Garage until the project is deleted, even when the draft is discarded.
 */
export function ThemeEditor({ open, onOpenChange, theme, images, reloadImages, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; theme: ThemeSettings; images: Material[]; reloadImages: () => Promise<unknown>; onSaved: (theme: ThemeSettings) => void }) {
  const [draft, setDraft] = useState(theme);
  const [format, setFormat] = useState<Format>("portrait");
  const [preview, setPreview] = useState<TimelineProps | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setDraft(structuredClone(theme));
  }, [open]);
  // Debounced, so typing or dragging a colour does not request a preview per keystroke.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      api<TimelineProps>("/api/theme-preview", "POST", { theme: draft, format }).then((p) => { setPreview(p); setError(""); }, (e) => setError((e as Error).message));
    }, 350);
    return () => clearTimeout(timer);
  }, [open, draft, format]);
  const colors = themeColors(draft.colors);
  const presets = installedExtensions().flatMap((e) => (e.themePresets ?? []).map((p) => ({ value: `${e.id}/${p.id}`, extensionId: e.id, preset: p })));
  const [presetValue, setPresetValue] = useState("");
  const selectedPreset = presets.find((p) => p.value === presetValue);
  const applyPreset = async () => {
    if (!selectedPreset) return;
    setSaving(true);
    try {
      const next = await api<{ theme: ThemeSettings }>(`/api/theme/presets/${encodeURIComponent(selectedPreset.extensionId)}/${encodeURIComponent(selectedPreset.preset.id)}`, "POST");
      setDraft(next.theme);
      onSaved(next.theme);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const set = (fn: (t: ThemeSettings) => void) => setDraft((t) => { const n = structuredClone(t); fn(n); return n; });
  const save = async () => {
    setSaving(true);
    try {
      const next = await api<{ theme: ThemeSettings }>("/api/project-config", "PUT", { theme: { ...draft, colors } });
      onSaved(next.theme);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="theme-dialog sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Theme</DialogTitle>
          <DialogDescription>Colours, fonts, slide backgrounds, intro and outro. The preview uses the values as you edit them.</DialogDescription>
        </DialogHeader>
        <div className="theme-body">
          <div className="theme-fields">
            {presets.length ? (
              <>
                <div className="settings-subhead first">Preset</div>
                <label>
                  Theme preset
                  <select value={presetValue} onChange={(e) => setPresetValue(e.target.value)}>
                    <option value="">Choose a preset</option>
                    {presets.map((p) => <option key={p.value} value={p.value}>{p.preset.label}</option>)}
                  </select>
                  <span className="muted small">{selectedPreset?.preset.description ?? "Applying saves at once. It replaces what the preset defines and discards unsaved edits here."}</span>
                </label>
                <Button variant="outline" size="sm" className="self-start" disabled={saving || !selectedPreset} onClick={applyPreset}>Apply preset</Button>
              </>
            ) : null}
            <div className={`settings-subhead${presets.length ? "" : " first"}`}>Colours</div>
            <div className="theme-colors">
              {(Object.keys(THEME_COLOR_LABELS) as Array<keyof ThemeColors>).map((key) => (
                <label key={key} className="theme-color">
                  {THEME_COLOR_LABELS[key]}
                  <span className="row">
                    <input type="color" value={colors[key]} onChange={(e) => set((t) => { t.colors = { ...themeColors(t.colors), [key]: e.target.value }; })} />
                    <input className="hex" value={draft.colors?.[key] ?? colors[key]} onChange={(e) => set((t) => { t.colors = { ...themeColors(t.colors), ...t.colors, [key]: e.target.value.trim() }; })} />
                  </span>
                </label>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => set((t) => { t.colors = undefined; })}>Reset colours</Button>

            <div className="settings-subhead">Fonts and logo</div>
            <AssetField label="Slide font (headings, bullets, captions on photos)" kind="font" value={draft.displayFont} onChange={(a) => set((t) => { t.displayFont = a; })} emptyText="Default handwriting font" />
            <AssetField label="Logo on title slides" kind="image" value={draft.logo} onChange={(a) => set((t) => { t.logo = a; })} emptyText="No logo" />
            <label className="check" title="Without subtitles, a title slide's heading carries the point while the narration plays."><input type="checkbox" checked={draft.subtitlesOnTitleSlides !== false} onChange={(e) => set((t) => { if (e.target.checked) delete t.subtitlesOnTitleSlides; else t.subtitlesOnTitleSlides = false; })} />Subtitles on title slides</label>

            <div className="settings-subhead">Slide backgrounds</div>
            <p className="muted small">Image materials, used in turn and blurred behind slides. Without any, slides use the video's own captures.</p>
            <MaterialAttach
              attached={draft.backgroundMaterialIds}
              all={images}
              onChange={(ids) => set((t) => { t.backgroundMaterialIds = ids; })}
              attach={{}}
              onUploaded={async (m) => {
                await reloadImages();
                const added = m.filter((x) => x.kind === "image").map((x) => x.id);
                if (added.length) set((t) => { t.backgroundMaterialIds = [...t.backgroundMaterialIds, ...added]; });
              }}
              onEdited={reloadImages}
            />

            <div className="settings-subhead">Intro</div>
            <BumperFields placement="intro" choice={draft.intro} onChange={(c) => set((t) => { t.intro = c; })} />
            <div className="settings-subhead">Outro</div>
            <BumperFields placement="outro" choice={draft.outro} onChange={(c) => set((t) => { t.outro = c; })} />
            <p className="muted small">Music for the intro and the outro is added on the settings page after saving.</p>
          </div>

          <div className="theme-preview">
            <SegTabs value={format} onChange={setFormat} items={[{ value: "portrait", label: "Short 9:16" }, { value: "landscape", label: "Video 16:9" }]} />
            {preview ? (
              <div className={`theme-player ${format}`}>
                <VideoPlayer timeline={preview} loop autoPlay />
              </div>
            ) : (
              <p className="muted small">Loading preview…</p>
            )}
          </div>
        </div>
        {error ? <p className="error small">{error}</p> : null}
        <div className="row theme-actions">
          <Button disabled={saving} onClick={save}>Save theme</Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
