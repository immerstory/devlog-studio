const KEY = "devlog.dismissedJobs";

/** Tasks the reader hid in the task box, kept in the browser so they stay hidden after a reload. */
export function loadDismissed(): Set<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* not remembered */
  }
}

/**
 * The hidden IDs the server still lists. The server forgets tasks on restart, so the rest can go.
 * Returns the same set when nothing is dropped, so a React state update can skip a render.
 */
export function pruneDismissed(dismissed: Set<string>, listed: Set<string>): Set<string> {
  const kept = new Set([...dismissed].filter((id) => listed.has(id)));
  return kept.size === dismissed.size ? dismissed : kept;
}
