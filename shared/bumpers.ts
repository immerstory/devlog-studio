/**
 * Bumpers: short title sequences a project can play as its intro, its outro, or both.
 * This file holds what the server and the editor need (styles, parameters, lengths);
 * video/bumpers.ts maps each style to its animation, and extensions add both.
 */

/** A file uploaded to Garage for a theme: the display font, the logo or a bumper font. */
export interface ThemeAsset {
  key: string;
  /** Original file name, for display. */
  name: string;
}

export type BumperPlacement = "intro" | "outro";

/** Music for a bumper, stored in Garage. */
export interface BumperAudio {
  key: string;
  sourceName: string;
  durationSeconds: number;
  /** Outro only: how long the music starts before the bumper. */
  leadSeconds: number;
}

/** A project's choice for one placement. No choice means no bumper there. */
export interface BumperChoice {
  style: string;
  params: Record<string, unknown>;
  audio?: BumperAudio;
}

export type BumperParam =
  | { key: string; label: string; type: "text" | "multiline"; default: string; help?: string }
  | { key: string; label: string; type: "number"; default: number; min?: number; max?: number; step?: number; help?: string }
  | { key: string; label: string; type: "font"; help?: string };

export interface BumperStyle {
  id: string;
  label: string;
  description: string;
  params: BumperParam[];
  /** Length in seconds for the given parameters, defaults filled in. */
  seconds(params: Record<string, unknown>): number;
}

/** Every style in use: the built-in example and those of installed extensions (see video/extensions.ts). */
export const BUMPER_STYLES: BumperStyle[] = [];

export const bumperStyle = (id?: string) => BUMPER_STYLES.find((s) => s.id === id);

/** The choice's parameters with defaults for missing values; undefined for an unknown style. */
export function bumperParams(choice?: BumperChoice): Record<string, unknown> | undefined {
  const style = bumperStyle(choice?.style);
  if (!style || !choice) return undefined;
  const out: Record<string, unknown> = {};
  for (const p of style.params) out[p.key] = choice.params?.[p.key] ?? ("default" in p ? p.default : undefined);
  return out;
}

/** Length of a bumper in seconds; 0 without a bumper or with an unknown style. */
export function bumperSeconds(choice?: BumperChoice): number {
  const params = bumperParams(choice);
  return params ? bumperStyle(choice!.style)!.seconds(params) : 0;
}

/** A new choice of a style with its default parameters. */
export function newBumperChoice(styleId: string): BumperChoice {
  const style = bumperStyle(styleId)!;
  return { style: style.id, params: Object.fromEntries(style.params.filter((p) => "default" in p).map((p) => [p.key, (p as { default: unknown }).default])) };
}
