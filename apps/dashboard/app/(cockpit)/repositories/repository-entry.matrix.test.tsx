// apps/dashboard/app/(cockpit)/repositories/repository-entry.matrix.test.tsx
//
// Two entry-screen rows the QA matrix found unpinned: the variable palette
// (U12) and the 390 px render (U15).
//
// U12 is a drift test, not a menu test. The palette itself is Tiptap and needs
// a DOM this runner does not have, so what is asserted is the LIST the screen
// hands it: `REPOSITORY_RULES_VARIABLES`, captured off the editor's props. That
// list is also what the renderer resolves against
// (`REPOSITORY_RULES_VARIABLE_NAMES`, packages/prompts/prompt-variables.ts), so
// if the menu ever stops being derived from it, the menu would offer a variable
// the compiled prompt leaves standing as literal braces -- which is the exact
// failure the row exists for. What this canNOT prove is that the rendered menu
// shows seven items and no eighth; that needs a browser.
//
// U15 carries the same limits as the list screen's copy of it: no DOM, no
// layout, no viewport. See the header of repositories-screen.matrix.test.tsx.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type {
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
} from "@shared/contracts";
import { REPOSITORY_RULES_VARIABLE_NAMES } from "@shared/prompts";

/** What the screen handed the prompt editor, most recent render last. */
const paletteCalls: Array<Array<{ name: string; description: string }>> = [];

// The same substitution the sibling suite makes, plus the one thing it throws
// away: the `variables` prop, which is the palette.
mock.module("../../../components/cockpit/prompt-editor/prompt-editor.tsx", {
  exports: {
    PromptEditor: ({
      value,
      onChange,
      disabled,
      variables,
    }: {
      value: string;
      onChange: (markdown: string) => void;
      disabled?: boolean;
      variables?: ReadonlyArray<{ name: string; description: string }>;
    }) => {
      if (variables) paletteCalls.push([...variables]);
      return React.createElement("textarea", {
        value,
        disabled,
        "data-prompt-editor": true,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      });
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RepositoryEntryScreen } = require("./repository-entry") as typeof import("./repository-entry");

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

const PHONE_WIDTH_PX = 390;

const REPOSITORY: RepositoryCatalogEntry = {
  id: 7,
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
};

function version(n: number): RepositoryProfileVersion {
  return {
    version: n,
    description: `description at v${n}`,
    rules: `rules at v${n}`,
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    batchTimeoutMinutes: null,
    checksVersion: n,
    actorId: "user-1",
    actorLabel: "Someone",
    reason: `reason for v${n}`,
    createdAt: "2026-09-01T00:00:00.000Z",
  } as RepositoryProfileVersion;
}

function render(t: TestContext): ReactTestInstance {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    if (String(url).startsWith("/api/repository-catalog/7/suggestions")) {
      return Promise.resolve(Response.json({ suggestions: [], nextCursor: null }));
    }
    return Promise.resolve(Response.json({}));
  }) as typeof globalThis.fetch;

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
        <RepositoryEntryScreen
          repository={REPOSITORY}
          currentProfile={version(3)}
          versions={[version(3), version(2)]}
          catalog={[REPOSITORY]}
          allowedEnv={undefined}
          memory={[]}
          canManage
        />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return renderer.root;
}

/** Click the tab whose label matches, the way an operator reaches it. */
function openTab(root: ReactTestInstance, label: RegExp): void {
  const button = root
    .findAll((node) => node.type === "button")
    .find((node) =>
      node.children.some((child) => typeof child === "string" && label.test(child)),
    );
  assert.ok(button, `no tab button matching ${label}`);
  act(() => {
    (button.props as { onClick: () => void }).onClick();
  });
}

function classNames(root: ReactTestInstance): string[] {
  return root
    .findAll(() => true)
    .map((node) => node.props?.className)
    .filter((value): value is string => typeof value === "string");
}

function pinnedWidthsPx(root: ReactTestInstance): number[] {
  const widths: number[] = [];
  for (const className of classNames(root)) {
    for (const token of className.split(/\s+/)) {
      if (token.includes(":")) continue;
      const match = /^(?:min-)?w-\[(\d+)px\]$/.exec(token);
      if (match) widths.push(Number(match[1]));
    }
  }
  return widths;
}

test("U12: the Rules editor is offered exactly the seven identity variables, and nothing else", (t) => {
  paletteCalls.length = 0;
  const root = render(t);
  openTab(root, /Rules/i);

  const palette = paletteCalls.at(-1);
  assert.ok(palette, "the Rules tab handed the editor a variable list");

  // Exactly the seven, in the order the contract declares them. Order matters
  // because it is the order of the menu somebody reads.
  assert.deepEqual(
    palette.map((variable) => variable.name),
    [...REPOSITORY_RULES_VARIABLE_NAMES],
  );

  // Every one of them carries the description the menu shows. A name with no
  // description is a menu entry that says nothing about what it renders.
  for (const variable of palette) {
    assert.equal(typeof variable.description, "string");
    assert.ok(variable.description.length > 0, `${variable.name} has no description`);
  }

  // And the ones deliberately kept out, named rather than merely counted: each
  // is prose somebody outside this deployment wrote, and rendering it under a
  // "Repository rules" heading is how a ticket reporter's words become an
  // instruction the agent believes an operator typed.
  const offered = new Set(palette.map((variable) => variable.name));
  for (const excluded of [
    "ticket_description",
    "ticket_title",
    "ticket_acceptance_criteria",
    "ticket_labels",
    "plan_markdown",
    "change_summary",
    "pr_title",
    "pr_review_feedback",
  ]) {
    assert.ok(!offered.has(excluded), `${excluded} must not be offered in a rules palette`);
  }
});

test("U15: the entry declares no width a 390 px phone cannot hold, and its tabs wrap", (t) => {
  const root = render(t);

  for (const width of pinnedWidthsPx(root)) {
    assert.ok(
      width <= PHONE_WIDTH_PX,
      `a ${width}px width is pinned on the entry and cannot fit a ${PHONE_WIDTH_PX}px viewport`,
    );
  }

  const wrapping = classNames(root).filter((className) => className.includes("flex-wrap"));
  assert.ok(
    wrapping.length >= 2,
    `expected the tab strip and the header to wrap; found ${wrapping.length} wrapping containers`,
  );
});

test("U15: every tab is reachable at phone width, none hidden below a breakpoint", (t) => {
  const root = render(t);

  // Five tabs, all rendered as buttons in the tree rather than collapsed into
  // a menu above a breakpoint. What this cannot say is whether they FIT; what
  // it can say is that a phone is not shown three of them.
  for (const label of [/Overview/i, /Rules/i, /Scripts/i, /Memory/i, /History/i]) {
    const found = root
      .findAll((node) => node.type === "button")
      .some((node) =>
        node.children.some((child) => typeof child === "string" && label.test(child)),
      );
    assert.ok(found, `no tab button matching ${label} at phone width`);
  }

  const hiddenUntilWide = classNames(root).filter(
    (className) =>
      /(^|\s)hidden(\s|$)/.test(className) && /(sm|md|lg):(flex|block|inline)/.test(className),
  );
  assert.deepEqual(
    hiddenUntilWide,
    [],
    "a control hidden below the sm breakpoint is a control a phone cannot reach",
  );
});
