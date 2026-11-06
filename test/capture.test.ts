import { test } from "node:test";
import assert from "node:assert/strict";
import { withResourceLock } from "../server/capture/provider.js";
import { unityProvider } from "../server/capture/unity/index.js";
import { scriptSchema } from "../server/agent.js";

test("capture resources serialize across targets and browsing, releasing after errors", async () => {
  const config = { url: "http://localhost:8080/mcp/", headerHelper: "", headerHelperArgs: [], projectPath: "one" };
  const other = { ...config, url: "http://127.0.0.1:8080/mcp", projectPath: "two" };
  const key = unityProvider.resourceKey(config);
  assert.equal(key, unityProvider.resourceKey(other));
  const events: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const capture = withResourceLock(key, async () => { events.push("capture-start"); await waiting; events.push("capture-end"); throw new Error("capture failed"); });
  const browsing = withResourceLock(key, async () => { events.push("browse"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["capture-start"]);
  await withResourceLock("another-editor", async () => { events.push("independent"); });
  release();
  await assert.rejects(capture, /capture failed/); await browsing;
  assert.deepEqual(events, ["capture-start", "independent", "capture-end", "browse"]);
});

test("script schema offers capture only for configured targets", () => {
  const schema = scriptSchema([]);
  assert.deepEqual(schema.properties.segments.items.properties.visual.properties.type.enum, ["material", "slide"]);
});
