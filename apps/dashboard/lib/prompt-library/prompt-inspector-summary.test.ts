import assert from "node:assert/strict";
import test from "node:test";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { promptInspectorSummary } from "./prompt-inspector-summary";

function row(id: number, name: string, currentVersion: number): PromptLibraryListRowDto {
  return {
    id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
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
    {
      kind: "custom",
      title: "Custom prompt",
      detail: "22 chars · ~6 tokens · 1 section",
      sectionTitles: ["Introduction"],
      remainingSectionCount: 0,
    },
  );
  assert.deepEqual(promptInspectorSummary("", "", undefined, []), {
    kind: "empty",
    title: "No prompt configured",
    detail: "Open the editor to add one",
  });
});

test("summarizes custom prompt structure without exposing raw markdown", () => {
  const value = "{{prompt:7}}\n\n## New section\nDraft\n\n## Output Format\nJSON";
  assert.deepEqual(promptInspectorSummary(value, value, undefined, [row(7, "research-plan", 2)]), {
    kind: "custom",
    title: "Custom prompt",
    detail: `${value.length} chars · ~${Math.ceil(value.length / 4)} tokens · 3 sections · 1 live prompt`,
    sectionTitles: ["research-plan", "New section", "Output Format"],
    remainingSectionCount: 0,
  });
});

test("caps section names and reports the remainder", () => {
  const value = "# One\na\n# Two\nb\n# Three\nc\n# Four\nd";
  const summary = promptInspectorSummary(value, value, undefined, []);
  assert.equal(summary.kind, "custom");
  if (summary.kind !== "custom") return;
  assert.deepEqual(summary.sectionTitles, ["One", "Two", "Three"]);
  assert.equal(summary.remainingSectionCount, 1);
});

test("keeps an unavailable implicit default visible", () => {
  assert.deepEqual(promptInspectorSummary("", "", "research-plan", []), {
    kind: "reference",
    title: "research-plan",
    detail: "Latest",
  });
});

test("does not disguise an unresolved explicit reference as the implicit default", () => {
  assert.deepEqual(promptInspectorSummary("{{prompt:999}}", "{{prompt:999}}", "research-plan", []), {
    kind: "reference",
    title: "Missing prompt #999",
    detail: "Latest",
  });
});
