import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { filterPrompts } from "./filter.ts";

function row(overrides: Partial<PromptLibraryListRowDto> = {}): PromptLibraryListRowDto {
  return {
    id: 1,
    slug: "plain",
    name: "Plain",
    description: null,
    tags: [],
    currentVersion: 1,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "tester",
    body: "",
    slots: [],
    ...overrides,
  };
}

const rows: PromptLibraryListRowDto[] = [
  row({ id: 1, name: "Planning prompt", tags: ["planning", "agent"] }),
  row({ id: 2, name: "Reviewer", description: "Reviews the diff", tags: ["review"] }),
  row({ id: 3, name: "Fixer", body: "resolve failing checks", tags: ["fix"] }),
  row({ id: 4, name: "Retired", tags: ["review"], archivedAt: "2026-02-01T00:00:00Z" }),
];

const ids = (result: PromptLibraryListRowDto[]) => result.map((r) => r.id);

test("empty query and null tag returns all non-archived rows", () => {
  assert.deepEqual(ids(filterPrompts(rows, "", null)), [1, 2, 3]);
});

test("query matches on name", () => {
  assert.deepEqual(ids(filterPrompts(rows, "planning", null)), [1]);
});

test("query matches on description", () => {
  assert.deepEqual(ids(filterPrompts(rows, "diff", null)), [2]);
});

test("query matches on body", () => {
  assert.deepEqual(ids(filterPrompts(rows, "failing checks", null)), [3]);
});

test("query matches on a tag", () => {
  assert.deepEqual(ids(filterPrompts(rows, "agent", null)), [1]);
});

test("query is case-insensitive", () => {
  assert.deepEqual(ids(filterPrompts(rows, "REVIEWER", null)), [2]);
});

test("tag filter is exact membership", () => {
  assert.deepEqual(ids(filterPrompts(rows, "", "review")), [2]);
});

test("tag filter does not match partial tags", () => {
  assert.deepEqual(ids(filterPrompts(rows, "", "rev")), []);
});

test("archived rows are excluded by default", () => {
  assert.equal(ids(filterPrompts(rows, "", null)).includes(4), false);
});

test("includeArchived surfaces archived rows", () => {
  assert.deepEqual(ids(filterPrompts(rows, "", null, { includeArchived: true })), [1, 2, 3, 4]);
});

test("tag and includeArchived combine", () => {
  assert.deepEqual(ids(filterPrompts(rows, "", "review", { includeArchived: true })), [2, 4]);
});

test("query and tag combine", () => {
  assert.deepEqual(ids(filterPrompts(rows, "retired", "review", { includeArchived: true })), [4]);
});

test("trailing-space query still matches", () => {
  assert.deepEqual(ids(filterPrompts(rows, "planning ", null)), [1]);
});

test("whitespace-only query returns all non-archived rows", () => {
  assert.deepEqual(ids(filterPrompts(rows, "   ", null)), [1, 2, 3]);
});
