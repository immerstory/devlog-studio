import type { Format, PageStep, PageView, Post } from "../../../shared/types.js";
import { projectId } from "../../context.js";
import { getValue, newId, pageViewsOf, replaceValue, takeValues } from "../../store.js";
import { deleteKey, putBuffer } from "../../storage.js";
import type { PageTrace } from "./trace.js";

/** The webpage shot a view belongs to. */
export interface ViewOf { postId: string; format: Format; segmentId: string }

/** Where the pictures of views are kept. */
export interface ViewIO { putBuffer(key: string, body: Buffer): Promise<void>; deleteKey(key: string): Promise<void> }
const storage: ViewIO = { putBuffer, deleteKey };

/** Long enough for an article, short enough to store with every step. */
const MAX_TEXT = 20_000;
const shorten = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** What the browser saw when a webpage shot last failed or was previewed. */
export const pageView = (shot: ViewOf) => getValue<PageView>(projectId(), pageViewsOf(shot.postId, shot.format) + shot.segmentId);

/** A view without its texts, for lists of views. */
export const viewSummary = ({ text: _text, steps, ...view }: PageView): PageView => ({ ...view, ...(steps ? { steps: steps.map(({ text: _stepText, ...step }) => step) } : {}) });

async function removePictures(views: Array<PageView | undefined>, io: ViewIO) {
  const pictures = new Set(views.flatMap((view) => [view?.picture, ...(view?.steps ?? []).map((s) => s.picture)]));
  for (const picture of pictures) if (picture) await io.deleteKey(picture).catch(() => {});
}

/**
 * Removes the views of a post's format that `gone` accepts. Several tasks of a post can change its views at once: the
 * stored view decides, not one read before, and whoever takes a view out of the database deletes its pictures.
 */
export async function dropPageViews(postId: string, format: Format, gone: (view: PageView, segmentId: string) => boolean, io = storage) {
  await removePictures(await takeValues<PageView>(projectId(), pageViewsOf(postId, format), gone), io);
}

/** Removes the views of a post's format whose shot, in the post as it is then, isn't at the view's address. `addresses` gives the shots' addresses by segment. */
export async function pruneViews(postId: string, format: Format, addresses: (post: Post) => Map<string, string>, io = storage) {
  await removePictures(await takeValues<PageView>(projectId(), pageViewsOf(postId, format), (view, segmentId, post) => addresses(post!).get(segmentId) !== view.url, postId), io);
}

/** Forgets a shot's view. A view that `only` doesn't accept stays. */
export const clearPageView = (shot: ViewOf, only: (view: PageView) => boolean = () => true, io = storage) =>
  dropPageViews(shot.postId, shot.format, (view, segmentId) => segmentId === shot.segmentId && only(view), io);

/** Keeps what the browser saw in a run of a webpage shot, in place of an earlier view. A run that showed no page keeps nothing. */
export async function savePageView(shot: ViewOf, run: Pick<PageView, "url" | "by" | "problem">, trace: PageTrace, io = storage) {
  if (!trace.steps.length) return clearPageView(shot, undefined, io);
  // A new key for every picture, so a browser never shows an older one from its cache and no two tasks share one.
  const keys = `episodes/${shot.postId}/page-views/${shot.segmentId}-${shot.format}-${newId("view")}`;
  const steps: PageStep[] = [];
  for (const [i, { picture, text, ...step }] of trace.steps.entries()) {
    const file = `${keys}-${i}.jpg`;
    // The text and the notes still help when the storage is down.
    const kept = picture ? await io.putBuffer(file, picture).then(() => true, () => false) : false;
    steps.push({ ...step, text: shorten(text), ...(kept ? { picture: file } : {}) });
  }
  const { pageUrl, title, picture } = steps.at(-1)!;
  const view: PageView = { ...run, at: new Date().toISOString(), steps, pageUrl, title, ...(picture ? { picture } : {}) };
  try {
    await removePictures([await replaceValue(projectId(), pageViewsOf(shot.postId, shot.format) + shot.segmentId, view)], io);
  } catch (err) {
    await removePictures([view], io);
    throw err;
  }
}
