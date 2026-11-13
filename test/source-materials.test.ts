import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFile, parseMetadata, patternValues, ruleMatches, withEdits } from "../server/sourceMaterials.js";
import { readMaterialRules, type MaterialRule } from "../shared/projects.js";
import type { Material } from "../shared/types.js";

const rule = (extra: Partial<MaterialRule> = {}): MaterialRule => ({ id: "rule-1", include: ["releases/**"], ...extra });

test("a rule matches images and videos of its include globs and leaves out its exclude globs", () => {
  const r = rule({ exclude: ["**/drafts/**"] });
  assert.equal(ruleMatches(r, "releases/0.3/forest.png"), true);
  assert.equal(ruleMatches(r, "releases/0.3/flyover.mp4"), true);
  assert.equal(ruleMatches(r, "releases/0.3/materials.json"), false, "only images and videos");
  assert.equal(ruleMatches(r, "releases/0.3/drafts/forest.png"), false);
  assert.equal(ruleMatches(r, "other/forest.png"), false);
  assert.equal(ruleMatches(rule({ include: [] }), "releases/0.3/forest.png"), false, "a rule without include globs imports nothing");
});

test("a path pattern takes values from the end of the path", () => {
  assert.deepEqual(patternValues("releases/{release}/{name}.{ext}", "media/releases/0.3/forest-at-dawn.png"), { release: "0.3", name: "forest-at-dawn", ext: "png" });
  assert.deepEqual(patternValues("{release}/{num}-{name}.{ext}", "0.3/05-forest.png"), { release: "0.3", num: "05", name: "forest", ext: "png" });
  assert.equal(patternValues("releases/{release}/{name}.{ext}", "other/0.3/forest.png"), null);
  assert.deepEqual(patternValues("shots (v1)/{name}.png", "shots (v1)/a.png"), { name: "a" }, "other characters are literal");
  assert.deepEqual(patternValues("{name}.{ext}", "releases/menu v1.2.png"), { name: "menu v1.2", ext: "png" }, "a name can have dots, an extension can't");
});

test("without metadata, the title comes from the file name and tags from the pattern", () => {
  const d = describeFile(rule({ pattern: "releases/{release}/{_kind}-{name}.{ext}" }), "releases/0.3/hero-forest_at-dawn.png");
  assert.deepEqual(d, { fields: { title: "forest at dawn", annotation: "", tags: ["0.3"], group: undefined }, date: undefined, commit: undefined });
  assert.equal(describeFile(rule(), "releases/0.3/forest.png")?.fields.title, "forest");
});

test("a file's metadata wins over its folder's, and the tags of both are combined", () => {
  const meta = parseMetadata(JSON.stringify({
    version: 1,
    folder: { annotation: "Release 0.3.", tags: ["release"], group: "Release 0.3", commit: "a1b2c3d" },
    files: { "forest.png": { title: "Forest at dawn", tags: ["lighting", "release"], date: "2026-03-01" }, "old.png": { exclude: true } },
  }));
  const d = describeFile(rule({ pattern: "releases/{release}/{name}.{ext}" }), "releases/0.3/forest.png", meta);
  assert.deepEqual(d, { fields: { title: "Forest at dawn", annotation: "Release 0.3.", tags: ["0.3", "release", "lighting"], group: "Release 0.3" }, date: "2026-03-01", commit: undefined });
  assert.deepEqual(describeFile(rule(), "releases/0.3/lake.png", meta)?.commit, "a1b2c3d", "an unlisted file takes the folder's commit");
  assert.equal(describeFile(rule(), "releases/0.3/old.png", meta), null);
  assert.equal(describeFile(rule({ listedOnly: true }), "releases/0.3/lake.png", meta), null);
  assert.equal(describeFile(rule({ listedOnly: true }), "releases/0.3/lake.png"), null, "without a metadata file, nothing is listed");
});

test("the date comes from the file's date or commit, then the folder's date or commit", () => {
  const at = (folder: object, file: object) => {
    const d = describeFile(rule(), "releases/a.png", parseMetadata(JSON.stringify({ folder, files: { "a.png": file } })));
    return { date: d?.date, commit: d?.commit };
  };
  assert.deepEqual(at({ date: "2026-01-01", commit: "aaaa" }, { commit: "bbbb" }), { date: undefined, commit: "bbbb" });
  assert.deepEqual(at({ date: "2026-01-01", commit: "aaaa" }, {}), { date: "2026-01-01", commit: undefined });
  assert.deepEqual(at({ commit: "aaaa" }, {}), { date: undefined, commit: "aaaa" });
  assert.deepEqual(at({ commit: "aaaa" }, { date: "2026-02-02" }), { date: "2026-02-02", commit: undefined });
});

test("a metadata file must be valid JSON in the format, and other keys are ignored", () => {
  assert.throws(() => parseMetadata("{"), /not valid JSON/);
  assert.throws(() => parseMetadata(JSON.stringify({ folder: { date: "March" } })), /folder\.date is not a YYYY-MM-DD date/);
  assert.throws(() => parseMetadata(JSON.stringify({ files: { "a.png": { tags: "one" } } })), /files\.a\.png\.tags/);
  assert.deepEqual(parseMetadata(JSON.stringify({ format: "other", folder: { tags: ["x"] } })), { folder: { tags: ["x"] } });
});

test("edits to an imported material are remembered, and uploaded materials don't change", () => {
  const imported = { id: "mat-1", title: "forest", annotation: "", tags: ["0.3"], date: "2026-03-01", origin: { sourceId: "s", ruleId: "r", path: "a.png", blob: "b", values: "v", edited: ["date"] } } as unknown as Material;
  assert.deepEqual(withEdits(imported, { ...imported, title: "Forest at dawn", tags: ["0.3"] }).origin?.edited, ["date", "title"]);
  assert.equal(withEdits(imported, { ...imported }).origin?.edited?.length, 1);
  const uploaded = { ...imported, origin: undefined };
  assert.equal(withEdits(uploaded, { ...uploaded, title: "x" }).origin, undefined);
});

test("material rules from settings or a request keep only the fields a rule has", () => {
  assert.deepEqual(readMaterialRules([
    { id: "r1", include: ["a/**", " ", 3], exclude: [], pattern: " {name}.{ext} ", metadataFile: "", listedOnly: "yes", extra: 1 },
    { include: ["b"] },
    null,
  ]), [{ id: "r1", include: ["a/**"], pattern: "{name}.{ext}", metadataFile: "" }]);
  assert.deepEqual(readMaterialRules("nope"), []);
});
