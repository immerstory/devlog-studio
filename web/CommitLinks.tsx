import React, { useEffect, useState } from "react";
import { api } from "./api";
import type { CommitInfo } from "../shared/types";

const SHOWN_COMMITS = 5;
const known = new Map<string, Promise<CommitInfo | undefined>>();
let waiting: Map<string, (info: CommitInfo | undefined) => void> | undefined;

/** Answers every lookup made in one render from a single request. */
async function askServer(batch: Map<string, (info: CommitInfo | undefined) => void>) {
  let found: CommitInfo[] = [];
  try {
    found = await api<CommitInfo[]>("/api/git/commits", "POST", { refs: [...batch.keys()] });
  } catch {
    for (const ref of batch.keys()) known.delete(ref);
  }
  for (const [ref, resolve] of batch) resolve(found.find((c) => c.ref === ref));
}

function lookUp(ref: string) {
  let info = known.get(ref);
  if (!info) {
    info = new Promise((resolve) => {
      if (!waiting) {
        const batch = (waiting = new Map());
        setTimeout(() => { waiting = undefined; void askServer(batch); });
      }
      waiting.set(ref, resolve);
    });
    known.set(ref, info);
  }
  return info;
}

function useCommit(ref: string) {
  const [info, setInfo] = useState<CommitInfo>();
  useEffect(() => {
    let current = true;
    void lookUp(ref).then((found) => { if (current) setInfo(found); });
    return () => { current = false; };
  }, [ref]);
  return info;
}

/** A short hash that links to the commit on its forge, with the commit message as its tooltip. `ref` is `source:hash` or a bare hash. */
export function CommitLink({ commit }: { commit: string }) {
  const info = useCommit(commit);
  const hash = (info?.hash ?? commit.split(":").pop() ?? commit).slice(0, 8);
  if (!info?.url) return <span className="commit-hash" title={info?.message}>{hash}</span>;
  return <a className="commit-hash" href={info.url} target="_blank" rel="noreferrer" title={info.message} onClick={(e) => e.stopPropagation()}>{hash}</a>;
}

function CommitRow({ commit }: { commit: string }) {
  const info = useCommit(commit);
  return <li title={info?.message}><CommitLink commit={commit} /> {info?.subject}</li>;
}

/** Commits with their links and subjects. A long list shows its first few and folds the rest. */
export function CommitList({ commits }: { commits: string[] }) {
  const rest = commits.slice(SHOWN_COMMITS);
  return (
    <div className="muted small">
      <div>Commits</div>
      <ul className="commit-list">{commits.slice(0, SHOWN_COMMITS).map((c) => <CommitRow key={c} commit={c} />)}</ul>
      {rest.length ? (
        <details>
          <summary>{rest.length} more</summary>
          <ul className="commit-list">{rest.map((c) => <CommitRow key={c} commit={c} />)}</ul>
        </details>
      ) : null}
    </div>
  );
}
