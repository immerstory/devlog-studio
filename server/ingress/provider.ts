import type { ActivityRecord, ActivitySource } from "../../shared/activity.js";
import type { ProjectSettings } from "../../shared/projects.js";

export interface DateRange { from: string; to?: string }
export interface SourceCandidate { connector: ActivitySource["connector"] | "git"; label: string; detail: string; found: number; repo?: string; baseUrl?: string; tokenSet?: boolean }
/** What a log's reader remembers between runs. */
export interface FileCursor { size: number; mtimeMs: number; offset: number; skip?: boolean; sourceId?: string; title?: string; branch?: string; repo?: string }
export type CollectEvent = { record: ActivityRecord } | { cursor: unknown } | { unsupported: string } | { skippedLines: number };

/** Finds sources of activity and reads records from them. Repeating a read is safe, because a record's ID is stable. */
export interface IngressConnector {
  id: string;
  label: string;
  /** Proposes sources for the project; the developer confirms them. */
  discover(project: ProjectSettings): Promise<SourceCandidate[]>;
  collect(project: ProjectSettings, source: ActivitySource | undefined, cursor: unknown, range: DateRange): AsyncIterable<CollectEvent>;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The calendar day on this machine, which is where the developer works. */
export function localDate(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
