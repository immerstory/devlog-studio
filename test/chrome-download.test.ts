import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveBuild, removeStaleDownloads } from "../server/capture/browser/chrome.js";

const inFolder = (work: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-chrome-"));
  try {
    work(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test("a finished build moves into place, keeps a complete one and replaces a partial one", () => {
  inFolder((dir) => {
    const place = path.join(dir, "chrome", "shell", "1.0");
    const executable = path.join(place, "bin", "shell");
    const build = (text: string) => { write(path.join(dir, "new", "bin", "shell"), text); return path.join(dir, "new"); };
    moveBuild(build("first"), place, executable);
    assert.equal(fs.readFileSync(executable, "utf8"), "first");
    moveBuild(build("second"), place, executable);
    assert.equal(fs.readFileSync(executable, "utf8"), "first", "another process may already run the build in place");
    fs.rmSync(executable);
    write(path.join(place, "bin", "other"), "partial");
    moveBuild(build("third"), place, executable);
    assert.equal(fs.readFileSync(executable, "utf8"), "third");
    assert.ok(!fs.existsSync(path.join(place, "bin", "other")));
    assert.deepEqual(fs.readdirSync(path.dirname(place)), ["1.0"], "the replaced folder is removed");
  });
});

test("folders of stopped downloads go after a week, other folders stay", () => {
  inFolder((dir) => {
    for (const name of ["chrome-download-a", "chrome"]) write(path.join(dir, name, "file"), "");
    removeStaleDownloads(dir, Date.now() + 2 * 24 * 3600_000);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["chrome", "chrome-download-a"], "a download can still run after the computer slept");
    removeStaleDownloads(dir, Date.now() + 8 * 24 * 3600_000);
    assert.deepEqual(fs.readdirSync(dir), ["chrome"]);
  });
});
