// apps/dashboard/app/(cockpit)/repositories/activate-dialog.test.tsx
//
// Ending the bridge is one irreversible click, and what it says before the
// click is the whole safety of it: the population that stops passing includes
// every repository the installation exposes outside the catalog, so the dialog
// cannot offer the button until it knows that number, or knows it cannot.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";

import type { RepositoryCatalogEntry } from "@shared/contracts";

import { ActivateDialog } from "./activate-dialog";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(path: string, enabled: boolean): RepositoryCatalogEntry {
  return {
    id: path.length,
    provider: "github",
    path,
    displayName: path,
    defaultBranch: "main",
    description: "",
    rules: "",
    relationships: [],
    enabled,
    source: "imported",
    profileVersion: 0,
    checksVersion: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

function render(
  t: TestContext,
  options: {
    repositories?: RepositoryCatalogEntry[];
    directory?: Promise<Response>;
  } = {},
): ReactTestInstance {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    assert.equal(String(url), "/api/repositories");
    return options.directory ?? Promise.resolve(Response.json({ repositories: [] }));
  }) as typeof globalThis.fetch;

  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <ActivateDialog
        repositories={options.repositories ?? [entry("acme/web", true)]}
        onClose={() => {}}
        onActivated={() => {}}
      />,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return renderer.root;
}

/** Every string the tree renders, flattened. Runs of whitespace collapse, and
 *  so does the space JSX leaves in front of a trailing `{value}.`, which no
 *  assertion could otherwise be written against. */
function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((c) => typeof c === "string"))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/ \./g, ".");
}

function confirmButton(root: ReactTestInstance): ReactTestInstance {
  const matches = root
    .findAll((node) => node.type === "button")
    .filter((node) => text(node).startsWith("Activat"));
  assert.equal(matches.length, 1, "expected exactly one confirm button");
  return matches[0];
}

test("confirm is disabled while the provider directory is still being read", async (t) => {
  // The headline count is catalog rows PLUS everything the installation exposes
  // outside them, so confirming before the directory lands is confirming
  // against a number that is about to change.
  const pending = deferred<Response>();
  const root = render(t, { directory: pending.promise });

  assert.equal(confirmButton(root).props.disabled, true);
  assert.match(text(root), /Activate is disabled: the provider directory is still being read\./);
  assert.match(text(root), /Reading the provider directory/);

  await act(async () => {
    pending.settle(Response.json({ repositories: [] }));
  });

  // Still disabled, but now for the reason it was always going to be: no reason
  // has been typed.
  assert.equal(confirmButton(root).props.disabled, true);
  assert.match(text(root), /Activate is disabled: a reason is required\./);
});

test("a directory that refuses does not block activation for ever", async (t) => {
  // Waiting for a read that will not arrive would make activation impossible
  // rather than careful; the summary already says the count is not known.
  const root = render(t, {
    directory: Promise.resolve(Response.json({ error: "nope" }, { status: 500 })),
  });
  await act(async () => undefined);

  assert.match(text(root), /could not be read/);
  assert.match(text(root), /Activate is disabled: a reason is required\./);
});

test("a catalog with nothing enabled refuses outright rather than disabling a button", async (t) => {
  const root = render(t, { repositories: [entry("acme/web", false)] });
  await act(async () => undefined);

  assert.match(text(root), /Activation is refused: no repository in this catalog is enabled/);
  assert.equal(confirmButton(root).props.disabled, true);
  // One statement, not two: the refusal replaces the ordinary blocker line.
  assert.doesNotMatch(text(root), /Activate is disabled:/);
});
