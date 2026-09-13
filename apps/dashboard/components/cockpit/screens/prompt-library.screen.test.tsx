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
    const cleanAction = button("Nothing to save");
    assert.equal(cleanAction.disabled, true);

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

test("prompt library edit stays clean after Markdown normalization and guards a one-character edit", async () => {
  const dom = installTestDom();
  const cockpitMain = document.createElement("main");
  cockpitMain.dataset.cockpitMain = "";
  const container = document.createElement("div");
  cockpitMain.append(container);
  document.body.append(cockpitMain);
  let root: Root | undefined;
  const normalizedRow = {
    ...row,
    body: "* Investigate the ticket.\n* Record the findings.\n",
  };
  const normalizedDetail = {
    ...detail,
    current: { ...detail.current, body: normalizedRow.body },
    versions: [{ ...detail.versions[0]!, body: normalizedRow.body }],
  };

  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/prompt-library/7") return Response.json(normalizedDetail);
    if (url === "/api/prompt-library/7/usage") {
      return Response.json({ rows: [], prompts: [] });
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
              data={{ prompts: [normalizedRow], tags: normalizedRow.tags }}
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
    await act(async () => {
      edit.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    let dialog = openDialog();
    assert.ok(dialog.querySelector<HTMLElement>('[contenteditable="true"]'));
    assert.equal(button("Nothing to save").disabled, true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);

    await act(async () => {
      edit.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    dialog = openDialog();
    const rawToggle = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Raw",
    );
    assert.ok(rawToggle, "expected the raw mode toggle");
    act(() => rawToggle.click());
    const rawEditor = dialog.querySelector<HTMLTextAreaElement>("textarea");
    assert.ok(rawEditor, "expected the raw prompt editor");
    const reactPropsKey = Object.keys(rawEditor).find((key) => key.startsWith("__reactProps$"));
    assert.ok(reactPropsKey, "expected React props on the raw prompt editor");
    const reactProps = (rawEditor as unknown as Record<string, unknown>)[reactPropsKey] as {
      onChange: (event: { target: { value: string } }) => void;
    };
    act(() => reactProps.onChange({ target: { value: `${rawEditor.value}x` } }));
    assert.equal(button("Save as v2").disabled, false);

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
    assert.ok(button("Discard"));
    assert.ok(button("Keep editing"));
    assert.ok(document.querySelector('[role="dialog"]'));
    act(() => button("Discard").click());
    assert.equal(document.querySelector('[role="dialog"]'), null);
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
