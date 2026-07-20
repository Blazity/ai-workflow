import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrayToLines,
  linesToArray,
  textMatchesLines,
  toggleRequiredArrayValue,
} from "./params.ts";

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

test("textMatchesLines matches text that parses to the value", () => {
  assert.equal(textMatchesLines("pnpm test\npnpm lint", ["pnpm test", "pnpm lint"]), true);
});

test("textMatchesLines ignores whitespace the parse drops", () => {
  assert.equal(textMatchesLines("pnpm test\n", ["pnpm test"]), true);
  assert.equal(textMatchesLines("pnpm test\n\npnpm lint", ["pnpm test", "pnpm lint"]), true);
  assert.equal(textMatchesLines("  pnpm test  ", ["pnpm test"]), true);
});

test("textMatchesLines rejects text whose content differs from the value", () => {
  assert.equal(textMatchesLines("pnpm test", ["pnpm build"]), false);
  assert.equal(textMatchesLines("pnpm test", ["pnpm test", "pnpm lint"]), false);
  assert.equal(textMatchesLines("pnpm test\npnpm lint", ["pnpm lint", "pnpm test"]), false);
});

test("textMatchesLines treats a non-array value as no lines", () => {
  assert.equal(textMatchesLines("", undefined), true);
  assert.equal(textMatchesLines("   \n", undefined), true);
  assert.equal(textMatchesLines("pnpm test", undefined), false);
  assert.equal(textMatchesLines("", "nope"), true);
});

test("textMatchesLines ignores non-string entries in the value", () => {
  assert.equal(textMatchesLines("pnpm test", ["pnpm test", 3] as never), true);
});

test("toggleRequiredArrayValue adds and removes values without allowing an empty selection", () => {
  assert.deepEqual(toggleRequiredArrayValue(["github"], "gitlab", true), ["github", "gitlab"]);
  assert.deepEqual(toggleRequiredArrayValue(["github", "gitlab"], "github", false), ["gitlab"]);
  assert.deepEqual(toggleRequiredArrayValue(["github"], "github", false), ["github"]);
});
