/** Agent citations may only select commits supplied in this run's evidence. */
export function normalizeCommitReferences(raw: unknown, evidence: Array<{ sourceId: string; hash: string }>) {
  const references = new Set<string>();
  let rejected = 0;
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value !== "string") { rejected++; continue; }
    const match = /^(?:([a-zA-Z0-9-]+):)?([0-9a-f]{7,40})$/i.exec(value.trim());
    if (!match) { rejected++; continue; }
    const [, source, hash] = match;
    const candidates = new Set(evidence.filter((c) => (!source || c.sourceId === source) && c.hash.toLowerCase().startsWith(hash.toLowerCase())).map((c) => `${c.sourceId}:${c.hash}`));
    if (candidates.size === 1) references.add([...candidates][0]);
    else rejected++;
  }
  return { references: [...references], rejected };
}
