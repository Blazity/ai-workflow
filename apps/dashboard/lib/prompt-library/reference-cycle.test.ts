import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { findReferenceCycle } from "./reference-cycle.ts";

function row(id: number, slug: string, body: string, archived = false): PromptLibraryListRowDto {
  return {
    id,
    slug,
    name: slug,
    description: null,
    tags: [],
    currentVersion: 1,
    archivedAt: archived ? "2026-01-01T00:00:00Z" : null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "tester",
    body,
  };
}

test("a reference to an unrelated prompt is safe", () => {
  const rows = [row(1, "a", "plain"), row(2, "b", "also plain")];
  assert.equal(findReferenceCycle(rows, "a", "b"), null);
});

test("inserting a direct back-reference closes a two-node cycle", () => {
  const rows = [row(1, "a", "text"), row(2, "b", "uses {{prompt:a}}")];
  assert.deepEqual(findReferenceCycle(rows, "a", "b"), ["a", "b", "a"]);
});

test("finds transitive cycles across several prompts", () => {
  const rows = [
    row(1, "a", "root"),
    row(2, "b", "{{prompt:c}}"),
    row(3, "c", "{{prompt:a}}"),
  ];
  assert.deepEqual(findReferenceCycle(rows, "a", "b"), ["a", "b", "c", "a"]);
});

test("self-reference is always a cycle", () => {
  const rows = [row(1, "a", "text")];
  assert.deepEqual(findReferenceCycle(rows, "a", "a"), ["a", "a"]);
});

test("legacy numeric tokens count as edges too", () => {
  const rows = [row(1, "a", "text"), row(2, "b", "uses {{prompt:1}}")];
  assert.deepEqual(findReferenceCycle(rows, "a", "b"), ["a", "b", "a"]);
});

test("cycles through archived prompts do not block (latest cannot resolve them)", () => {
  const rows = [row(1, "a", "text"), row(2, "b", "{{prompt:a}}", true)];
  assert.equal(findReferenceCycle(rows, "a", "b"), null);
});

test("a diamond without a back-edge is safe and terminates", () => {
  const rows = [
    row(1, "a", "root"),
    row(2, "b", "{{prompt:d}}"),
    row(3, "c", "{{prompt:d}}"),
    row(4, "d", "leaf"),
    row(5, "e", "{{prompt:b}} {{prompt:c}}"),
  ];
  assert.equal(findReferenceCycle(rows, "a", "e"), null);
});
