import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type {
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
} from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";
import { PromptLibraryScreen } from "./prompt-library";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const row: PromptLibraryListRowDto = {
  id: 7,
  slug: "research-plan",
  name: "Research plan",
  description: "Plan the investigation.",
  tags: ["built-in"],
  currentVersion: 1,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  createdByLabel: "System",
  body: "Investigate the ticket.",
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
    version: 1,
    body: row.body,
    slots: [],
    createdAt: row.updatedAt,
    createdById: "system",
    createdByLabel: "System",
    restoredFromVersion: null,
  },
  versions: [
    {
      promptId: row.id,
      version: 1,
      body: row.body,
      slots: [],
      createdAt: row.updatedAt,
      createdById: "system",
      createdByLabel: "System",
      restoredFromVersion: null,
    },
  ],
};

function button(label: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `expected button ${label}`);
  return found;
}

function openDialog() {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
  assert.ok(dialog, "expected an open prompt editor dialog");
  return dialog;
}

test("prompt library editor owns focus, traps Tab, dismisses, and restores the Edit opener", async () => {
  const dom = installTestDom();
  const cockpitMain = document.createElement("main");
  cockpitMain.dataset.cockpitMain = "";
  const container = document.createElement("div");
  cockpitMain.append(container);
  document.body.append(cockpitMain);
  let root: Root | undefined;

  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/prompt-library/7") return Response.json(detail);
    if (url === "/api/prompt-library/7/usage") {
      return Response.json({ rows: [], prompts: [] });
    }
    if (url === "/api/prompt-library?includeArchived=1") {
      return Response.json({ prompts: [row], tags: row.tags });
    }
    return Response.json({}, { status: 404 });
  });

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <PathnameContext.Provider value="/prompts">
          <SearchParamsContext.Provider value={new URLSearchParams() as never}>
            <PromptLibraryScreen
              data={{ prompts: [row], tags: row.tags }}
              canEdit
              available
            />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>,
      );
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const edit = button("Edit");
    act(() => edit.focus());
    await act(async () => {
      edit.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    let dialog = openDialog();
    assert.ok(dialog.contains(document.activeElement));
    assert.equal(cockpitMain.hasAttribute("inert"), true);

    const tabbable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = tabbable[0];
    const last = tabbable.at(-1);
    assert.ok(first);
    assert.ok(last);
    act(() => last.focus());
    act(() => {
      last.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.activeElement, first);
    act(() => {
      first.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.activeElement, last);

    act(() => {
      last.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, edit);
    assert.equal(cockpitMain.hasAttribute("inert"), false);

    await act(async () => {
      edit.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    dialog = openDialog();
    const backdrop = Array.from(document.querySelectorAll<HTMLElement>("div")).find(
      (element) => element.className.includes("absolute inset-0 bg-coal/40"),
    );
    assert.ok(backdrop, "expected the production modal backdrop");
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, edit);
  } finally {
    await act(async () => {
      root?.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    cockpitMain.remove();
    mock.restoreAll();
    dom.restore();
  }
});
