import type { CDPSession, Page } from "puppeteer-core";
import type { PageShot, PageStep, PageStepName } from "../../../shared/types.js";
import { inTime, lookAt, type PageLook } from "./look.js";
import { readable } from "./verify.js";

/** Notes walk through the whole page, which takes longer on a large one. */
const NOTES_MS = 2000;

/** A step of a run, with its picture still in memory. */
export type TracedStep = Omit<PageStep, "picture" | "text"> & PageLook;

/** Records what the browser shows at each step of a run. A page that is opened again starts its trace over. */
export class PageTrace {
  steps: TracedStep[] = [];
  /** The address the shot asks for. */
  url = "";
  /** A page that produces no picture in time would hold up every later step, so the steps after it go without one. */
  private pictures = true;
  /** A page that doesn't answer at all isn't asked again until the run fails. */
  private hangs = false;

  constructor(private shot: Pick<PageShot, "expect" | "highlight">) {}

  start() {
    this.steps = [];
    this.pictures = true;
    this.hangs = false;
  }

  add(name: PageStepName, look: PageLook, notes: string[] = []) {
    const expect = this.shot.expect?.trim();
    const highlight = this.shot.highlight?.trim();
    const shows = (text: string, part: string) => readable(text).includes(readable(part));
    this.steps.push({
      name,
      notes,
      ...look,
      ...(expect ? { found: shows(`${look.title}\n${look.text}`, expect) } : {}),
      ...(highlight ? { highlightFound: shows(look.text, highlight) } : {}),
    });
  }

  async step(page: Page, name: PageStepName, notes: string[] = []) {
    if (this.hangs) return;
    const look = await lookAt(page, undefined, this.pictures);
    if (!look) { this.hangs = true; return; }
    if (!look.picture) this.pictures = false;
    this.add(name, look, notes);
  }

  /** Notes about the page, or none when it doesn't answer soon. */
  async notes(ask: () => Promise<string[]>): Promise<string[]> {
    return (!this.hangs && (await inTime(ask(), Date.now() + NOTES_MS))) || [];
  }

  /** The moment a run failed. The run shows nothing when the page didn't load. */
  async fail(page: Page | undefined, pausedClock?: CDPSession) {
    const look = page && (await lookAt(page, pausedClock));
    if (look) this.add("failed", look);
  }

  get failed() {
    return this.steps.at(-1)?.name === "failed";
  }
}
