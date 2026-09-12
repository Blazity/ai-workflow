// apps/dashboard/app/(cockpit)/repositories/repositories-screen.matrix.test.tsx
//
// Two list-screen rows the QA matrix found unpinned: the loading fallback (U03)
// and the 390 px render (U15).
//
// WHAT THIS RUNNER CAN AND CANNOT PROVE. The dashboard's tests run on plain
// Node with react-test-renderer: there is no DOM, no layout engine, no
// viewport. Nothing here can prove that the list "does not scroll
// horizontally at 390 px", because nothing here measures anything. What it CAN
// prove is what the markup COMMITS to: that no element declares a width wider
// than the narrowest phone, that the rows and the header are told to wrap
// rather than to stay on one line, and that the actions an operator needs are
// in the tree at all. A width regression that a human would see is usually a
// fixed width or a lost `flex-wrap` typed into a class string, and that is
// exactly what this catches. A regression from a grid that collapses badly, a
// long unbreakable path, or an overflowing child is NOT caught, and needs a
// real browser at 390 px. Say so out loud rather than letting a green test
// read as "mobile is fine".
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

/** The narrowest phone the matrix names. Nothing measures it; it is the bound
 *  every declared width in the tree is checked against. */
const PHONE_WIDTH_PX = 390;

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

/** Every `className` anywhere in the tree. */
function classNames(root: ReactTestInstance): string[] {
  return root
    .findAll(() => true)
    .map((node) => node.props?.className)
    .filter((value): value is string => typeof value === "string");
}

/**
 * Pixel widths this markup PINS: `w-[NNNpx]`, `min-w-[NNNpx]`, and their
 * `min-width` inline equivalents. A responsive prefix (`sm:w-[...]`) is
 * excluded, because those apply above the phone breakpoint by definition.
 */
function pinnedWidthsPx(root: ReactTestInstance): number[] {
  const widths: number[] = [];
  for (const className of classNames(root)) {
    for (const token of className.split(/\s+/)) {
      if (token.includes(":")) continue;
      const match = /^(?:min-)?w-\[(\d+)px\]$/.exec(token);
      if (match) widths.push(Number(match[1]));
    }
  }
  for (const node of root.findAll(() => true)) {
    const style = node.props?.style as Record<string, unknown> | undefined;
    for (const key of ["width", "minWidth"] as const) {
      const value = style?.[key];
      if (typeof value === "number") widths.push(value);
      if (typeof value === "string" && /^\d+px$/.test(value)) {
        widths.push(Number(value.slice(0, -2)));
      }
    }
  }
  return widths;
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

test("U15: the list declares no width a 390 px phone cannot hold, and wraps rather than staying on one line", (t) => {
  const root = renderScreen(t, {
    repositories: [
      entry(),
      entry({ id: 2, path: "acme/a-very-long-repository-name-for-a-narrow-screen", enabled: false }),
    ],
  });

  for (const width of pinnedWidthsPx(root)) {
    assert.ok(
      width <= PHONE_WIDTH_PX,
      `a ${width}px width is pinned on the list and cannot fit a ${PHONE_WIDTH_PX}px viewport`,
    );
  }

  // The header row and the row actions are told to wrap. Without this the
  // pinned-width check above passes while the row simply runs off the side,
  // which is the failure this row is actually about.
  const wrapping = classNames(root).filter((className) => className.includes("flex-wrap"));
  assert.ok(
    wrapping.length >= 2,
    `expected the header and the rows to wrap; found ${wrapping.length} wrapping containers`,
  );
});

test("U15: the primary actions are still in the tree at phone width", (t) => {
  // There is no viewport here, so "still" means "not behind an `sm:` -only
  // branch in the markup": a control rendered only above a breakpoint would be
  // absent from this tree or carry a `hidden sm:` class, and both are caught.
  const root = renderScreen(t, { state: state(false) });
  const rendered = text(root);

  assert.match(rendered, /Import/);
  assert.match(rendered, /Activate/);
  const hiddenUntilWide = classNames(root).filter((className) =>
    /(^|\s)hidden(\s|$)/.test(className) && /(sm|md|lg):(flex|block|inline)/.test(className),
  );
  assert.deepEqual(
    hiddenUntilWide,
    [],
    "a control hidden below the sm breakpoint is a control a phone cannot reach",
  );
});
