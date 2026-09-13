import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
} from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import { PromptDetail } from "./detail";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const row: PromptLibraryListRowDto = {
  id: 7,
  slug: "research-plan",
  name: "Research plan",
  description: null,
  tags: [],
  currentVersion: 2,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  createdByLabel: "System",
  body: "Current body",
  slots: [],
};

const detail: PromptLibraryDetailResponse = {
  meta: {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    currentVersion: row.currentVersion,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByLabel: row.createdByLabel,
  },
  current: {
    promptId: row.id,
    version: 2,
    body: row.body,
    slots: [],
    createdAt: "2026-01-02T00:00:00Z",
    createdById: "system",
    createdByLabel: "System",
    restoredFromVersion: null,
  },
  versions: [
    {
      promptId: row.id,
      version: 2,
      body: row.body,
      slots: [],
      createdAt: "2026-01-02T00:00:00Z",
      createdById: "system",
      createdByLabel: "System",
      restoredFromVersion: null,
    },
    {
      promptId: row.id,
      version: 1,
      body: "Original body",
      slots: [],
      createdAt: "2026-01-01T00:00:00Z",
      createdById: "system",
      createdByLabel: "System",
      restoredFromVersion: null,
    },
  ],
};

test("PromptDetail keeps the selected version card on the historical tint", () => {
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;

  try {
    act(() => {
      root = createRoot(container);
      root.render(
        <PromptDetail
          row={row}
          detail={detail}
          usage={undefined}
          canEdit={false}
          busy={null}
          onEdit={() => undefined}
          onArchive={() => undefined}
          onRestore={() => undefined}
        />,
      );
    });

    const selected = container.querySelector<HTMLButtonElement>('[data-version-card="2"]');
    const inactive = container.querySelector<HTMLButtonElement>('[data-version-card="1"]');
    assert.ok(selected);
    assert.ok(inactive);
    assert.equal(selected.getAttribute("aria-pressed"), "true");
    assert.match(selected.className, /border-mariner/);
    assert.match(selected.className, /bg-mariner-100/);
    assert.doesNotMatch(selected.className, /bg-mariner(?:\s|$)/);
    assert.equal(inactive.getAttribute("aria-pressed"), "false");
    assert.match(inactive.className, /border-neutral-200/);
    assert.match(inactive.className, /bg-panel/);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
