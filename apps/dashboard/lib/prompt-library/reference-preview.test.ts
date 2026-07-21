import assert from "node:assert/strict";
import test from "node:test";
import type {
  ParsedPromptReference,
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
} from "@shared/contracts";
import { resolveReferencePreview } from "./reference-preview";

const row: PromptLibraryListRowDto = {
  id: 7,
  slug: "research-plan",
  name: "research-plan",
  description: null,
  tags: [],
  currentVersion: 3,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-03T00:00:00Z",
  createdByLabel: "System",
  body: "# Current body",
};

function reference(version: "latest" | number): ParsedPromptReference {
  return { slug: "research-plan", version, raw: "{{prompt:research-plan}}", start: 0, end: 25 };
}

const detail: PromptLibraryDetailResponse = {
  meta: row,
  current: {
    promptId: 7,
    version: 3,
    body: row.body,
    createdAt: row.updatedAt,
    createdById: "system",
    createdByLabel: "System",
    restoredFromVersion: null,
  },
  versions: [
    {
      promptId: 7,
      version: 3,
      body: row.body,
      createdAt: row.updatedAt,
      createdById: "system",
      createdByLabel: "System",
      restoredFromVersion: null,
    },
    {
      promptId: 7,
      version: 2,
      body: "# Historical body",
      createdAt: "2026-01-02T00:00:00Z",
      createdById: "system",
      createdByLabel: "System",
      restoredFromVersion: null,
    },
  ],
};

test("latest and current pinned references use the list-row body", () => {
  assert.deepEqual(resolveReferencePreview(reference("latest"), row), {
    kind: "ready",
    body: "# Current body",
  });
  assert.deepEqual(resolveReferencePreview(reference(3), row), {
    kind: "ready",
    body: "# Current body",
  });
});

test("historical pinned references require detail and resolve exactly", () => {
  assert.deepEqual(resolveReferencePreview(reference(2), row), { kind: "needs-detail" });
  assert.deepEqual(resolveReferencePreview(reference(2), row, detail), {
    kind: "ready",
    body: "# Historical body",
  });
});

test("a missing historical version never falls back to current content", () => {
  assert.deepEqual(resolveReferencePreview(reference(9), row, detail), {
    kind: "missing-version",
  });
});
