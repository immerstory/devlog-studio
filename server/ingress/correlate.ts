import type { ActivityLink, ActivityRecord, ActivityThread } from "../../shared/activity.js";

const COMMIT_WINDOW_MS = 30 * 60_000;
const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const samePrefix = (x: string, y: string) => x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));

/**
 * Finds links between records without a model. It adds links and never changes a record, so a wrong link can't
 * lose data. Exact: the same commit. Strong: the same source, overlapping time and shared files. Weak: the same
 * source and day, which is only a suggestion.
 */
export function correlate(records: ActivityRecord[]): ActivityLink[] {
  const links = new Map<string, ActivityLink>();
  const add = (a: string, b: string, strength: ActivityLink["strength"], reason: string) => {
    if (a === b || links.has(key(a, b))) return;
    links.set(key(a, b), { a, b, strength, reason });
  };
  const usable = records.filter((r) => r.visibility !== "excluded");
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const x = usable[i], y = usable[j];
      const shared = x.refs.commits.find((c) => y.refs.commits.some((d) => samePrefix(c, d)));
      if (shared) add(x.id, y.id, "exact", `Both name commit ${shared.slice(0, 8)}`);
    }
  }
  const sessions = usable.filter((r) => r.kind === "session");
  const commits = usable.filter((r) => r.kind === "commit");
  for (const s of sessions) {
    const start = new Date(s.startedAt).getTime() - COMMIT_WINDOW_MS, end = new Date(s.endedAt).getTime() + COMMIT_WINDOW_MS;
    for (const c of commits) {
      if (c.sourceId !== s.sourceId || links.has(key(s.id, c.id))) continue;
      const at = new Date(c.startedAt).getTime();
      const files = c.refs.files.filter((f) => s.refs.files.includes(f));
      if (at >= start && at <= end && files.length) add(s.id, c.id, "strong", `Same time and ${files.length} shared file(s)`);
      else if (c.date === s.date) add(s.id, c.id, "weak", "Same repository and day");
    }
  }
  return [...links.values()];
}

/** Groups records by exact, strong and manual links. Weak links never group, and a developer's split always holds. */
export function threadsOf(records: ActivityRecord[], links: ActivityLink[]): ActivityThread[] {
  const parent = new Map(records.map((r) => [r.id, r.id]));
  const find = (id: string): string => {
    const p = parent.get(id)!;
    if (p === id) return id;
    const top = find(p);
    parent.set(id, top);
    return top;
  };
  const splits = new Set(links.filter((l) => l.split).map((l) => key(l.a, l.b)));
  for (const l of links) {
    if (l.split || l.strength === "weak" || !parent.has(l.a) || !parent.has(l.b) || splits.has(key(l.a, l.b))) continue;
    parent.set(find(l.a), find(l.b));
  }
  const groups = new Map<string, string[]>();
  for (const r of records) groups.set(find(r.id), [...(groups.get(find(r.id)) ?? []), r.id]);
  return [...groups.values()].map((recordIds) => ({ id: [...recordIds].sort()[0], recordIds }));
}
