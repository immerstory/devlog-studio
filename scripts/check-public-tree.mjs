/**
 * Fails when a tracked file holds a personal absolute path or something shaped like a secret.
 * Test files may name made-up paths, so only the secret patterns apply to them. Files in SKIP hold made-up
 * examples of what these patterns find.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const PATHS = [
  [/(?<![\w/])[A-Za-z]:[\\/]+[A-Za-z]/, "a Windows path"],
  [/(?<![\w.:/-])\/(?:Users|home)\/[a-z][\w.-]*\//, "a home folder"],
];
const SECRETS = [
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, "a GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{24,}/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bGK[0-9a-f]{24}\b/, "a Garage key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];
const SELF = "scripts/check-public-tree.mjs";
const SKIP = new Set([SELF, "package-lock.json", "test/ingress.test.ts", "web/PathField.tsx"]);

const findings = [];
for (const file of execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").filter(Boolean)) {
  if (SKIP.has(file) || !fs.existsSync(file)) continue;
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) continue;
  const rules = file.startsWith("test/") ? SECRETS : [...PATHS, ...SECRETS];
  buffer.toString("utf8").split(/\r?\n/).forEach((line, i) => {
    for (const [pattern, name] of rules) if (pattern.test(line)) findings.push(`${file}:${i + 1}: looks like ${name}`);
  });
}
if (findings.length) {
  console.error(findings.join("\n"));
  process.exit(1);
}
console.log("No personal paths or secrets found.");
