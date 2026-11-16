/** Shown when a page replaced its document during both attempts to prepare it. */
export const REPLACED_PAGE = "The page reloaded itself twice while it was being prepared. Try again later. If it keeps happening, record the page yourself and upload it as a material, or show this source on a slide.";

/**
 * True for the browser's errors about a document that is gone: the page reloaded or navigated while it was
 * being checked or prepared, for example after a bot check or a redirect by script.
 */
export const isReplacedPage = (err: unknown) =>
  /detached Frame|Execution context was destroyed|Cannot find context with specified id/i.test(err instanceof Error ? err.message : String(err));

/** Runs the work again once when the page replaced its document during it. The work opens its own browser each time. */
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
    throw isReplacedPage(err) ? new Error(REPLACED_PAGE) : err;
  }
}
