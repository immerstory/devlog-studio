import React, { useId } from "react";
import { Button } from "@/components/ui/button";
import { ARCHETYPE_IDS, ARCHETYPES, promptGuidance, type ProjectArchetype } from "../shared/archetypes";
import type { ProjectSettings } from "../shared/projects";

/** Chooses the kind of product a project is. */
export function ArchetypePicker({ value, hint, onChange }: { value?: ProjectArchetype; hint: React.ReactNode; onChange: (archetype: ProjectArchetype) => void }) {
  const group = useId();
  return (
    <fieldset className="archetype-picker">
      <legend>Project type</legend>
      <div className="archetype-options">
        {ARCHETYPE_IDS.map((id) => (
          <label key={id} className="archetype-option">
            <input type="radio" name={group} checked={value === id} onChange={() => onChange(id)} />
            <span><strong>{ARCHETYPES[id].label}</strong><span className="field-hint">{ARCHETYPES[id].summary}</span></span>
          </label>
        ))}
      </div>
      <p className="field-hint">{hint}</p>
    </fieldset>
  );
}

/** Edits the prompt text of a project and restores the default of its type. */
export function PromptGuidanceField({ settings, onChange }: { settings: Pick<ProjectSettings, "archetype" | "promptGuidance">; onChange: (guidance: string | undefined) => void }) {
  const fallback = ARCHETYPES[settings.archetype];
  const customized = settings.promptGuidance !== undefined;
  return (
    <div className="prompt-guidance">
      <label>
        Audience and shot guidance
        <textarea rows={6} value={promptGuidance(settings)} onChange={(e) => onChange(e.target.value === fallback.guidance ? undefined : e.target.value)} />
      </label>
      <p className="field-hint">Every suggestion, question and script request includes this text. It tells the agent who the content is for, what to emphasize and which shots work well. It doesn't appear in your videos.</p>
      <div className="row">
        <span className="grow muted small">{customized ? "Customized for this project." : `Uses the ${fallback.label} default.`}</span>
        <Button type="button" variant="outline" size="sm" disabled={!customized} onClick={() => onChange(undefined)}>Restore {fallback.label} default</Button>
      </div>
    </div>
  );
}
