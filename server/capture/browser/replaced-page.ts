/** Shown when a page replaced its document during both attempts to prepare it. */
export const REPLACED_PAGE = "The page reloaded itself twice while it was being prepared. Try again later. If it keeps happening, record the page yourself and upload it as a material, or show this source on a slide.";

/** Shown when the page is gone after a shot's script ran: the script left the page, for example by clicking a link. */
export const SCRIPT_LEFT_PAGE = "The shot's script left the page, for example by following a link, so the page can't be filmed. Change the script so it stays on the page.";

/** A shot's own script failed or left the page. The script is the cause, so the page is never opened again. */
export class ScriptError extends Error {}

/** The page replaced its document during both attempts to prepare it. */
export class ReplacedPageError extends Error {
  constructor() {
    super(REPLACED_PAGE);
  }
}

/**
 * True for the browser's errors about a document that is gone: the page reloaded or navigated while it was
 * being checked or prepared, for example after a bot check or a redirect by script. Puppeteer reports these only
 * as messages, so they are told apart by their text. A ScriptError never counts, because the script is the cause.
 */
export function isReplacedPage(err: unknown) {
  if (err instanceof ScriptError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /detached Frame|frame was detached|Execution context was destroyed|Cannot find context with specified id/i.test(message);
}

/**
 * Runs the work again once when the page replaced its document during it, and throws a ReplacedPageError when it
 * happens twice. The work opens its own browser each time, so nothing a bot check left behind carries over.
 */
export async function retryReplacedPage<T>(work: () => Promise<T>, log: (line: string) => void): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!isReplacedPage(err)) throw err;
    log("The page reloaded itself while it was being prepared. Opening it again…");
  }
  try {
    return await work();
  } catch (err) {
    throw isReplacedPage(err) ? new ReplacedPageError() : err;
  }
}
