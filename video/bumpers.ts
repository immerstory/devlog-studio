import type { BumperPlacement } from "../shared/bumpers";
import type { Ctx, Platform } from "./platform";

/** What a bumper gets when a video is prepared. Font parameters arrive as URLs. */
export interface BumperSetup {
  platform: Platform;
  params: Record<string, unknown>;
  placement: BumperPlacement;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  portrait: boolean;
  /** The project's public title, for styles that show it by default. */
  title: string;
}

/**
 * The animation of a bumper style. `prepare` loads fonts and files, then returns a function that draws one
 * frame on a transparent canvas of the video's full size. Frames can arrive in any order.
 */
export interface BumperAnimation {
  prepare(setup: BumperSetup): Promise<(ctx: Ctx, frame: number) => void>;
}

/** Animation of each style in shared/bumpers.ts, by style ID. */
export const BUMPER_ANIMATIONS: Record<string, BumperAnimation> = {};
