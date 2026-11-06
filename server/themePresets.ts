import fs from "node:fs";
import path from "node:path";
import { projectId } from "./context.js";
import { config, saveConfig, type StudioConfig } from "./config.js";
import { extensionFolder } from "./extensions.js";
import { importBumperAudio } from "./bumperAudio.js";
import { storeThemeFile, type ThemeFileKind } from "./themeFiles.js";
import { bumperStyle, newBumperChoice, type BumperChoice, type BumperPlacement, type ThemeAsset } from "../shared/bumpers.js";
import type { PresetBumper, ThemePreset } from "../shared/extension.js";
import { installedExtensions } from "../video/extensions.js";

type Theme = StudioConfig["theme"];
type Store = (kind: ThemeFileKind, file: string, name: string) => Promise<ThemeAsset>;

/** A preset's file inside its extension's folder. Other paths are refused, because the path comes from extension code. */
export function presetFile(folder: string, relative: string): string {
  const file = path.resolve(folder, relative);
  const inside = path.relative(folder, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw Object.assign(new Error(`${relative} is outside the extension's folder.`), { status: 400 });
  if (!fs.existsSync(file)) throw Object.assign(new Error(`The extension has no file ${relative}.`), { status: 400 });
  return file;
}

/** The project's theme with a preset applied, plus the music files to import once the theme is saved. */
export async function resolvePreset(preset: ThemePreset, folder: string, theme: Theme, store: Store) {
  const upload = (kind: ThemeFileKind, relative: string) => store(kind, presetFile(folder, relative), path.basename(relative));
  const bumper = async (spec: PresetBumper): Promise<BumperChoice> => {
    if (!bumperStyle(spec.style)) throw Object.assign(new Error(`Bumper style ${spec.style} isn't installed.`), { status: 400 });
    const choice = newBumperChoice(spec.style);
    Object.assign(choice.params, spec.params);
    for (const [key, file] of Object.entries(spec.fonts ?? {})) choice.params[key] = await upload("font", file);
    return choice;
  };
  const next: Theme = { ...theme };
  if (preset.colors) next.colors = preset.colors;
  if (preset.displayFont) next.displayFont = await upload("font", preset.displayFont);
  if (preset.logo) next.logo = await upload("image", preset.logo);
  const music: Array<{ placement: BumperPlacement; file: string }> = [];
  for (const placement of ["intro", "outro"] as const) {
    const spec = preset[placement];
    if (!spec) continue;
    next[placement] = await bumper(spec);
    if (spec.music) music.push({ placement, file: presetFile(folder, spec.music) });
  }
  return { theme: next, music };
}

/** Applies a preset to the current project and saves it. Its files are stored like uploads. */
export async function applyThemePreset(extensionId: string, presetId: string): Promise<Theme> {
  const preset = installedExtensions().find((e) => e.id === extensionId)?.themePresets?.find((p) => p.id === presetId);
  const folder = extensionFolder(extensionId);
  if (!preset || !folder) throw Object.assign(new Error("This theme preset isn't installed."), { status: 404 });
  const pid = projectId();
  const { theme, music } = await resolvePreset(preset, folder, config().theme, (kind, file, name) => storeThemeFile(pid, kind, file, name));
  await saveConfig({ ...config(), theme });
  for (const { placement, file } of music) await importBumperAudio(placement, file, path.basename(file));
  return config().theme;
}
