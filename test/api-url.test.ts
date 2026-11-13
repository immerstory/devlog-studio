import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, setActiveProject } from "../web/api.js";

test("project routes go to the active project's API, global routes don't", () => {
  setActiveProject({ id: "p1", slug: "widget" });
  try {
    assert.equal(apiUrl("/api/source-files/preview"), "/api/projects/p1/source-files/preview");
    assert.equal(apiUrl("/api/source-files/sf-1/file?v=abc"), "/api/projects/p1/source-files/sf-1/file?v=abc");
    assert.equal(apiUrl("/api/materials"), "/api/projects/p1/materials");
    assert.equal(apiUrl("/api/jobs/j1"), "/api/jobs/j1");
  } finally {
    setActiveProject(undefined);
  }
});
