// apps/dashboard/app/(cockpit)/repositories/repositories-screen.test.tsx
//
// The states of the catalog list an operator can actually land on: a catalog
// nobody has imported into, a catalog nobody has activated, a role that may
// read it and not change it, and the activated case where the banner has to be
// gone rather than merely quieter.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type {
  RepositoryCatalogEntry,
  RepositoryCatalogState,
} from "@shared/contracts";

import { RepositoriesScreen } from "./repositories-screen";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(overrides: Partial<RepositoryCatalogEntry> = {}): RepositoryCatalogEntry {
  return {
    id: 1,
    provider: "github",
    path: "acme/web",
    displayName: "Web",
    defaultBranch: "main",
    description: "The storefront.\nSecond line nobody should see on a row.",
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

function screen(props: Partial<React.ComponentProps<typeof RepositoriesScreen>>) {
  return (
    <AppRouterContext.Provider value={ROUTER as never}>
      <RepositoriesScreen
        state={state(false)}
        repositories={[entry()]}
        canManage
        available
        {...props}
      />
    </AppRouterContext.Provider>
  );
}

function render(
  t: TestContext,
  props: Partial<React.ComponentProps<typeof RepositoriesScreen>> = {},
): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(screen(props));
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

/** Every string the tree renders, flattened. */
function text(root: ReactTestInstance): string {
  return root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
}

test("an empty catalog says what it is and offers the import that fills it", (t) => {
  const root = render(t, { repositories: [] });
  const rendered = text(root);

  assert.match(rendered, /The catalog is empty\./);
  assert.match(rendered, /Import the repositories this installation exposes/);
  assert.equal(
    root.findAll(
      (node) => node.type === "button" && text(node).includes("Import repositories"),
    ).length,
    1,
  );
});

test("an empty catalog offers a viewer no import button to press", (t) => {
  const root = render(t, { repositories: [], canManage: false });

  assert.match(text(root), /The catalog is empty\./);
  assert.equal(
    root.findAll(
      (node) => node.type === "button" && text(node).includes("Import repositories"),
    ).length,
    0,
    "the empty state must not offer an action the role cannot take",
  );
});

test("a catalog nobody activated says the agent sees everything, with the Activate that ends it", (t) => {
  const root = render(t);
  const rendered = text(root);

  assert.match(
    rendered,
    /Catalog not activated: the agent sees everything the installation sees/,
  );
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).trim() === "Activate")
      .length,
    1,
  );
  // The dialog is not open until it is asked for: opening it is what asks the
  // worker who holds a run claim.
  assert.doesNotMatch(rendered, /currently hold a run claim/);
});

test("a viewer reads the not-activated banner and is told who can act on it", (t) => {
  const root = render(t, { canManage: false });
  const rendered = text(root);

  assert.match(rendered, /Catalog not activated/);
  assert.match(rendered, /Ask an owner or admin to activate it\./);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).trim() === "Activate")
      .length,
    0,
  );
});

test("a viewer sees the enabled state as a fact, with no switch and no Import", (t) => {
  const root = render(t, { canManage: false });
  const rendered = text(root);

  assert.match(rendered, /Read-only: every repository is shown/);
  assert.equal(
    root.findAll((node) => node.props["aria-label"] === "Let the agent touch acme/web")
      .length,
    0,
    "a viewer must not be given a control that 403s",
  );
  assert.match(rendered, /enabled/);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).trim() === "Import").length,
    0,
  );
});

test("an owner gets the switch, labelled by what flipping it decides", (t) => {
  const root = render(t);

  const toggle = root.findByProps({ "aria-label": "Let the agent touch acme/web" });
  assert.equal(toggle.props.checked, true);
  assert.equal(toggle.props.disabled, false);
});

test("an activated catalog drops the banner and records who ended the bridge", (t) => {
  const root = render(t, { state: state(true) });
  const rendered = text(root);

  assert.doesNotMatch(rendered, /Catalog not activated/);
  assert.match(rendered, /Catalog activated/);
  assert.match(rendered, /by Seed/);
  assert.match(rendered, /Dispatch selects only the repositories enabled here\./);
});

