import fs from "node:fs";
import path from "node:path";
import { Browser, computeExecutablePath, install } from "@puppeteer/browsers";
import { CACHE_DIR } from "../../config.js";

/** The Chrome build this version of Puppeteer is made for. */
const CHROME = { browser: Browser.CHROMEHEADLESSSHELL, buildId: "155.0.8059.39", cacheDir: path.join(CACHE_DIR, "chrome") };

const DOWNLOAD_PREFIX = "chrome-download-";
/** Old enough that the computer didn't just sleep during the download, so the folder belongs to one that was stopped. */
const STALE_MS = 7 * 24 * 3600_000;

/** The download in progress, which captures that start meanwhile share. */
let installing: Promise<void> | undefined;

/** Path of the Chrome headless shell, downloaded on first use. */
export async function chromePath(): Promise<string> {
  const executable = computeExecutablePath(CHROME);
  if (!fs.existsSync(executable)) await (installing ??= installChrome(executable).finally(() => { installing = undefined; }));
  return executable;
}

/**
 * Downloads Chrome into a folder of its own and moves the finished build into place, so another process that downloads
 * it too never writes the same files, and a download that breaks off leaves no partial build behind.
 */
async function installChrome(executable: string) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  removeStaleDownloads(CACHE_DIR);
  const folder = fs.mkdtempSync(path.join(CACHE_DIR, DOWNLOAD_PREFIX));
  try {
    await install({ ...CHROME, cacheDir: folder });
    // The build's folder is the second level: browser, then platform and version.
    const build = path.join(...path.relative(CHROME.cacheDir, executable).split(path.sep).slice(0, 2));
    moveBuild(path.join(folder, build), path.join(CHROME.cacheDir, build), executable);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Moves a finished build into place. A build that another process has put there stays, because that process may
 * already run it; only a folder without the executable, which no process can use, is replaced.
 */
export function moveBuild(from: string, place: string, executable: string) {
  fs.mkdirSync(path.dirname(place), { recursive: true });
  try {
    fs.renameSync(from, place);
  } catch {
    if (fs.existsSync(executable)) return;
    // Moved away before it is removed, so a build that another process puts there at this moment isn't lost.
    const aside = `${place}.${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(place, aside);
    } catch {
      // Another process moved it away first.
    }
    const moved = path.join(aside, path.relative(place, executable));
    try {
      fs.renameSync(fs.existsSync(moved) ? aside : from, place);
    } catch (err) {
      if (!fs.existsSync(executable)) throw err;
    }
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Removes the folders of downloads that were stopped before they could clean up. */
export function removeStaleDownloads(dir: string, now = Date.now()) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(DOWNLOAD_PREFIX)) continue;
    const folder = path.join(dir, name);
    try {
      if (now - fs.statSync(folder).mtimeMs > STALE_MS) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // Another process removed it, or on Windows still has a file in it open.
    }
  }
}
