// The Settings area's tabs, for the two roles that meet them and for the
// person who arrived on a URL they had bookmarked.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { CockpitCtx } from "@/components/cockpit/context";

import { SettingsTabs } from "./settings-tabs";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(
  t: TestContext,
  pathname: string,
  canManageUsers: boolean,
  navigate: (href: string) => boolean = () => true,
): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <PathnameContext.Provider value={pathname}>
        <CockpitCtx.Provider value={{ navigate, canManageUsers } as never}>
          <SettingsTabs />
        </CockpitCtx.Provider>
      </PathnameContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

function tabs(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === "a")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"));
}

test("an administrator finds System health and Users where the sidebar used to have them", (t) => {
  const root = render(t, "/settings", true);
  assert.deepEqual(tabs(root), ["Settings", "System health", "Users"]);
});

test("a member sees the settings and no tab strip", (t) => {
  // The two administrative screens were already hidden from a member's
  // sidebar, and offering a tab that answers 403 would be worse than hiding
  // it. The worker is still what refuses the reads behind them.
  const root = render(t, "/settings", false);
  assert.equal(root.findAll((node) => node.type === "a").length, 0);
});

test("the tab the URL names is the one marked current", (t) => {
  for (const [pathname, expected] of [
    ["/settings", "Settings"],
    ["/settings/health", "System health"],
    ["/settings/users", "Users"],
  ] as const) {
    const root = render(t, pathname, true);
    const current = root
      .findAll((node) => node.type === "a" && node.props["aria-current"] === "page")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"));
    assert.deepEqual(current, [expected], pathname);
  }
});

test("a tab navigates through the cockpit, so unsaved settings are asked about", (t) => {
  // Nine settings forms mount on this screen at once. Clicking Users while one
  // of them holds an edit has to ask, and a plain link never would.
  const asked: string[] = [];
  const root = render(t, "/settings", true, (href) => {
    asked.push(href);
    return true;
  });
  const users = root.find(
    (node) => node.type === "a" && node.children.includes("Users"),
  );
  act(() =>
    users.props.onClick({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
    }),
  );
  assert.deepEqual(asked, ["/settings/users"]);
});
