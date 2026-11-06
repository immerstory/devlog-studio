import type { DevlogExtension } from "../shared/extension";
import { BUMPER_STYLES } from "../shared/bumpers";
import { BUMPER_ANIMATIONS } from "./bumpers";
import titleCard from "../examples/title-card/index";

const installed = new Map<string, DevlogExtension>();

/** Adds an extension's bumper styles. Installing the same extension ID again replaces the earlier one. */
export function installExtension(extension: DevlogExtension) {
  if (!extension?.id || !extension.name) throw new Error("An extension needs an id and a name.");
  const previous = new Set((installed.get(extension.id)?.bumpers ?? []).map((b) => b.id));
  for (const bumper of extension.bumpers ?? []) {
    if (BUMPER_STYLES.some((s) => s.id === bumper.id) && !previous.has(bumper.id)) throw new Error(`Extension ${extension.id}: bumper style ${bumper.id} already exists.`);
  }
  for (const id of previous) {
    BUMPER_STYLES.splice(BUMPER_STYLES.findIndex((s) => s.id === id), 1);
    delete BUMPER_ANIMATIONS[id];
  }
  for (const { animation, ...style } of extension.bumpers ?? []) {
    BUMPER_STYLES.push(style);
    BUMPER_ANIMATIONS[style.id] = animation;
  }
  installed.set(extension.id, extension);
}

export const installedExtensions = () => [...installed.values()];

installExtension(titleCard);
