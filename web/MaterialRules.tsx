import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ListInput } from "@/components/list-input";
import { DEFAULT_METADATA_FILE, type MaterialRule } from "../shared/projects";
import type { DateFrom, PreviewState, RulePreview } from "../shared/types";
import { api, useJob } from "./api";
import { IMPORT_TO_HINT, LISTED_ONLY_HINT, MATERIAL_EXCLUDE_HINT, MATERIAL_INCLUDE_HINT, MATERIAL_PATTERN_HINT, MATERIAL_RULES_HINT, METADATA_FILE_HINT } from "./project-fields";

const STATE_LABEL: Record<PreviewState, string> = {
  new: "New material",
  "new-inbox": "New in the inbox",
  inbox: "Waits in the inbox",
  material: "Updates its material",
  moved: "Moved from another path",
  dismissed: "Dismissed, stays out",
  deleted: "Deleted, stays out",
  duplicate: "Same content as another file, stays out",
};
const DATE_LABEL: Record<DateFrom, string> = { metadata: "from the metadata", commit: "from the named commit", "first-commit": "from the first commit" };

/** The files the rules match, with the fields they get and what the import would do. */
function PreviewDialog({ sourceId, preview, rules, onClose }: { sourceId: string; preview: RulePreview; rules: MaterialRule[]; onClose: () => void }) {
  const ruleName = (id: string) => `Rule ${rules.findIndex((r) => r.id === id) + 1}`;
  const [again, setAgain] = useState<Set<string>>(new Set());
  const [err, setErr] = useState("");
  const deleted = preview.files.filter((f) => f.state === "deleted" && !again.has(f.path)).map((f) => f.path);
  const importAgain = async (paths: string[]) => {
    setErr("");
    try {
      await api("/api/source-files/import-again", "POST", { sourceId, paths });
      setAgain((done) => new Set([...done, ...paths]));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{preview.total} matching file{preview.total === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            {rules.map((r) => `${ruleName(r.id)}: ${preview.matchesPerRule[r.id] ?? 0}`).join(" · ")}
            {preview.files.length < preview.total ? ` · The first ${preview.files.length} are listed.` : ""}
          </DialogDescription>
        </DialogHeader>
        {preview.errors.map((e) => <div key={e} className="error small">{e}</div>)}
        {err ? <div className="error small">{err}</div> : null}
        {deleted.length || again.size ? (
          <div className="row">
            <span className="muted small grow">{again.size ? `${again.size} deleted file${again.size === 1 ? "" : "s"} will be imported again by the next Refresh activity or Check sources.` : "Files whose material you deleted stay out until you import them again."}</span>
            {deleted.length > 1 ? <Button size="xs" variant="outline" onClick={() => void importAgain(deleted)}>Import all {deleted.length} deleted files again</Button> : null}
          </div>
        ) : null}
        <div className="rule-preview">
          <table>
            <thead><tr><th>File</th><th>Title</th><th>Tags</th><th>Group</th><th>Date</th><th>Import</th></tr></thead>
            <tbody>
              {preview.files.map((f) => (
                <tr key={f.path}>
                  <td title={ruleName(f.ruleId)}>{f.path}</td>
                  <td title={f.fields.annotation}>{f.fields.title}</td>
                  <td>{f.fields.tags.join(", ")}</td>
                  <td>{f.fields.group ?? ""}</td>
                  <td title={DATE_LABEL[f.dateFrom]}>{f.fields.date}</td>
                  <td>
                    {again.has(f.path) ? "Imported again on the next import" : STATE_LABEL[f.state]}
                    {f.state === "deleted" && !again.has(f.path) ? <> <Button size="xs" variant="ghost" onClick={() => void importAgain([f.path])}>Import again</Button></> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The material rules of one source. An empty list removes the setting. Preview needs the source to be saved. */
export function MaterialRulesField({ sourceId, saved, value, onChange }: { sourceId: string; saved: boolean; value: MaterialRule[]; onChange: (rules: MaterialRule[]) => void }) {
  const [preview, setPreview] = useState<RulePreview | null>(null);
  const [err, setErr] = useState("");
  const job = useJob((j) => {
    if (j.status === "done") setPreview(j.result as RulePreview);
    else setErr(j.error ?? "The preview failed.");
  });
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
        {value.length ? <Button variant="outline" size="sm" disabled={!saved || job.running} title={saved ? "Lists the files the rules match, as you edited them, without importing anything." : "Save the source first."} onClick={() => { setErr(""); job.start("/api/source-files/preview", { sourceId, rules: value }).catch((e: Error) => setErr(e.message)); }}>{job.running ? "Previewing…" : "Preview matches"}</Button> : null}
        <Button variant="outline" size="sm" onClick={() => onChange([...value, { id: `rule-${crypto.randomUUID()}`, include: [] }])}>Add material rule</Button>
      </div>
      <span className="field-hint">{MATERIAL_RULES_HINT}</span>
      {err ? <div className="error small">{err}</div> : null}
      {preview ? <PreviewDialog sourceId={sourceId} preview={preview} rules={value} onClose={() => setPreview(null)} /> : null}
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