test("a row carries the first line of the description and the checks version, not an invented count", (t) => {
  const root = render(t);
  const rendered = text(root);

  assert.match(rendered, /The storefront\./);
  assert.doesNotMatch(rendered, /Second line nobody should see on a row/);
  // The list response carries no profile, so a script group COUNT would be a
  // number this screen made up.
  assert.match(rendered, /script groups v2/);
  assert.match(rendered, /profile v3/);
  assert.match(rendered, /imported/);
});

test("a repository nobody has configured says so instead of showing version zero", (t) => {
  const root = render(t, {
    repositories: [entry({ profileVersion: 0, checksVersion: 0, description: "" })],
  });
  const rendered = text(root);

  assert.match(rendered, /no script groups/);
  assert.match(rendered, /never configured/);
});

test("a worker that did not answer explains it by role instead of showing an empty catalog", (t) => {
  const owner = render(t, { available: false, repositories: [] });
  assert.match(text(owner), /Check the worker on the System health page and reload\./);
  assert.doesNotMatch(text(owner), /The catalog is empty\./);

  const viewer = render(t, { available: false, repositories: [], canManage: false });
  assert.match(text(viewer), /Ask an owner or admin to check the worker/);
});

test("a server refresh after an import shows the new rows, not the list the screen mounted with", (t) => {
  // `router.refresh()` re-renders this screen with a longer list. Seeding state
  // from props once meant the import appeared to do nothing, and the Activate
  // dialog went on counting the rows from before it.
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(screen({ repositories: [entry()] }));
  });
  t.after(() => act(() => renderer.unmount()));

  assert.doesNotMatch(text(renderer.root), /acme\/api/);

  act(() => {
    renderer.update(
      screen({
        repositories: [entry(), entry({ id: 2, path: "acme/api", displayName: "API" })],
      }),
    );
  });

  assert.match(text(renderer.root), /acme\/api/);
});

test("a server refresh supersedes the optimistic row the switch left behind", (t) => {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(screen({ repositories: [entry({ enabled: true })] }));
  });
  t.after(() => act(() => renderer.unmount()));

  act(() => {
    renderer.update(screen({ repositories: [entry({ enabled: false })] }));
  });

  const toggle = renderer.root.findByProps({
    "aria-label": "Let the agent touch acme/web",
  });
  assert.equal(toggle.props.checked, false, "the server row wins over a local one");
});

test("a row says how many script groups it has, and an absent count is not zero", (t) => {
  const withCount = text(
    render(t, { repositories: [entry({ scriptGroupCount: 2 })] }),
  );
  assert.match(withCount, /2 script groups/);
  assert.match(withCount, /script groups v2/);

  // The count is optional and absent means "this response did not compute it".
  // A row that printed "0 script groups" there would tell an operator their
  // groups are gone.
  const without = text(render(t, { repositories: [entry()] }));
  assert.doesNotMatch(without, /script groups\b(?! v)/);
  assert.match(without, /script groups v2/);
});

test("one script group is said in the singular", (t) => {
  assert.match(
    text(render(t, { repositories: [entry({ scriptGroupCount: 1 })] })),
    /1 script group ·/,
  );
});

test("the switch says what disabling does not reach", (t) => {
  // Disabling is not a cancel. A run already in flight froze its list at the
  // start, so the only way to stop it is to cancel it.
  assert.match(
    text(render(t, {})),
    /Disabling stops the next run\. A run already in flight keeps the list it started with; cancel it to stop it\./,
  );
});

test("an activation nobody clicked is shown as provenance, not as a person", (t) => {
  const seeded = text(
    render(t, {
      state: {
        activated: true,
        bridge: false,
        activatedAt: "2026-09-11T08:30:00.000Z",
        activatedById: "seed",
        activatedByLabel: "seeded from AGENT_ALLOWED_REPOS",
        activationReason: "seeded from AGENT_ALLOWED_REPOS",
      },
    }),
  );
  assert.match(seeded, /Catalog activated on /);
  assert.match(seeded, /\(seeded from AGENT_ALLOWED_REPOS\)/);
  // "activated by seeded from AGENT_ALLOWED_REPOS" would read like a name.
  assert.doesNotMatch(seeded, /by seeded from/);
});

test("an activation somebody clicked names them and their reason", (t) => {
  const banner = text(render(t, { state: state(true) }));
  assert.match(banner, /Catalog activated by Seed on /);
  assert.match(banner, /reason: the bridge is over/);
});
