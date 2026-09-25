import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { settingDefinition } from "@integrations/registry";
import {
  canEditSettings,
  canResetSettings,
  type RepositoryCatalogState,
  type SettingsEntryView,
} from "@shared/contracts";

import { groupSettings } from "@/lib/settings/groups";
import { hasUnsavedSettings, resetUnsavedSettings } from "@/lib/settings/unsaved";
import { SettingsGroupForm } from "./settings-group-form";
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
// The shared Modal opens on an animation frame, which node has no browser to
// give it. Running the callback at once is what a test wants anyway.
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) => {
  callback(0);
  return 0;
}) as typeof globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame ??= (() => {}) as typeof globalThis.cancelAnimationFrame;

function entry(
  key: string,
  value: SettingsEntryView["value"],
  overrides: Partial<SettingsEntryView> = {},
): SettingsEntryView {
  const definition = settingDefinition(key);
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
  entry("DASHBOARD_ORG_SLUG", "ai-workflow", { source: "environment" }),
  entry("MCP_ALLOW_PUBLIC_DCR", false, { source: "environment" }),
  entry("PRE_PR_CHECKS_ALLOWED_ENV", ["NPM_TOKEN"], { source: "environment" }),
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
  assert.match(text(root), /A stored setting is read by the worker/);
  assert.match(text(root), /per request, cron tick and MCP call/);
  assert.doesNotMatch(text(root), /still reads most settings from its environment/);
});

test("a catalog that is not activated says so above the forms", (t) => {
  const root = render(t);
  assert.match(
    text(root),
    /Repository catalog not activated: the agent sees everything the installation sees/,
  );
});

test("an activated catalog drops the banner and names who activated it", (t) => {
  // The catalog state row is the only activation input.
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
      (node) => node.type === "button" && text(node).includes("Store"),
    ).length,
    0,
    "a member was offered a Save control the worker would refuse",
  );
  // The values are still there: reading is open to every role.
  assert.match(rendered, /MAX_CONCURRENT_AGENTS/);
});

test("deployment variables render read-only below the editable forms", (t) => {
  const root = render(t);
  const rendered = text(root);
  assert.match(rendered, /Deployment variables/);
  assert.match(rendered, /Set in the deployment environment/);
  assert.match(rendered, /Changes need a redeploy/);
  assert.match(rendered, /DASHBOARD_ORG_SLUG/);
  assert.match(rendered, /MCP_ALLOW_PUBLIC_DCR/);
  assert.match(rendered, /PRE_PR_CHECKS_ALLOWED_ENV/);
  for (const key of [
    "DASHBOARD_ORG_SLUG",
    "MCP_ALLOW_PUBLIC_DCR",
    "PRE_PR_CHECKS_ALLOWED_ENV",
  ]) {
    assert.equal(
      root.findAll((node) => node.props?.["aria-label"] === `Value of ${key}`).length,
      0,
      `${key} was rendered as an editable control`,
    );
  }
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
      .find((node) => text(node).includes("Nothing to save") ||
        text(node).includes("Store 1 change"));

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
    .find((node) => text(node).includes("Store 1 change"));
  assert.ok(save, "expected the save control");
  act(() => {
    save.props.onClick();
  });

  assert.equal(fetched, false, "an empty required number reached the worker");
  assert.match(text(root), /Enter a whole number, at least 1/);
});

interface Sent {
  url: string;
  method: string | undefined;
  body: unknown;
}

/** Answers every request with the next reply in order, and records it. */
function stubReplies(t: TestContext, replies: Array<{ status: number; body: unknown }>): Sent[] {
  const sent: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    const reply = replies.shift() ?? { status: 500, body: { error: "unexpected request" } };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return sent;
}

function buttonLabelled(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAll((node) => node.type === "button" && text(node).includes(label));
  assert.ok(found.length > 0, `no button labelled ${label}`);
  return found[0]!;
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick?.({ stopPropagation() {}, preventDefault() {} });
  });
}

function typeInto(node: ReactTestInstance, value: string): void {
  act(() => {
    node.props.onChange?.({ target: { value } });
  });
}

function versionOf(id: number, newValue: SettingsEntryView["value"], actorLabel: string) {
  return {
    id,
    key: "MAX_CONCURRENT_AGENTS",
    previousValue: 3,
    newValue,
    actor: "usr_ada",
    actorLabel,
    reason: "their reason",
    createdAt: "2026-09-23T12:00:00.000Z",
  };
}

