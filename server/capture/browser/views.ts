import type { Format, PageView, Segment } from "../../../shared/types.js";
import { projectId } from "../../context.js";
import { getValue, newId, pageViewsOf, replaceValue, takeValues } from "../../store.js";
import { deleteKey, putBuffer } from "../../storage.js";
import type { PageLook } from "./look.js";

/** The webpage shot a view belongs to. */
export interface ViewOf { postId: string; format: Format; segmentId: string }

/** Where the pictures of views are kept. */
export interface ViewIO { putBuffer(key: string, body: Buffer): Promise<void>; deleteKey(key: string): Promise<void> }
const storage: ViewIO = { putBuffer, deleteKey };

/** What the browser saw at a webpage shot's latest failure. */
export const pageView = (shot: ViewOf) => getValue<PageView>(projectId(), pageViewsOf(shot.postId, shot.format) + shot.segmentId);

/** True for a segment that films a webpage. */
export const isPageSegment = (seg: Segment) => seg.visual.type === "capture" && seg.visual.shot.model === "page";

async function removePictures(views: Array<PageView | undefined>, io: ViewIO) {
  for (const view of views) if (view?.picture) await io.deleteKey(view.picture).catch(() => {});
}

/**
 * Removes the views of a post's format that `gone` accepts. Several tasks of a post can change its views at once: the
 * stored view decides, not one read before, and whoever takes a view out of the database deletes its picture.
 */
export async function dropPageViews(postId: string, format: Format, gone: (view: PageView, segmentId: string) => boolean, io = storage) {
  await removePictures(await takeValues<PageView>(projectId(), pageViewsOf(postId, format), gone), io);
}

/** Forgets a shot's view, because its latest run passed or showed no page. A view that `only` doesn't accept stays. */
export const clearPageView = (shot: ViewOf, only: (view: PageView) => boolean = () => true, io = storage) =>
  dropPageViews(shot.postId, shot.format, (view, segmentId) => segmentId === shot.segmentId && only(view), io);

/** Keeps what the browser saw when a webpage shot failed, in place of the view of an earlier failure. */
export async function savePageView(shot: ViewOf, failure: Pick<PageView, "url" | "by" | "problem">, look: PageLook, io = storage) {
  const { picture, ...seen } = look;
  const view: PageView = { ...failure, at: new Date().toISOString(), ...seen };
  if (picture) {
    // A new key for every picture, so a browser never shows an older one from its cache and no two tasks share one.
    const file = `episodes/${shot.postId}/page-views/${shot.segmentId}-${shot.format}-${newId("view")}.jpg`;
    // The text and the problem still help when the storage is down.
    if (await io.putBuffer(file, picture).then(() => true, () => false)) view.picture = file;
  }
  try {
    await removePictures([await replaceValue(projectId(), pageViewsOf(shot.postId, shot.format) + shot.segmentId, view)], io);
  } catch (err) {
    await removePictures([view], io);
    throw err;
  }
}
