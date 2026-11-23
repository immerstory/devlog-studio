import type { Format, PageStep, PageView } from "../../../shared/types.js";
import { projectId } from "../../context.js";
import { deleteValue, getValue, pageViewKey, setValue } from "../../store.js";
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

const key = (shot: ViewOf) => pageViewKey(shot.postId, shot.format, shot.segmentId);

/** What the browser saw when a webpage shot last failed or was previewed. */
export const pageView = (shot: ViewOf) => getValue<PageView>(projectId(), key(shot));

/** A view without the text of its steps, for lists of views. */
export const viewSummary = (view: PageView): PageView => ({ ...view, ...(view.steps ? { steps: view.steps.map(({ text: _text, ...step }) => step) } : {}) });

const picturesOf = (view?: PageView) => new Set([view?.picture, ...(view?.steps ?? []).map((s) => s.picture)].filter((p): p is string => !!p));

async function removePictures(view: PageView | undefined, io: ViewIO) {
  for (const picture of picturesOf(view)) await io.deleteKey(picture).catch(() => {});
}

/** Forgets a shot's view. With `only`, a view that it doesn't accept stays. */
export async function clearPageView(shot: ViewOf, only: (view: PageView) => boolean = () => true, io = storage) {
  const view = await pageView(shot);
  if (!view || !only(view)) return;
  await deleteValue(projectId(), key(shot));
  await removePictures(view, io);
}

/** Keeps what the browser saw in a run of a webpage shot, in place of an earlier view. A run that showed no page keeps nothing. */
export async function savePageView(shot: ViewOf, run: Pick<PageView, "url" | "by" | "problem">, trace: PageTrace, io = storage) {
  const before = await pageView(shot);
  if (!trace.steps.length) return clearPageView(shot, undefined, io);
  const at = new Date();
  const steps: PageStep[] = [];
  for (const [i, { picture, text, ...step }] of trace.steps.entries()) {
    // A new key for every picture, so a browser never shows an older one from its cache.
    const file = `episodes/${shot.postId}/page-views/${shot.segmentId}-${shot.format}-${at.getTime().toString(36)}-${i}.jpg`;
    // The text and the notes still help when the storage is down.
    const kept = picture ? await io.putBuffer(file, picture).then(() => true, () => false) : false;
    steps.push({ ...step, text: shorten(text), ...(kept ? { picture: file } : {}) });
  }
  const { pageUrl, title, text, picture } = steps.at(-1)!;
  await setValue(projectId(), key(shot), { ...run, at: at.toISOString(), steps, pageUrl, title, text: text ?? "", ...(picture ? { picture } : {}) } satisfies PageView);
  await removePictures(before, io);
}
