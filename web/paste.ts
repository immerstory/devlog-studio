/** Marks an upload form, so a paste can find the form it belongs to. */
export const UPLOAD_FORM_ATTRIBUTE = "data-upload-form";

const pad = (n: number) => String(n).padStart(2, "0");

/** Whether an upload form accepts this file. */
export const isMedia = (file: { type: string; name: string }) => /^(image|video)\//.test(file.type) || /\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv)$/i.test(file.name);

/**
 * The images and videos from a clipboard. Browsers call a pasted screenshot `image.png`, and the file name is the default title,
 * so such a file gets the time of the paste as its name. A file copied from a folder keeps its name.
 */
export function pastedMedia(files: File[], now: Date): File[] {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return files.filter(isMedia).map((file) => {
    if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
    const extension = file.name.match(/\.\w+$/)?.[0] ?? `.${file.type.split("/")[1] ?? "png"}`;
    return new File([file], `Pasted ${stamp}${extension}`, { type: file.type, lastModified: file.lastModified });
  });
}

const isShown = (element: Element) => element.getClientRects().length > 0;

const inViewport = (element: Element) => {
  const { top, bottom } = element.getBoundingClientRect();
  return bottom > 0 && top < window.innerHeight;
};

/**
 * The upload form that takes a paste, so that one paste adds its files once. An open dialog hides the forms behind it.
 * Of the forms in the viewport, the one with the focus wins, then the one under the pointer, then the first.
 * With none in the viewport, the first form on the page takes it.
 */
export function pasteTarget(): Element | null {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  const scope = dialogs[dialogs.length - 1] ?? document;
  const forms = [...scope.querySelectorAll(`[${UPLOAD_FORM_ATTRIBUTE}]`)].filter(isShown);
  const seen = forms.filter(inViewport);
  return seen.find((form) => form.contains(document.activeElement)) ?? seen.find((form) => form.matches(":hover")) ?? seen[0] ?? forms[0] ?? null;
}
