import assert from "node:assert/strict";
import test from "node:test";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { initialPromptSelection } from "./query-selection";

function row(id: number, archivedAt: string | null = null): PromptLibraryListRowDto {
  return {
    id,
    slug: `prompt-${id}`,
    name: `prompt-${id}`,
    description: null,
    tags: [],
    currentVersion: 1,
    archivedAt,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "System",
    body: "# Prompt",
  };
}

test("selects an active prompt from a valid query", () => {
  assert.equal(initialPromptSelection("7", [row(7), row(8)]), 7);
});

test("falls back for invalid, missing, and archived ids", () => {
  const rows = [row(7), row(8, "2026-07-01T00:00:00Z")];
  assert.equal(initialPromptSelection(null, rows), 7);
  assert.equal(initialPromptSelection("nope", rows), 7);
  assert.equal(initialPromptSelection("99", rows), 7);
  assert.equal(initialPromptSelection("8", rows), 7);
  assert.equal(initialPromptSelection("0", rows), 7);
});

test("returns null when no active prompt exists", () => {
  assert.equal(initialPromptSelection("8", [row(8, "2026-07-01T00:00:00Z")]), null);
});
