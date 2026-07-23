import assert from "node:assert/strict";
import test from "node:test";
import { promptReferenceVersionForAuthoring } from "./prompt-library-rail";

test("v2 prompt insertion pins the selected version", () => {
  assert.equal(promptReferenceVersionForAuthoring(true, 4, 7), 4);
  assert.equal(promptReferenceVersionForAuthoring(true, null, 7), 7);
});

test("v1 prompt insertion continues to follow latest", () => {
  assert.equal(promptReferenceVersionForAuthoring(false, 4, 7), "latest");
});
