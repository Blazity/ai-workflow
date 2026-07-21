import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { effectiveDefaultPromptValue } from "./effective-default.ts";

function row(overrides: Partial<PromptLibraryListRowDto> = {}): PromptLibraryListRowDto {
  return {
    id: 7,
    slug: "research-plan",
    name: "research-plan",
    description: null,
    tags: ["built-in"],
    currentVersion: 3,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "System",
    body: "# Research",
    ...overrides,
  };
}

test("derives a latest reference for an empty first-party prompt", () => {
  assert.deepEqual(effectiveDefaultPromptValue("", "research-plan", [row()]), {
    value: "{{prompt:research-plan}}",
    implicit: true,
  });
});

test("preserves explicit local content", () => {
  assert.deepEqual(effectiveDefaultPromptValue("local", "research-plan", [row()]), {
    value: "local",
    implicit: false,
  });
});

test("keeps an unresolved implicit state when the default is missing or archived", () => {
  assert.deepEqual(effectiveDefaultPromptValue("", "missing", [row()]), {
    value: "",
    implicit: true,
  });
  assert.deepEqual(effectiveDefaultPromptValue("", "research-plan", [
    row({ archivedAt: "2026-07-01T00:00:00Z" }),
  ]), {
    value: "",
    implicit: true,
  });
});

test("does not derive defaults for fields without a mapped prompt", () => {
  assert.deepEqual(effectiveDefaultPromptValue("", undefined, [row()]), {
    value: "",
    implicit: false,
  });
});
