import { test } from "node:test";
import assert from "node:assert/strict";
import { fnv1a } from "./hash.ts";

test("hashing the same text twice is stable", () => {
  assert.equal(fnv1a("hello world"), fnv1a("hello world"));
});

test("different text diverges", () => {
  assert.notEqual(fnv1a("hello"), fnv1a("world"));
});

test("a one-character change diverges", () => {
  assert.notEqual(fnv1a("prompt body"), fnv1a("prompt bodx"));
});

test("output is lowercase hex", () => {
  assert.match(fnv1a("Some Mixed Case TEXT 123"), /^[0-9a-f]+$/);
});

test("empty string hashes to the 32-bit FNV offset basis", () => {
  assert.equal(fnv1a(""), "811c9dc5");
});

test("single 'a' matches the canonical FNV-1a value", () => {
  assert.equal(fnv1a("a"), "e40c292c");
});
