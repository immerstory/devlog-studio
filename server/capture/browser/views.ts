import type { Format, PageView, Segment } from "../../../shared/types.js";
import { projectId } from "../../context.js";
import { deleteValue, getValue, pageViewKey, setValue } from "../../store.js";
import { deleteKey, putBuffer } from "../../storage.js";
import type { PageLook } from "./look.js";

/** The webpage shot a view belongs to. */
export interface ViewOf { postId: string; format: Format; segmentId: string }

/** Where the pictures of views are kept. */
export interface ViewIO { putBuffer(key: string, body: Buffer): Promise<void>; deleteKey(key: string): Promise<void> }
const storage: ViewIO = { putBuffer, deleteKey };

const key = (shot: ViewOf) => pageViewKey(shot.postId, shot.format, shot.segmentId);

/** What the browser saw at a webpage shot's latest failure. */
export const pageView = (shot: ViewOf) => getValue<PageView>(projectId(), key(shot));

/** True for a segment that films a webpage. */
export const isPageSegment = (seg: Segment) => seg.visual.type === "capture" && seg.visual.shot.model === "page";

/** Forgets a shot's view, because its latest run passed or showed no page. With `by`, only a view of that kind of run. */
export async function clearPageView(shot: ViewOf, by?: PageView["by"], io = storage) {
  const view = await pageView(shot);
  if (!view || (by && view.by !== by)) return;
  await deleteValue(projectId(), key(shot));
  if (view.picture) await io.deleteKey(view.picture).catch(() => {});
}

/** Keeps what the browser saw when a webpage shot failed, in place of the view of an earlier failure. */
export async function savePageView(shot: ViewOf, failure: Pick<PageView, "url" | "by" | "problem">, look: PageLook, io = storage) {
  const before = await pageView(shot);
  const { picture, ...seen } = look;
  const view: PageView = { ...failure, at: new Date().toISOString(), ...seen };
  if (picture) {
    // A new key for every picture, so a browser never shows an older one from its cache.
    const file = `episodes/${shot.postId}/page-views/${shot.segmentId}-${shot.format}-${Date.now().toString(36)}.jpg`;
    // The text and the problem still help when the storage is down.
    if (await io.putBuffer(file, picture).then(() => true, () => false)) view.picture = file;
  }
  await setValue(projectId(), key(shot), view);
  if (before?.picture) await io.deleteKey(before.picture).catch(() => {});
}
