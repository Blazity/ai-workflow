import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { findSettingDefinition } from "@shared/contracts";
import type { SettingsEntryView } from "@shared/contracts";

import { hasUnsavedSettings, resetUnsavedSettings } from "@/lib/settings/unsaved";
import { SettingsScreen } from "./settings-screen";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { window?: unknown }).window ??= {
  addEventListener: () => {},
  removeEventListener: () => {},
};

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
  entry("catalog.activated", false),
];

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
          scan={null}
          scanReadable
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

test("the standing caveat is on the page, unconditionally", (t) => {
  // The one failure this surface could cause is somebody believing a saved
  // value already changed what the worker does.
  const root = render(t);
  assert.match(text(root), /Values saved here are stored now/);
  assert.match(text(root), /still reads most settings from its environment/);
});

test("a catalog that is not activated says so above the forms", (t) => {
  const root = render(t);
  assert.match(
    text(root),
    /Repository catalog not activated: the agent sees everything the installation sees/,
  );
});

test("an activated catalog drops the banner but keeps the overview row", (t) => {
  const root = render(t, {
    settings: [...SETTINGS.slice(0, 2), entry("catalog.activated", true)],
  });
  const rendered = text(root);
  assert.doesNotMatch(rendered, /Repository catalog not activated/);
  assert.match(rendered, /Stored setting: Repository catalog/);
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
