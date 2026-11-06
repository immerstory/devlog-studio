import crypto from "node:crypto";
import { listMaterials, listSuggestions, updatePost } from "./store.js";
import { projectId } from "./context.js";
import { activityContext } from "./ingress/sync.js";
import { spokenTurns } from "../shared/turns.js";
import type { Format, Post, Script, Turn, Verification, VerificationState } from "../shared/types.js";

const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const normal = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

export const answersOf = (post: Pick<Post, "questions">) => post.questions.filter((q) => q.answer.trim()).map((q) => ({ question: q.question, answer: q.answer.trim() }));

/**
 * The evidence a check reads, as text: the verifier receives exactly this, and the fingerprint hashes exactly this.
 * Fields the verifier doesn't read stay out, so they can't make a check out of date.
 */
export async function evidenceSnapshot(pid: string, post: Pick<Post, "suggestionIds" | "materialIds">): Promise<string> {
  const suggestions = (await listSuggestions(pid)).filter((s) => post.suggestionIds.includes(s.id));
  const materialIds = new Set([...suggestions.flatMap((s) => s.materialIds ?? []), ...post.materialIds]);
  const materials = (await listMaterials(pid)).filter((m) => materialIds.has(m.id));
  const activity = await activityContext(pid, post);
  return JSON.stringify({
    ...(activity ? { activity } : {}),
    topics: suggestions.map((s) => ({ id: s.id, title: s.title, summary: s.summary, whyItMatters: s.whyItMatters, workDate: s.workDate, highlights: s.highlights, commits: s.sources.commits, files: s.sources.files })).sort((a, b) => a.id.localeCompare(b.id)),
    materials: materials.map((m) => ({ id: m.id, title: m.title, annotation: m.annotation, date: m.date, key: m.key })).sort((a, b) => a.id.localeCompare(b.id)),
  }, null, 1);
}

/** Covers what the video says: segment order, and each turn's order, speaker and text. */
export function scriptFingerprint(script: Pick<Script, "segments">): string {
  return hash(script.segments.map((s) => [s.id, spokenTurns(s).map((t) => [t.id, t.speaker, t.text.trim()])]));
}

/** Covers everything a check reads. */
export function verificationFingerprint(script: Pick<Script, "segments">, post: Pick<Post, "questions">, evidence: string): string {
  return hash([scriptFingerprint(script), answersOf(post), evidence]);
}

/** Identifies one decision about one flag: the line, the claim, the reason and everything that could support the line. */
export function flagKey(script: Pick<Script, "segments">, post: Pick<Post, "questions">, evidence: string, turnId: string, claim: string, reason: string): string {
  const turns = script.segments.flatMap(spokenTurns);
  const index = turns.findIndex((t) => t.id === turnId);
  const before = turns.slice(0, Math.max(index, 0)).filter((t) => t.speaker === "developer").map((t) => t.text.trim());
  return hash([turnId, turns[index]?.text.trim(), normal(claim), normal(reason), answersOf(post), evidence, before]);
}

export interface VerifiedClaim { turnId: string; claim: string; source: "evidence" | "answer" | "developerTurn" | "none"; supported: boolean; reason: string }

/** Turns the verifier's claims into a stored result. Acceptances carry over only for an identical flag. */
export function verificationResult(script: Script, post: Pick<Post, "questions">, evidence: string, fingerprint: string, claims: VerifiedClaim[], accepted: string[] = []): Verification {
  const coHostTurns = new Set(script.segments.flatMap(spokenTurns).filter((t: Turn) => t.speaker === "coHost").map((t) => t.id));
  const flags = claims.filter((c) => !c.supported && coHostTurns.has(c.turnId)).map((c) => ({ key: flagKey(script, post, evidence, c.turnId, c.claim, c.reason), turnId: c.turnId, claim: c.claim, reason: c.reason }));
  const unique = [...new Map(flags.map((f) => [f.key, f])).values()];
  return { fingerprint, scriptFingerprint: scriptFingerprint(script), checkedAt: new Date().toISOString(), flags: unique, accepted: accepted.filter((key) => unique.some((f) => f.key === key)) };
}

/** Derived on every read, so no stored status can go out of step with the script, answers or evidence. */
export function verificationState(script: Script, post: Pick<Post, "questions">, evidence: string): VerificationState {
  const v = script.verification;
  if (!v || v.fingerprint !== verificationFingerprint(script, post, evidence)) return "outOfDate";
  return v.flags.some((f) => !v.accepted.includes(f.key)) ? "flagged" : "current";
}

const refuse = (message: string) => Object.assign(new Error(message), { status: 409 });

/** The shared check for approval and upload of a co-hosted format. Solo formats pass. */
export async function assertCoHostVerified(post: Post, format: Format) {
  if (post.presentation?.[format] !== "coHost") return;
  const script = post.scripts[format];
  if (!script) throw refuse("This video has no script.");
  const state = verificationState(script, post, await evidenceSnapshot(projectId(), post));
  if (state === "outOfDate") throw refuse("Check the co-host lines first: the script, answers or evidence changed since the last check.");
  if (state === "flagged") throw refuse("Resolve the flagged co-host lines first.");
  if (post.renders[format]?.scriptFingerprint !== script.verification!.scriptFingerprint) throw refuse("Render the final video again: the script changed since this render.");
}

/** Keeps a flag, or takes that decision back. */
export function setFlagAccepted(epId: string, format: Format, key: string, keep: boolean) {
  const pid = projectId();
  return updatePost(pid, epId, async (post) => {
    const script = post.scripts[format];
    const v = script?.verification;
    if (!script || !v || !v.flags.some((f) => f.key === key)) throw Object.assign(new Error("This flag no longer exists. Check the co-host lines again."), { status: 400 });
    if (verificationState(script, post, await evidenceSnapshot(pid, post)) === "outOfDate") throw refuse("Check the co-host lines again first.");
    v.accepted = keep ? [...new Set([...v.accepted, key])] : v.accepted.filter((k) => k !== key);
  });
}
