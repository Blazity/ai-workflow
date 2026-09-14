// apps/dashboard/app/(cockpit)/repositories/repositories-screen.matrix.test.tsx
//
// Matrix coverage for the loading fallback (U03) and primary action presence
// (U15).
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type {
  RepositoryCatalogEntry,
  RepositoryCatalogState,
} from "@shared/contracts";

import { RepositoriesScreen } from "./repositories-screen";

// The route's own child is a server component that fetches, and loading it
// drags in `server-only`, which refuses to be imported outside a server render.
// Replaced with a marker: this file is about the FALLBACK the route declares,
// which is rendered precisely when that child has not resolved.
mock.module("./repositories-data.tsx", {
  exports: {
    RepositoriesData: () => React.createElement("div", null, "data"),
  },
} as unknown as Parameters<typeof mock.module>[1]);

// `require` rather than a top-level import, for the reason the sibling suite
// gives: this package transpiles to CommonJS and the route has to load AFTER
// the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RepositoriesPage = (require("./page") as typeof import("./page")).default;

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

function entry(overrides: Partial<RepositoryCatalogEntry> = {}): RepositoryCatalogEntry {
  return {
    id: 1,
    provider: "github",
    path: "acme/web",
    displayName: "Web",
    defaultBranch: "main",
    description: "The storefront.",
    rules: "",
    relationships: [],
    enabled: true,
    source: "imported",
    profileVersion: 3,
    checksVersion: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function state(activated: boolean): RepositoryCatalogState {
  return {
    activated,
    bridge: !activated,
    activatedAt: activated ? "2026-09-11T08:30:00.000Z" : null,
    activatedById: activated ? "user-7" : null,
    activatedByLabel: activated ? "Seed" : null,
    activationReason: activated ? "the bridge is over" : null,
  };
}

const ROUTER = {
  refresh: () => {},
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

function render(t: TestContext, element: React.ReactElement): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(element);
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

function renderScreen(
  t: TestContext,
  props: Partial<React.ComponentProps<typeof RepositoriesScreen>> = {},
): ReactTestInstance {
  return render(
    t,
    <AppRouterContext.Provider value={ROUTER as never}>
      <RepositoriesScreen
        state={state(true)}
        repositories={[entry()]}
        canManage
        available
        {...props}
      />
    </AppRouterContext.Provider>,
  );
}

/** Every string the tree renders, flattened, whitespace collapsed. */
function text(root: ReactTestInstance): string {
  return root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

test("U03: the route's fallback names what is loading, so a slow worker is not a blank page", (t) => {
  // The page itself cannot be rendered here: its child is a server component
  // that fetches. What IS assertable, and is the whole of the row, is the
  // element the route declares as its Suspense fallback.
  const page = RepositoriesPage();
  const fallback = (page.props as { fallback: React.ReactElement }).fallback;
  assert.ok(fallback, "the repositories route declares a Suspense fallback");

  const root = render(t, fallback);

  // Names the thing, not "Loading...": this route is reached from a nav where
  // three screens load the same way, and a bare spinner leaves an operator
  // unsure which one they are waiting for.
  assert.match(text(root), /Loading repositories/);
});

test("U15: the primary actions are present", (t) => {
  const root = renderScreen(t, { state: state(false) });
  const rendered = text(root);

  assert.match(rendered, /Import/);
  assert.match(rendered, /Activate/);
});
