import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings-section";
import { api } from "./api";
import { DEFAULT_DISCLOSURE, DEFAULT_PERSONA, newCoHost } from "../shared/cohost";
import type { CoHostSettings, ProjectSettings } from "../shared/projects";

/** The project's optional co-host. Turning it off keeps the values, so existing co-hosted scripts keep their voice. */
export function CoHostSection({ settings, onChange }: { settings: ProjectSettings; onChange: (coHost: CoHostSettings) => void }) {
  const [voiceCheck, setVoiceCheck] = useState("");
  const coHost = settings.coHost;
  const set = (patch: Partial<CoHostSettings>) => onChange({ ...(coHost ?? newCoHost()), ...patch });
  const checkVoice = async () => {
    setVoiceCheck("Checking…");
    try {
      const voice = await api<{ name: string }>(`/api/voices/${encodeURIComponent(coHost!.voiceId)}`);
      setVoiceCheck(`Found: ${voice.name}`);
    } catch (e) {
      setVoiceCheck((e as Error).message);
    }
  };
  const on = !!coHost?.enabled;
  return (
    <SettingsSection title="Co-host" description="An optional AI voice that talks through your videos with you. Each video can still be solo.">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => set({ enabled: e.target.checked })} />
        Use a co-host in this project
      </label>
      {coHost && !on ? <p className="field-hint">Existing co-hosted scripts keep this voice, and new videos are solo.</p> : null}
      {coHost && on ? (
        <>
          <label>Name<input value={coHost.name} onChange={(e) => set({ name: e.target.value })} /><span className="field-hint">Viewers may hear this name, and the description of a co-hosted video uses it.</span></label>
          <div className="row align-end">
            <label className="grow">
              Voice ID
              <input value={coHost.voiceId} placeholder="An ElevenLabs voice ID" onChange={(e) => { set({ voiceId: e.target.value.trim() }); setVoiceCheck(""); }} />
            </label>
            <Button type="button" variant="outline" disabled={!coHost.voiceId} onClick={checkVoice}>Check voice</Button>
            <span className="small">{voiceCheck}</span>
          </div>
          <p className="field-hint">Use a voice that differs from your narrator's, and that you have the right to use.</p>
          <div className="prompt-guidance">
            <label>
              Persona
              <textarea rows={7} value={coHost.persona ?? DEFAULT_PERSONA} onChange={(e) => set({ persona: e.target.value === DEFAULT_PERSONA ? undefined : e.target.value })} />
            </label>
            <p className="field-hint">Tells the agent how the co-host talks. {"{name}"} stands for the co-host's name. It doesn't appear in your videos.</p>
            <div className="row">
              <span className="grow muted small">{coHost.persona === undefined ? "Uses the default persona." : "Customized for this project."}</span>
              <Button type="button" variant="outline" size="sm" disabled={coHost.persona === undefined} onClick={() => set({ persona: undefined })}>Restore default persona</Button>
            </div>
          </div>
          <div className="row align-top">
            <label>Caption color<input type="color" value={coHost.captionColor} onChange={(e) => set({ captionColor: e.target.value })} /><span className="field-hint">Your captions stay white.</span></label>
            <label>Share of words in shorts (%)<input type="number" min={0} max={100} value={Math.round(coHost.share.portrait * 100)} onChange={(e) => set({ share: { ...coHost.share, portrait: Number(e.target.value) / 100 } })} /></label>
            <label>Share of words in landscape videos (%)<input type="number" min={0} max={100} value={Math.round(coHost.share.landscape * 100)} onChange={(e) => set({ share: { ...coHost.share, landscape: Number(e.target.value) / 100 } })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={coHost.defaultOn} onChange={(e) => set({ defaultOn: e.target.checked })} />New videos start co-hosted</label>
          <label className="check"><input type="checkbox" checked={coHost.alwaysDisclose} onChange={(e) => set({ alwaysDisclose: e.target.checked })} />The co-host says it's an AI in every video</label>
          <p className="field-hint">When this is off, it says so in the project's first co-hosted video.</p>
          <div className="prompt-guidance">
            <label>
              Line in the published description
              <input value={coHost.disclosure ?? DEFAULT_DISCLOSURE} onChange={(e) => set({ disclosure: e.target.value === DEFAULT_DISCLOSURE ? undefined : e.target.value })} />
            </label>
            <p className="field-hint">Every co-hosted video adds this line to its description and declares synthetic media on YouTube.</p>
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}
