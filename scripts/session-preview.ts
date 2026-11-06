/**
 * Writes session digests to a local folder and nothing else: no database write, no agent run and no network call.
 * Read the result to judge whether digests are useful and safe before turning sessions on.
 *
 *   tsx scripts/session-preview.ts <outDir> <from YYYY-MM-DD> <source path> [<source path> ...]
 */
import fs from "node:fs";
import path from "node:path";
import { collectSessions } from "../server/ingress/sessions.js";
import type { SessionDigest } from "../shared/activity.js";

const [outDir, from, ...paths] = process.argv.slice(2);
if (!outDir || !from || !paths.length) throw new Error("Usage: session-preview.ts <outDir> <from YYYY-MM-DD> <source path> [<source path> ...]");
fs.mkdirSync(outDir, { recursive: true });
const sources = paths.map((p, i) => ({ id: `source-${i}`, label: path.basename(p), roots: [p] }));
const lines: string[] = [];
const totals = { sessions: new Set<string>(), days: 0, files: 0, commits: 0, checks: 0, prompts: 0, skippedLines: 0, unsupported: 0 };
const started = Date.now();
for (const connector of ["claude-sessions", "codex-sessions"] as const) {
  for await (const event of collectSessions(connector, sources, { from })) {
    if ("skippedLines" in event) totals.skippedLines += event.skippedLines;
    if ("unsupported" in event) { totals.unsupported++; lines.push(`UNSUPPORTED FORMAT: ${event.unsupported}`); }
    if (!("record" in event)) continue;
    const r = event.record;
    const d = r.detail as SessionDigest;
    totals.sessions.add(d.sessionId); totals.days++; totals.files += d.files.length; totals.commits += d.commits.length; totals.checks += d.checks.length; totals.prompts += d.prompts.length;
    lines.push(`## ${r.date}  ${d.tool}  ${r.title}  (${d.activeMinutes.length} active min, branch ${r.refs.branch ?? "-"})`, `Files (${d.files.length}): ${d.files.slice(0, 12).join(", ")}`, `Git: ${d.commands.join(" ; ") || "-"}`, `Commits: ${d.commits.join(", ") || "-"}`, `Checks: ${d.checks.map((c) => `${c.ok ? "ok" : "FAILED"} ${c.command}${c.error ? ` [${c.error}]` : ""}`).join(" ; ") || "-"}`, "Prompts:", ...d.prompts.map((p) => `  - ${p}`), "");
  }
}
fs.writeFileSync(path.join(outDir, "digests.md"), lines.join("\n"));
console.log(JSON.stringify({ ...totals, sessions: totals.sessions.size, seconds: Math.round((Date.now() - started) / 1000) }));
console.log(path.resolve(outDir, "digests.md"));
process.exit(0);
