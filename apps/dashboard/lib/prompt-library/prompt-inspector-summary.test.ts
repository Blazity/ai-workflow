import assert from "node:assert/strict";
import test from "node:test";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { promptInspectorSummary } from "./prompt-inspector-summary";

function row(id: number, name: string, currentVersion: number): PromptLibraryListRowDto {
  return {
    id,
    name,
    description: null,
    tags: [],
    currentVersion,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "System",
    body: "# Prompt",
  };
}

test("summarizes a latest reference", () => {
  assert.deepEqual(
    promptInspectorSummary("{{prompt:7}}", "{{prompt:7}}", undefined, [row(7, "research-plan", 2)]),
    { kind: "reference", title: "research-plan", detail: "Latest · v2" },
  );
});

test("summarizes a pinned reference", () => {
  assert.deepEqual(
    promptInspectorSummary("{{prompt:7@1}}", "{{prompt:7@1}}", undefined, [row(7, "research-plan", 2)]),
    { kind: "reference", title: "research-plan", detail: "Pinned v1" },
  );
});

test("summarizes custom and empty prompts", () => {
  assert.deepEqual(
    promptInspectorSummary("First line\nSecond line", "First line\nSecond line", undefined, []),
    { kind: "custom", title: "Custom prompt", detail: "22 chars · ~6 tokens", preview: "First line Second line" },
  );
  assert.deepEqual(promptInspectorSummary("", "", undefined, []), {
    kind: "empty",
    title: "No prompt configured",
    detail: "Open the editor to add one",
  });
});

test("keeps an unavailable implicit default visible", () => {
  assert.deepEqual(promptInspectorSummary("", "", "research-plan", []), {
    kind: "reference",
    title: "research-plan",
    detail: "Latest",
  });
});
