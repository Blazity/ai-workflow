import { test } from "node:test";
import assert from "node:assert/strict";
import { arrayToLines, linesToArray } from "./params.ts";

test("linesToArray trims and drops blank lines", () => {
  assert.deepEqual(linesToArray("  pnpm test \n\n  pnpm lint\n"), ["pnpm test", "pnpm lint"]);
});

test("linesToArray returns an empty array for blank input", () => {
  assert.deepEqual(linesToArray("   \n\n"), []);
});

test("arrayToLines joins an array with newlines", () => {
  assert.equal(arrayToLines(["a", "b"]), "a\nb");
});

test("arrayToLines returns an empty string for non-array values", () => {
  assert.equal(arrayToLines(undefined), "");
  assert.equal(arrayToLines("nope"), "");
  assert.equal(arrayToLines(3), "");
});