test("a second tab's save is refused, keeps what was typed, and offers both ways out", async (t) => {
  // QA: two tabs on /settings, the second store silently overwrote the first.
  const root = render(t);
  const field = () =>
    root.find((node) => node.props?.["aria-label"] === "Value of MAX_CONCURRENT_AGENTS");
  typeInto(field(), "9");
  typeInto(
    root.find(
      (node) => node.type === "input" && node.props?.["aria-label"] === "Reason for changing Capacity",
    ),
    "more capacity",
  );

  const won = entry("MAX_CONCURRENT_AGENTS", 5, {
    source: "stored",
    lastVersion: versionOf(12, 5, "ada@example.com"),
  });
  const sent = stubReplies(t, [
    {
      status: 409,
      body: {
        error: "settings_version_conflict",
        conflicts: [
          { key: "MAX_CONCURRENT_AGENTS", expectedVersion: 0, currentVersion: 12, setting: won },
        ],
      },
    },
    { status: 200, body: { settings: [{ ...won, value: 9, lastVersion: versionOf(13, 9, "me") }], versions: [] } },
  ]);

  await press(buttonLabelled(root, "Store 1 change"));

  // The save carried the version this tab loaded.
  assert.ok(sent[0], "the save never reached the worker");
  assert.deepEqual((sent[0].body as { expectedVersions?: unknown }).expectedVersions, {
    MAX_CONCURRENT_AGENTS: 0,
  });
  const rendered = text(root);
  assert.match(rendered, /Max concurrent agents was changed by ada@example\.com on /);
  assert.match(rendered, /it is now 5\./);
  assert.match(rendered, /Nothing was stored/);
  assert.equal(field().props.value, "9", "the typed value was thrown away");
  assert.equal(hasUnsavedSettings(), true, "the kept edit stopped counting as unsaved");

  // Storing over it is a decision made after seeing it, so it carries the
  // version that won.
  await press(buttonLabelled(root, "Store mine anyway"));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]?.body, {
    settings: { MAX_CONCURRENT_AGENTS: 9 },
    reason: "more capacity",
    expectedVersions: { MAX_CONCURRENT_AGENTS: 12 },
  });
  assert.match(text(root), /Stored 1 setting/);
});

test("taking theirs drops the edit to the conflicting key and stores nothing", async (t) => {
  const root = render(t);
  typeInto(
    root.find((node) => node.props?.["aria-label"] === "Value of MAX_CONCURRENT_AGENTS"),
    "9",
  );
  typeInto(
    root.find(
      (node) => node.type === "input" && node.props?.["aria-label"] === "Reason for changing Capacity",
    ),
    "more capacity",
  );
  const won = entry("MAX_CONCURRENT_AGENTS", 5, {
    source: "stored",
    lastVersion: versionOf(12, 5, "ada@example.com"),
  });
  const sent = stubReplies(t, [
    {
      status: 409,
      body: {
        error: "settings_version_conflict",
        conflicts: [
          { key: "MAX_CONCURRENT_AGENTS", expectedVersion: 0, currentVersion: 12, setting: won },
        ],
      },
    },
  ]);
  await press(buttonLabelled(root, "Store 1 change"));
  await press(buttonLabelled(root, "Use theirs"));

  assert.equal(
    root.find((node) => node.props?.["aria-label"] === "Value of MAX_CONCURRENT_AGENTS").props.value,
    "5",
  );
  assert.equal(sent.length, 1, "taking theirs sent a request");
  assert.equal(hasUnsavedSettings(), false);
});

