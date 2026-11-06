import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { BUMPER_STYLES, bumperParams, bumperSeconds, bumperStyle, newBumperChoice } from "../shared/bumpers.js";
import type { DevlogExtension, ThemePreset } from "../shared/extension.js";
import { BUMPER_ANIMATIONS, type BumperSetup } from "../video/bumpers.js";
import { installExtension, installedExtensions } from "../video/extensions.js";
import { extensionEntries, extensionRoots } from "../server/extensionPaths.js";
import { presetFile, resolvePreset } from "../server/themePresets.js";

const cardSeconds = (hold: number) => 1 + hold;

test("bumper length follows its parameters, and no choice or an unknown style has none", () => {
  assert.equal(bumperSeconds(undefined), 0);
  assert.equal(bumperSeconds({ style: "missing", params: {} }), 0);
  assert.equal(bumperSeconds({ style: "title-card", params: {} }), cardSeconds(2), "missing hold uses the default");
  assert.equal(bumperSeconds({ style: "title-card", params: { holdSeconds: 0.5 } }), cardSeconds(0.5));
  assert.equal(bumperSeconds({ style: "title-card", params: { holdSeconds: -3 } }), cardSeconds(0));
});

test("a new bumper choice carries the style's defaults", () => {
  const choice = newBumperChoice("title-card");
  assert.deepEqual(choice, { style: "title-card", params: { text: "", holdSeconds: 2 } });
  assert.deepEqual(bumperParams(choice), { text: "", font: undefined, holdSeconds: 2 });
});

const stubBumper = (id: string) => ({ id, label: id, description: "", params: [], seconds: () => 1, animation: { prepare: async () => () => {} } });

test("an extension adds its bumpers, can be installed again, and can't take another's style", () => {
  const first: DevlogExtension = { id: "test-one", name: "One", bumpers: [stubBumper("test-style")] };
  installExtension(first);
  assert.ok(bumperStyle("test-style"));
  assert.ok(BUMPER_ANIMATIONS["test-style"]);
  installExtension({ ...first, bumpers: [stubBumper("test-style")] });
  assert.equal(BUMPER_STYLES.filter((s) => s.id === "test-style").length, 1);
  assert.throws(() => installExtension({ id: "test-two", name: "Two", bumpers: [stubBumper("test-style")] }), /already exists/);
  assert.throws(() => installExtension({ id: "", name: "" }), /needs an id/);
  installExtension({ id: "test-one", name: "One" });
  assert.equal(bumperStyle("test-style"), undefined, "reinstalling without the style removes it");
  assert.ok(installedExtensions().some((e) => e.id === "title-card"), "the example is built in");
});

test("the title card covers the picture, and only an intro uncovers it at the end", async () => {
  const setup = { platform: {}, params: { text: "Hello" }, durationInFrames: 90, fps: 30, width: 320, height: 180, portrait: false, title: "Fallback" };
  const alphaAt = async (placement: "intro" | "outro", frame: number) => {
    const draw = await BUMPER_ANIMATIONS["title-card"].prepare({ ...setup, placement } as unknown as BumperSetup);
    const canvas = createCanvas(320, 180);
    const ctx = canvas.getContext("2d");
    draw(ctx as unknown as CanvasRenderingContext2D, frame);
    return ctx.getImageData(2, 2, 1, 1).data[3];
  };
  assert.equal(await alphaAt("intro", 0), 255);
  assert.equal(await alphaAt("intro", 90), 0);
  assert.equal(await alphaAt("outro", 0), 0);
  assert.equal(await alphaAt("outro", 90), 255);
});

test("extensions are the subfolders with an index.ts, in every listed folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-extensions-"));
  try {
    for (const [dir, file] of [["a/one", "index.ts"], ["a/no-entry", "readme.md"], ["b/two", "index.ts"]]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, file), "");
    }
    fs.writeFileSync(path.join(root, "a", "loose.ts"), "");
    const value = ["a", "b", "missing"].join(path.delimiter);
    assert.deepEqual(extensionRoots(root, value), ["a", "b", "missing"].map((d) => path.join(root, d)));
    assert.deepEqual(extensionEntries(root, value).map((e) => path.relative(root, e.dir)), [path.join("a", "one"), path.join("b", "two")]);
    assert.deepEqual(extensionRoots(root, ""), [path.join(root, "extensions")], "the drop folder is the default");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a theme preset stores its files, keeps the rest of the theme and stays inside its folder", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-preset-"));
  try {
    for (const file of ["brand.ttf", "title.otf", "logo.png", "outro.wav"]) fs.writeFileSync(path.join(folder, file), "x");
    const preset: ThemePreset = {
      id: "p", label: "P", colors: { ink: "#000000" }, displayFont: "brand.ttf", logo: "logo.png",
      outro: { style: "title-card", params: { text: "THE END" }, fonts: { font: "title.otf" }, music: "outro.wav" },
    };
    const stored: string[] = [];
    const { theme, music } = await resolvePreset(preset, folder, { backgroundMaterialIds: ["keep"], intro: { style: "title-card", params: {} } }, async (kind, _file, name) => {
      stored.push(`${kind}:${name}`);
      return { key: `k/${name}`, name };
    });
    assert.deepEqual(stored, ["font:brand.ttf", "image:logo.png", "font:title.otf"]);
    assert.deepEqual(theme.backgroundMaterialIds, ["keep"]);
    assert.deepEqual(theme.intro, { style: "title-card", params: {} }, "what the preset doesn't define stays");
    assert.deepEqual(theme.outro, { style: "title-card", params: { text: "THE END", holdSeconds: 2, font: { key: "k/title.otf", name: "title.otf" } } });
    assert.deepEqual(music, [{ placement: "outro", file: path.join(folder, "outro.wav") }]);
    assert.throws(() => presetFile(folder, "../outside.ttf"), /outside/);
    assert.throws(() => presetFile(folder, "missing.ttf"), /no file/);
    await assert.rejects(resolvePreset({ id: "x", label: "X", intro: { style: "not-installed" } }, folder, { backgroundMaterialIds: [] }, async () => ({ key: "", name: "" })), /isn't installed/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
