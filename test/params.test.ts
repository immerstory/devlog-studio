import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFormat, formatParam } from "../server/params.js";

test("a route with an unknown format is a bad request, and one without a format passes", () => {
  assert.equal(formatParam("portrait"), "portrait");
  for (const value of ["square", "", undefined]) assert.throws(() => formatParam(value), { status: 400 });
  assert.throws(() => checkFormat({ id: "post", format: "square" }), { status: 400, message: "Unknown format square" });
  checkFormat({ id: "post", format: "landscape" });
  checkFormat({ id: "post" });
});