test("an owner removes a stored value after being told what takes over", async (t) => {
  const stored = entry("MAX_CONCURRENT_AGENTS", 7, {
    source: "stored",
    lastVersion: versionOf(4, 7, "Filip"),
    fallback: { value: 3, source: "default" },
  });
  const root = render(t, { settings: [stored], canReset: true });
  await press(buttonLabelled(root, "Remove stored value"));

  const dialog = text(root);
  assert.match(dialog, /Remove the stored value of Max concurrent agents\?/);
  assert.match(dialog, /3 takes over: the built-in default\./);
  const confirm = () =>
    root
      .findAll((node) => node.type === "button" && text(node).includes("Remove stored value"))
      .at(-1)!;
  assert.equal(confirm().props.disabled, true, "removal went ahead without a reason");

  typeInto(
    root.find((node) => node.type === "input" && node.props?.placeholder === "Why is this going back? (required)"),
    "back to the default",
  );
  const sent = stubReplies(t, [
    {
      status: 200,
      body: {
        removed: true,
        setting: entry("MAX_CONCURRENT_AGENTS", 3, {
          source: "default",
          lastVersion: versionOf(5, 3, "Filip"),
          fallback: { value: 3, source: "default" },
        }),
      },
    },
  ]);
  await press(confirm());

  assert.deepEqual(sent, [
    {
      url: "/api/settings/reset",
      method: "POST",
      body: { key: "MAX_CONCURRENT_AGENTS", reason: "back to the default", expectedVersion: 4 },
    },
  ]);
  assert.match(text(root), /Removed the stored value of Max concurrent agents\. It now resolves to 3 \(default\)\./);
  assert.equal(
    root.findAll((node) => node.type === "button" && text(node).includes("Remove stored value")).length,
    0,
    "a value that is no longer stored still offered removal",
  );
});

test("an admin is offered removal of a stored value, and a member is offered nothing", (t) => {
  // The props settings-data.tsx derives from the session role, so this follows
  // the shared rule rather than a flag the test picked.
  const stored = entry("MAX_CONCURRENT_AGENTS", 7, { source: "stored" });
  const removeButtons = (root: ReactTestInstance) =>
    root.findAll((node) => node.type === "button" && text(node).includes("Remove stored value"));

  const admin = render(t, {
    settings: [stored],
    canEdit: canEditSettings("admin"),
    canReset: canResetSettings("admin"),
  });
  assert.ok(removeButtons(admin).length > 0, "an admin was not offered removal");
  assert.doesNotMatch(text(admin), /Only an owner/);

  const member = render(t, {
    settings: [stored],
    canEdit: canEditSettings("member"),
    canReset: canResetSettings("member"),
  });
  assert.equal(removeButtons(member).length, 0, "a member was offered a removal the worker refuses");
  assert.doesNotMatch(text(member), /Only an owner/);
});

test("a removal refused because the value changed says nothing was removed and shows the new value", async (t) => {
  const stored = entry("MAX_CONCURRENT_AGENTS", 7, {
    source: "stored",
    lastVersion: versionOf(4, 7, "Filip"),
    fallback: { value: 3, source: "default" },
  });
  const root = render(t, { settings: [stored], canReset: true });
  await press(buttonLabelled(root, "Remove stored value"));
  typeInto(
    root.find((node) => node.type === "input" && node.props?.placeholder === "Why is this going back? (required)"),
    "back to the default",
  );
  stubReplies(t, [
    {
      status: 409,
      body: {
        error: "settings_version_conflict",
        conflicts: [
          {
            key: "MAX_CONCURRENT_AGENTS",
            expectedVersion: 4,
            currentVersion: 9,
            setting: entry("MAX_CONCURRENT_AGENTS", 8, {
              source: "stored",
              lastVersion: versionOf(9, 8, "ada@example.com"),
              fallback: { value: 3, source: "default" },
            }),
          },
        ],
      },
    },
  ]);
  await press(
    root
      .findAll((node) => node.type === "button" && text(node).includes("Remove stored value"))
      .at(-1)!,
  );

  const rendered = text(root);
  assert.match(rendered, /changed by ada@example\.com/);
  assert.match(rendered, /Nothing was removed/);
  assert.doesNotMatch(rendered, /Store mine anyway/);
  assert.equal(
    root.find((node) => node.props?.["aria-label"] === "Value of MAX_CONCURRENT_AGENTS").props.value,
    "8",
  );
});

test("a panel that does not decide about removal offers no removal", (t) => {
  // The Memory panel mounts the group form without saying who may remove.
  resetUnsavedSettings();
  const stored = entry("MAX_CONCURRENT_AGENTS", 7, { source: "stored" });
  const [group] = groupSettings([stored]);
  assert.ok(group);
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={{ refresh: () => {} } as never}>
        <SettingsGroupForm group={group} canEdit />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    resetUnsavedSettings();
  });
  assert.doesNotMatch(text(renderer.root), /Remove stored value/);
});
