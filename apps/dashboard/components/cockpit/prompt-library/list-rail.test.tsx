import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PromptLibraryListRowDto } from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import { PromptListRail } from "./list-rail";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const rows: PromptLibraryListRowDto[] = [
  {
    id: 7,
    slug: "research-plan",
    name: "Research plan",
    description: "Selected prompt",
    tags: ["research"],
    currentVersion: 3,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    createdByLabel: "System",
    body: "# Research",
    slots: [],
  },
  {
    id: 8,
    slug: "review-plan",
    name: "Review plan",
    description: null,
    tags: [],
    currentVersion: 1,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    createdByLabel: "System",
    body: "# Review",
    slots: [],
  },
];

test("PromptListRail exposes selected rows and active filters", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <PromptListRail
          rows={rows}
          tags={["research"]}
          activeId={7}
          query=""
          onQueryChange={() => undefined}
          tag={null}
          onTagChange={() => undefined}
          showArchived={false}
          onToggleArchived={() => undefined}
          onSelect={() => undefined}
          onClearFilters={() => undefined}
        />,
      );
    });

    const renderedRows = Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-row]"));
    assert.equal(renderedRows.length, 2);
    assert.equal(renderedRows[0]?.getAttribute("aria-pressed"), "true");
    assert.equal(renderedRows[1]?.getAttribute("aria-pressed"), "false");

    const activeTag = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "all",
    );
    assert.ok(activeTag);
    assert.equal(activeTag.textContent?.trim(), "all");
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search prompts"]');
    assert.equal(search?.placeholder, "Search prompts  ( / )");
    const archived = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Archived",
    );
    assert.ok(archived);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
