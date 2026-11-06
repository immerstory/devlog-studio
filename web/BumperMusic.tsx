import React from "react";
import { Button } from "@/components/ui/button";
import { api, apiUrl } from "./api";
import { bumperParams, bumperStyle, type BumperChoice, type BumperPlacement, type ThemeAsset } from "../shared/bumpers";

/** One line about a bumper choice for the theme summary. */
export function bumperSummary(choice?: BumperChoice) {
  const style = bumperStyle(choice?.style);
  if (!choice || !style) return "None";
  const params = bumperParams(choice)!;
  const text = typeof params.text === "string" && params.text.trim() ? params.text.replace(/\n/g, " / ") : undefined;
  const font = (params.font as ThemeAsset | undefined)?.name;
  return [style.label, text, font, choice.audio ? "with music" : undefined].filter(Boolean).join(" · ");
}

/** Music upload for the intro or outro. Shown only when that placement has a bumper; uploads save at once. */
export function BumperMusic({ placement, choice, onChanged }: { placement: BumperPlacement; choice?: BumperChoice; onChanged: (msg: string) => void }) {
  if (!choice) return null;
  const name = placement === "intro" ? "Intro" : "Outro";
  const audio = choice.audio;
  return (
    <>
      <div className="settings-subhead">{name} music</div>
      <p className="muted small">
        {placement === "intro"
          ? "Starts with the video. The leading silence is cut on upload."
          : "Export your track against a full video, silent until the outro. The leading silence is cut on upload, and the music keeps its position relative to the outro in every video."}
      </p>
      {audio ? (
        <div className="row">
          <audio controls src={`/media/${audio.key}?v=${encodeURIComponent(audio.sourceName + audio.durationSeconds)}`} />
          <span className="small">
            {audio.sourceName} · {audio.durationSeconds.toFixed(2)} s{placement === "outro" ? ` · starts ${audio.leadSeconds.toFixed(2)} s before the outro` : ""}
          </span>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={async () => { await api(`/api/project-bumper-audio/${placement}`, "DELETE"); onChanged(`${name} music removed.`); }}>Remove</Button>
        </div>
      ) : (
        <p className="muted small">No {placement} music.</p>
      )}
      <label>
        {audio ? "Replace with another track" : "Upload a track (WAV, MP3, …)"}
        <input
          type="file"
          accept="audio/*"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const form = new FormData();
            form.append("file", file, file.name);
            onChanged(`Uploading ${placement} music…`);
            const res = await fetch(apiUrl(`/api/project-bumper-audio/${placement}`), { method: "POST", body: form });
            const data = await res.json();
            onChanged(res.ok ? `${name} music saved.` : data.error);
            e.target.value = "";
          }}
        />
      </label>
    </>
  );
}
