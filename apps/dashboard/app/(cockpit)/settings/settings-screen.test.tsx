import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { findSettingDefinition } from "@shared/contracts";
import type { RepositoryCatalogState, SettingsEntryView } from "@shared/contracts";

import { hasUnsavedSettings, resetUnsavedSettings } from "@/lib/settings/unsaved";
import { SettingsScreen } from "./settings-screen";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {},
};
// next/link's intersection observer reaches for `self` on mount, and the page
// links to the Repositories page from two places.
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

function entry(
  key: string,
  value: SettingsEntryView["value"],
  overrides: Partial<SettingsEntryView> = {},
): SettingsEntryView {
  const definition = findSettingDefinition(key);
  assert.ok(definition, `${key} is not a registry key`);
  return {
    key: key as SettingsEntryView["key"],
    value,
    default: definition.default,
    source: "default",
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    lastVersion: null,
    ...overrides,
  };
}

const SETTINGS = [
  entry("MAX_CONCURRENT_AGENTS", 3),
  entry("ENABLE_REPO_MEMORY", false),
  // Still in the registry, still never written by anything, and deliberately
  // set to the value that used to drive this page so a test would catch the
  // page reading it again.
  entry("catalog.activated", false),
];

/** The catalog state row the worker returns, which is where activation lives. */
function catalogState(activated: boolean): RepositoryCatalogState {
  return {
    activated,
    bridge: !activated,
    activatedAt: activated ? "2026-09-11T08:30:00.000Z" : null,
    activatedById: activated ? "user-7" : null,
    activatedByLabel: activated ? "Seed" : null,
    activationReason: activated ? "the bridge is over" : null,
  };
}

function render(
  t: TestContext,
  props: Partial<React.ComponentProps<typeof SettingsScreen>> = {},
) {
  resetUnsavedSettings();
  // The forms refresh the server render after a save, so the tree needs a
  // router the way every other cockpit screen test gives it one.
  const router = {
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <SettingsScreen
          settings={SETTINGS}
          migratedVariablesSet={[]}
          scan={null}
          scanReadable
          catalogState={catalogState(false)}
          canEdit
          available
          {...props}
        />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    resetUnsavedSettings();
  });
  return renderer.root;
}

/** Every string the tree renders, flattened, so a sentence can be looked for
 *  without knowing which element it ended up inside. */
function text(root: ReactTestInstance): string {
  return root
    .findAll(() => true)
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
}

test("the standing caveat states the read cadence, not a worker that ignores the store", (t) => {
  // Since stage B1 the worker loads a settings snapshot per request, cron tick
  // and MCP call, so the old sentence was the falsehood on this page.
  const root = render(t);
  assert.match(text(root), /Values saved here are stored and read/);
  assert.match(text(root), /per request, cron tick and MCP call/);
  assert.doesNotMatch(text(root), /still reads most settings from its environment/);
});

test("the variables still set on the deployment are named, not counted", (t) => {
  const root = render(t, {
    migratedVariablesSet: ["MAX_CONCURRENT_AGENTS", "COLUMN_AI"],
  });
  assert.match(text(root), /2 environment variables are still set on this deployment/);
  assert.match(text(root), /MAX_CONCURRENT_AGENTS, COLUMN_AI/);
  assert.match(text(root), /remove them from the deployment before the next cleanup release/);
});

test("a deployment with none of them set shows no such banner", (t) => {
  const root = render(t, { migratedVariablesSet: [] });
  assert.doesNotMatch(text(root), /still set on this deployment/);
});

test("a catalog that is not activated says so above the forms", (t) => {
  const root = render(t);
  assert.match(
    text(root),
    /Repository catalog not activated: the agent sees everything the installation sees/,
  );
});

test("an activated catalog drops the banner and names who activated it", (t) => {
  // The state row is the input, not the registry key: this render leaves the
  // key at false, which is exactly the production shape (seed activated the
  // catalog, nothing ever wrote the key) that made the page say "Not activated".
  const root = render(t, { catalogState: catalogState(true) });
  const rendered = text(root);
  assert.doesNotMatch(rendered, /Repository catalog not activated/);
  assert.match(rendered, /Repository catalog/);
  assert.match(rendered, /Activated by Seed on /);
});

