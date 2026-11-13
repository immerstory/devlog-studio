import { Button } from "@/components/ui/button";
import { ListInput } from "@/components/list-input";
import { DEFAULT_METADATA_FILE, type MaterialRule } from "../shared/projects";
import { IMPORT_TO_HINT, LISTED_ONLY_HINT, MATERIAL_EXCLUDE_HINT, MATERIAL_INCLUDE_HINT, MATERIAL_PATTERN_HINT, MATERIAL_RULES_HINT, METADATA_FILE_HINT } from "./project-fields";

/** The material rules of one source. An empty list removes the setting. */
export function MaterialRulesField({ value, onChange }: { value: MaterialRule[]; onChange: (rules: MaterialRule[]) => void }) {
  const change = (i: number, patch: Partial<MaterialRule>) => onChange(value.map((rule, j) => {
    if (j !== i) return rule;
    const next = { ...rule, ...patch } as MaterialRule & Record<string, unknown>;
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
    return next;
  }));
  return (
    <div className="material-rules">
      <div className="row">
        <span className="grow settings-subhead first">Material rules</span>
        <Button variant="outline" size="sm" onClick={() => onChange([...value, { id: `rule-${crypto.randomUUID()}`, include: [] }])}>Add material rule</Button>
      </div>
      <span className="field-hint">{MATERIAL_RULES_HINT}</span>
      {value.map((rule, i) => (
        <fieldset key={rule.id} className="material-rule">
          <label>Include<ListInput value={rule.include} onChange={(include) => change(i, { include })} /><span className="field-hint">{MATERIAL_INCLUDE_HINT}</span></label>
          <label>Exclude<ListInput value={rule.exclude ?? []} onChange={(exclude) => change(i, { exclude: exclude.length ? exclude : undefined })} /><span className="field-hint">{MATERIAL_EXCLUDE_HINT}</span></label>
          <label>Path pattern<input value={rule.pattern ?? ""} onChange={(e) => change(i, { pattern: e.target.value.trim() ? e.target.value : undefined })} /><span className="field-hint">{MATERIAL_PATTERN_HINT}</span></label>
          <label>Metadata file<input value={rule.metadataFile ?? DEFAULT_METADATA_FILE} onChange={(e) => change(i, { metadataFile: e.target.value.trim() === DEFAULT_METADATA_FILE ? undefined : e.target.value.trim() })} /><span className="field-hint">{METADATA_FILE_HINT}</span></label>
          <label>Import to
            <select value={rule.importTo ?? "materials"} onChange={(e) => change(i, { importTo: e.target.value === "inbox" ? "inbox" : undefined })}>
              <option value="materials">Materials</option>
              <option value="inbox">Inbox, to add by hand</option>
            </select>
            <span className="field-hint">{IMPORT_TO_HINT}</span>
          </label>
          <div className="row">
            <label className="check" title={LISTED_ONLY_HINT}><input type="checkbox" checked={!!rule.listedOnly} onChange={(e) => change(i, { listedOnly: e.target.checked || undefined })} />Only files the metadata file lists</label>
            <span className="grow" />
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onChange(value.filter((_, j) => j !== i))}>Delete rule</Button>
          </div>
        </fieldset>
      ))}
    </div>
  );
}
