import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import type { Root } from "react-dom/client";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type {
  PromptLibraryDetailResponse,
  PromptLibraryListRowDto,
} from "@shared/contracts";
import { installTestDom } from "@/components/ui/test-dom";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

async function loadPromptLibraryScreen() {
  const [{ createRoot }, { PromptLibraryScreen }] = await Promise.all([
    import("react-dom/client"),
    import("./prompt-library"),
  ]);
  return { createRoot, PromptLibraryScreen };
}

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

/** What `settle` watches: the reads this screen has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs `handler` as the fetch for one test, counting what is out.
 *
 * Every answer lands a turn later, the way a response does: resolving in the
 * caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is how
 * this harness reproduces a runner slow enough to break a counted wait.
 */
function installFetch(handler: (url: string) => Promise<Response>) {
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  mock.method(globalThis, "fetch", (input: string | URL | Request) => {
    const url = String(input);
    mine.inFlight += 1;
    mine.started += 1;
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return handler(url);
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  });
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of loads this screen starts finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS, AND NEVER A GUESSED SLEEP. Opening the editor reads
 * the prompt, then its usage, each a fetch whose body lands a turn or more
 * after the call. How many turns that costs is the runner's business, so a
 * fixed count, or a 20 ms sleep picked because it looked long enough, passes on
 * an idle machine and, on a loaded one, returns while a read is still in
 * flight: the assertion then reads a half-open dialog and the failure looks
 * like the product. Quiet is the condition those assertions mean, and it is two
 * things, because a read that lands usually starts the next one: nothing in
 * flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of failing,
 * and a screen that never settles fails as a readable timeout rather than
 * hanging the suite.
 */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`the screen was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

/**
 * Waits for the dialog the next assertion is about. The editor opens through
 * work the screen does after its reads land, where "nothing in flight" is true
 * too early.
 */
async function waitForDialog(timeoutMs = 10_000): Promise<HTMLElement> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
    if (dialog) return dialog;
    if (Date.now() >= deadline) {
      assert.fail(`waited ${timeoutMs} ms for an open prompt editor dialog`);
    }
    await turn();
  }
}

function button(label: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `expected button ${label}`);
  return found;
}

test("prompt library editor owns focus, traps Tab, dismisses, and restores the Edit opener", async () => {
  const dom = installTestDom();
  const { createRoot, PromptLibraryScreen } = await loadPromptLibraryScreen();
  const cockpitMain = document.createElement("main");
  cockpitMain.dataset.cockpitMain = "";
  const container = document.createElement("div");
  cockpitMain.append(container);
  document.body.append(cockpitMain);
  let root: Root | undefined;

  installFetch(async (url) => {
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
    });
    await settle();

    const edit = button("Edit");
    act(() => edit.focus());
    act(() => edit.click());
    await settle();
    let dialog = await waitForDialog();
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

    act(() => edit.click());
    await settle();
    dialog = await waitForDialog();
    const backdrop = document.querySelector<HTMLElement>("[data-modal-overlay]");
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
    act(() => root?.unmount());
    await settle();
    cockpitMain.remove();
    mock.restoreAll();
    dom.restore();
  }
});

test("prompt library edit stays clean after Markdown normalization and guards a one-character edit", async () => {
  const dom = installTestDom();
  const { createRoot, PromptLibraryScreen } = await loadPromptLibraryScreen();
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

  installFetch(async (url) => {
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
    });
    await settle();

    const edit = button("Edit");
    act(() => edit.click());
    await settle();
    let dialog = await waitForDialog();
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

    act(() => edit.click());
    await settle();
    dialog = await waitForDialog();
    const cleanBackdrop = document.querySelector<HTMLElement>("[data-modal-overlay]");
    assert.ok(cleanBackdrop, "expected the production modal backdrop");
    act(() => {
      cleanBackdrop.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
        (candidate) => candidate.textContent?.trim() === "Discard",
      ),
      false,
    );

    act(() => edit.click());
    await settle();
    dialog = await waitForDialog();
    const rawToggle = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Raw",
    );
    assert.ok(rawToggle, "expected the raw mode toggle");
    act(() => rawToggle.click());
    const rawEditor = dialog.querySelector<HTMLTextAreaElement>("textarea");
    assert.ok(rawEditor, "expected the raw prompt editor");
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    assert.ok(valueSetter, "expected the native textarea value setter");
    act(() => {
      valueSetter.call(rawEditor, `${rawEditor.value}x`);
      rawEditor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(button("Save as v2").disabled, false);

    const backdrop = document.querySelector<HTMLElement>("[data-modal-overlay]");
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
    act(() => root?.unmount());
    await settle();
    cockpitMain.remove();
    mock.restoreAll();
    dom.restore();
  }
});