test("a catalog read the worker did not answer shows no activation banner at all", (t) => {
  // Null is "not known", and an orange banner announcing the bridge is on would
  // be a claim nothing observed.
  const root = render(t, { catalogState: null });
  assert.doesNotMatch(text(root), /Repository catalog not activated/);
  assert.match(text(root), /the worker did not answer the catalog read/i);
});

test("a member sees every value and no way to change one", (t) => {
  const root = render(t, { canEdit: false });
  const rendered = text(root);
  assert.match(rendered, /Read-only: every setting is shown/);
  assert.match(rendered, /Read-only: ask an owner or admin/);
  assert.equal(
    root.findAll(
      (node) => node.type === "button" && String(node.children[0]).includes("Store"),
    ).length,
    0,
    "a member was offered a Save control the worker would refuse",
  );
  // The values are still there: reading is open to every role.
  assert.match(rendered, /MAX_CONCURRENT_AGENTS/);
});

test("the repositories group is a summary, not a form with dead controls", (t) => {
  const root = render(t);
  assert.match(text(root), /Activating the catalog decides what the agent may touch/);
  assert.equal(
    root.findAll(
      (node) => node.props?.["aria-label"] === "Value of catalog.activated",
    ).length,
    0,
    "the catalog switch was rendered as a control that cannot do anything",
  );
});

test("a worker that did not answer tells a member who to ask, not where to click", (t) => {
  // The System health page is owner and admin only, so pointing a member at it
  // is an instruction they cannot follow.
  const member = text(render(t, { available: false, canEdit: false }));
  assert.match(member, /Ask an owner or admin to check the worker, then reload/);
  assert.doesNotMatch(member, /System health page/);

  const admin = text(render(t, { available: false, canEdit: true }));
  assert.match(admin, /System health page/);
});

test("saving is refused until a reason is typed, and edits register with the shell", (t) => {
  const root = render(t);
  const saveButton = () =>
    root
      .findAll((node) => node.type === "button")
      .find((node) => String(node.children[0] ?? "").startsWith("Nothing to save") ||
        String(node.children.join("")).includes("Store 1 change"));

  assert.equal(hasUnsavedSettings(), false, "a freshly rendered form is not dirty");

  const field = root.find(
    (node) => node.props?.["aria-label"] === "Value of MAX_CONCURRENT_AGENTS",
  );
  act(() => {
    field.props.onChange({ target: { value: "9" } });
  });

  assert.equal(
    hasUnsavedSettings(),
    true,
    "the shell would have navigated away from an unsaved edit without asking",
  );
  const save = saveButton();
  assert.ok(save, "expected the save control");
  assert.equal(save.props.disabled, true, "a change was saveable with no reason");
  assert.match(text(root), /A reason is required/);

  const reason = root.find(
    (node) =>
      node.props?.["aria-label"] === "Reason for changing Capacity" &&
      node.type === "input",
  );
  assert.equal(reason.props.required, true);
  act(() => {
    reason.props.onChange({ target: { value: "more capacity" } });
  });
  assert.equal(saveButton()?.props.disabled, false, "a reasoned change stayed blocked");
});

test("an emptied number field is refused before a request is made", (t) => {
  const root = render(t);
  const field = root.find(
    (node) => node.props?.["aria-label"] === "Value of MAX_CONCURRENT_AGENTS",
  );
  act(() => {
    field.props.onChange({ target: { value: "" } });
  });
  const reason = root.find(
    (node) =>
      node.type === "input" &&
      node.props?.["aria-label"] === "Reason for changing Capacity",
  );
  act(() => {
    reason.props.onChange({ target: { value: "clearing it" } });
  });

  let fetched = false;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetched = true;
    return new Response("{}");
  };
  const save = root
    .findAll((node) => node.type === "button")
    .find((node) => String(node.children.join("")).includes("Store 1 change"));
  assert.ok(save, "expected the save control");
  act(() => {
    save.props.onClick();
  });

  assert.equal(fetched, false, "an empty required number reached the worker");
  assert.match(text(root), /Enter a whole number, at least 1/);
});
