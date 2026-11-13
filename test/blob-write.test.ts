import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeOutput } from "../server/sourceMaterials.js";

// The child writes, closes its output and exits 200 ms later, so the file closes before the process exits.
const lateExit = (code: number) => spawn(process.execPath, ["-e", `process.stdout.write("data", () => { require("fs").closeSync(1); setTimeout(() => process.exit(${code}), 200); });`]);

test("a process's output is written whether the file closes before or after the process exits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-write-"));
  try {
    const file = path.join(dir, "out");
    await writeOutput(lateExit(0), file, "test");
    assert.equal(fs.readFileSync(file, "utf8"), "data");
    await assert.rejects(writeOutput(lateExit(3), path.join(dir, "failed"), "test"), /test failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
