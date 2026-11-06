/**
 * The contract between Devlog Studio and an extension. An extension is a folder with an `index.ts` whose default
 * export is a `DevlogExtension`. The file runs on the server and in the browser, so it uses no Node.js APIs and
 * imports from Devlog Studio only with `import type`.
 */
import type { BumperStyle } from "./bumpers";
import type { ThemeColors } from "./types";
import type { BumperAnimation, BumperSetup } from "../video/bumpers";
import type { Ctx, Platform } from "../video/platform";

export type { BumperAnimation, BumperSetup, BumperStyle, Ctx, Platform, ThemeColors };

/** A bumper style with its animation. Style IDs are unique across all extensions. */
export interface ExtensionBumper extends BumperStyle {
  animation: BumperAnimation;
}

/** A bumper in a theme preset. File paths are relative to the extension's folder. */
export interface PresetBumper {
  style: string;
  /** Values of the style's text and number parameters. */
  params?: Record<string, unknown>;
  /** Font files, by the key of the style's font parameter. */
  fonts?: Record<string, string>;
  /** A music file. It is imported like an upload in the project's theme settings. */
  music?: string;
}

/** A theme a project can apply in one step. It replaces what it defines and keeps the rest of the project's theme. */
export interface ThemePreset {
  id: string;
  label: string;
  description?: string;
  colors?: Partial<ThemeColors>;
  /** A font file, relative to the extension's folder. */
  displayFont?: string;
  /** An image file, relative to the extension's folder. */
  logo?: string;
  intro?: PresetBumper;
  outro?: PresetBumper;
}

export interface DevlogExtension {
  /** Unique across all extensions. */
  id: string;
  name: string;
  bumpers?: ExtensionBumper[];
  themePresets?: ThemePreset[];
}
