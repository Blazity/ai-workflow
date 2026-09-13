// apps/dashboard/app/(cockpit)/repositories/repository-entry.test.tsx
//
// The things the entry screen does that cannot be undone by reloading: it
// writes a profile, it restores an old version by saving it forward, and it
// erases a memory document. Each has its own guard and this file is those
// guards.
import assert from "node:assert/strict";
import test, { mock, type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type {
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
} from "@shared/contracts";
import { REPOSITORY_RELATIONSHIPS_MAX } from "@shared/contracts";

// Rules and Description are edited in the prompt editor now. It is Tiptap,
// which needs a DOM this runner does not have, so it is replaced by the
// smallest thing with the same contract: a value in, a markdown string out.
// What the screen does with that string is what these tests are about.
mock.module("../../../components/cockpit/prompt-editor/prompt-editor.tsx", {
  exports: {
    PromptEditor: ({
      value,
      onChange,
      disabled,
    }: {
      value: string;
      onChange: (markdown: string) => void;
      disabled?: boolean;
    }) =>
      React.createElement("textarea", {
        value,
        disabled,
        "data-prompt-editor": true,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      }),
  },
} as unknown as Parameters<typeof mock.module>[1]);

// `require` rather than a top-level `await import`: this package transpiles to
// CommonJS, and the screen has to be loaded AFTER the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RepositoryEntryScreen } = require("./repository-entry") as typeof import("./repository-entry");

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { self?: typeof globalThis }).self ??= globalThis;

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

function version(n: number, overrides: Partial<RepositoryProfileVersion> = {}) {
  return {
    version: n,
    description: `description at v${n}`,
    rules: `rules at v${n}`,
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    batchTimeoutMinutes: null,
    checksVersion: n,
    actorLabel: "Someone",
    reason: `reason for v${n}`,
    createdAt: "2026-09-0%d T00:00:00.000Z".replace("%d", String(n)),
    ...overrides,
  } as RepositoryProfileVersion;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface Harness {
  root: ReactTestInstance;
  calls: Call[];
  /** Every `window.history.replaceState` the screen made, in order. This is the
   *  history write a tab click is allowed to make: native, so `useSearchParams`
   *  stays in sync and nothing is refetched. */
  replaced: Array<{ url: string }>;
  /** Every App Router navigation the screen asked for. A tab click must make
   *  none: `router.replace` re-runs the route's server component, which throws
   *  away the history pages the History tab has already loaded. */
  routed: Array<{ url: string; kind: "push" | "replace"; scroll: unknown }>;
}

/**
 * Mounts the screen over a fetch stub answering by URL.
 *
 * By URL and not by turn: the History tab loads the suggestion history of its
 * own accord, so a queue keyed by position would hand that answer to a save.
 */
function render(
  t: TestContext,
  options: {
    versions?: RepositoryProfileVersion[];
    versionsHasMore?: boolean;
    currentProfile?: RepositoryProfileVersion | null;
    memory?: React.ComponentProps<typeof RepositoryEntryScreen>["memory"];
    onSave?: (body: unknown) => Response;
    onDelete?: () => Response;
    onVersions?: (url: string) => Response;
    /** Every repository this catalog holds, for the relationships editor. */
    catalog?: RepositoryCatalogEntry[];
    /** The query string the screen was opened on, as a link would carry it. */
    search?: string;
  } = {},
): Harness {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    calls.push({ url: String(url), method, body });
    if (String(url).startsWith("/api/repository-catalog/7/suggestions")) {
      return Promise.resolve(Response.json({ suggestions: [], nextCursor: null }));
    }
    if (String(url).startsWith("/api/repository-catalog/7/versions")) {
      return Promise.resolve(
        options.onVersions
          ? options.onVersions(String(url))
          : Response.json({ versions: [], hasMore: false }),
      );
    }
    if (String(url) === "/api/repository-catalog/7" && method === "PUT") {
      return Promise.resolve(
        options.onSave
          ? options.onSave(body)
          : Response.json({ repository: REPOSITORY, version: 4 }),
      );
    }
    if (String(url).startsWith("/api/memory")) {
      return Promise.resolve(options.onDelete ? options.onDelete() : Response.json({}));
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof globalThis.fetch;

  const replaced: Array<{ url: string }> = [];
  const routed: Array<{ url: string; kind: "push" | "replace"; scroll: unknown }> = [];
  const router = {
    refresh: () => {},
    push: (url: string, opts?: { scroll?: boolean }) => {
      routed.push({ url, kind: "push", scroll: opts?.scroll });
    },
    replace: (url: string, opts?: { scroll?: boolean }) => {
      routed.push({ url, kind: "replace", scroll: opts?.scroll });
    },
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };
  // The runner has no DOM, and the screen writes the open tab with the
  // browser's own replaceState rather than the router's. Installed for the
  // lifetime of one render and removed after it, so nothing else in this file
  // starts believing it is in a browser.
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    history: {
      replaceState: (_state: unknown, _unused: string, url: string) => {
        replaced.push({ url });
      },
    },
    // The unsaved-work guard asks the same object for these. No-ops: what that
    // guard does is its own test's business, and a `window` missing them would
    // throw inside an effect that has nothing to do with tabs.
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <AppRouterContext.Provider value={router as never}>
        <PathnameContext.Provider value="/repositories/7">
          <SearchParamsContext.Provider value={new URLSearchParams(options.search ?? "")}>
            <RepositoryEntryScreen
              repository={REPOSITORY}
              currentProfile={options.currentProfile ?? version(3)}
              versions={options.versions ?? [version(3), version(2)]}
              versionsHasMore={options.versionsHasMore ?? false}
              catalog={options.catalog ?? [REPOSITORY]}
              allowedEnv={undefined}
              memory={options.memory ?? []}
              canManage
            />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  return { root: renderer.root, calls, replaced, routed };
}

/** Every string the tree renders, flattened. Runs of whitespace collapse: JSX
 *  splits `Erase {docPath}` into two children and joining them would otherwise
 *  produce a double space no assertion could be written against. */
function text(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((child) => child.children.filter((c) => typeof c === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const matches = root
    .findAll((node) => node.type === "button")
    .filter((node) => text(node).includes(label));
  assert.equal(matches.length, 1, `expected exactly one button containing "${label}"`);
  return matches[0];
}

function openTab(root: ReactTestInstance, label: string) {
  act(() => {
    button(root, label).props.onClick();
  });
}

/** Types into the prompt editor under the field with this label. */
function typeInto(root: ReactTestInstance, label: string, value: string) {
  const field = root
    .findByProps({ "aria-label": label })
    .findByProps({ "data-prompt-editor": true });
  act(() => field.props.onChange({ target: { value } }));
}

function typeReason(root: ReactTestInstance, value: string) {
  act(() =>
    root.findByProps({ "aria-label": "Reason" }).props.onChange({ target: { value } }),
  );
}

test("the save carries the version this screen loaded, and only the field that moved", async (t) => {
  // No pre-flight read any more: the write itself is conditional on the token,
  // so there is no window between a read and a write for the other admin's
  // edit to land in.
  const harness = render(t);

  openTab(harness.root, "Rules");
  typeInto(harness.root, "Rules", "new rules");
  typeReason(harness.root, "because");

  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ["PUT"],
    "a save is one request now",
  );
  const body = harness.calls[0].body as Record<string, unknown>;
  assert.equal(body.rules, "new rules");
  assert.equal(body.expectedProfileVersion, 3);
  assert.equal("description" in body, false);
  assert.equal("scriptGroups" in body, false);
  assert.match(text(harness.root), /Saved as version 4/);
});

test("a 409 says which version the profile moved to and keeps the draft", async (t) => {
  const harness = render(t, {
    onSave: () =>
      Response.json({ error: "repository_profile_conflict", currentVersion: 5 }, {
        status: 409,
      }),
  });

  openTab(harness.root, "Rules");
  typeInto(harness.root, "Rules", "new rules");
  typeReason(harness.root, "because");

  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.match(
    text(harness.root),
    /This repository moved to v5 while you were editing\. Reload to see the change before saving\./,
  );
  // The draft is still on screen and still unsaved, so nothing the operator
  // typed was lost by the refusal.
  assert.match(text(harness.root), /Unsaved changes: rules/);
});

test("a save the worker answers as unchanged is reported as such, not as a version", async (t) => {
  const harness = render(t, {
    onSave: () =>
      Response.json({ repository: REPOSITORY, version: 3, unchanged: true, changedFields: [] }),
  });

  openTab(harness.root, "Rules");
  typeInto(harness.root, "Rules", "new rules");
  typeReason(harness.root, "because");

  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.match(text(harness.root), /Nothing was saved/);
  assert.doesNotMatch(text(harness.root), /Saved as version/);
});

test("a refused group name still points at the Scripts tab", async (t) => {
  // A Rules save no longer carries the groups, so this refusal can only come
  // from a value the request did send. The notice still names the tab, because
  // that is where the operator has to go.
  const harness = render(t, {
    onSave: () =>
      Response.json(
        { error: "invalid_script_group_name: Bad Name (must be lower case)" },
        { status: 400 },
      ),
  });

  openTab(harness.root, "Rules");
  typeInto(harness.root, "Rules", "new rules");
  typeReason(harness.root, "because");
  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.match(text(harness.root), /A script group name is not valid/);
  assert.match(text(harness.root), /The Scripts tab holds/);
});

test("the rules editor hands the markdown back unchanged", async (t) => {
  // The stored value is markdown and the editor is a markdown editor: what the
  // screen sends must be exactly what the editor produced, headings and all.
  const markdown = "# Rules\n\n- never force push\n";
  const harness = render(t);

  openTab(harness.root, "Rules");
  typeInto(harness.root, "Rules", markdown);
  typeReason(harness.root, "because");
  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.equal((harness.calls[0].body as { rules: string }).rules, markdown);
});

test("restoring an old version saves it forward with a reason that says what it was", async (t) => {
  const harness = render(t);
  openTab(harness.root, "History");

  assert.match(text(harness.root), /Restoring mints a NEW version/);
  const restores = harness.root
    .findAll((node) => node.type === "button" && text(node).includes("Restore this version"));
  assert.equal(restores.length, 1, "only the versions that are not current are restorable");

  await act(async () => {
    restores[0].props.onClick();
  });

  const put = harness.calls.find((call) => call.method === "PUT");
  assert.ok(put, "restore sends a PUT like any other save");
  const body = put.body as {
    reason: string;
    description: string;
    rules: string;
    expectedProfileVersion: number;
  };
  assert.equal(body.reason, "Restore v2");
  assert.equal(body.description, "description at v2");
  assert.equal(body.rules, "rules at v2");
  assert.equal(body.expectedProfileVersion, 3);
});

const MEMORY = [
  {
    subjectKey: "repo:github:acme/web",
    docPath: "facts",
    document: {
      subjectKey: "repo:github:acme/web",
      docPath: "facts",
      content: "The storefront runs on Next.js.",
      bytes: 30,
      updatedAt: "2026-09-02T00:00:00.000Z",
      sourceRunId: "run-1",
    },
  },
  {
    subjectKey: "repo:github:acme/web",
    docPath: "lessons",
    document: {
      subjectKey: "repo:github:acme/web",
      docPath: "lessons",
      content: "Do not run the codegen twice.",
      bytes: 29,
      updatedAt: "2026-09-02T00:00:00.000Z",
      sourceRunId: "run-2",
    },
  },
] as unknown as React.ComponentProps<typeof RepositoryEntryScreen>["memory"];

test("erasing a memory document takes two clicks, and the first one sends nothing", async (t) => {
  const harness = render(t, { memory: MEMORY });
  openTab(harness.root, "Memory");

  await act(async () => {
    button(harness.root, "Erase facts").props.onClick();
  });

  assert.equal(harness.calls.length, 0, "arming is not deleting");
  assert.match(text(harness.root), /Erase facts from the store\?/);
  assert.match(text(harness.root), /A later run can learn it again\./);

  await act(async () => {
    button(harness.root, "Confirm erase").props.onClick();
  });

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].method, "DELETE");
  assert.match(text(harness.root), /Erased\./);
});

test("the confirmation does not carry from one document to the next", async (t) => {
  const harness = render(t, { memory: MEMORY });
  openTab(harness.root, "Memory");

  await act(async () => {
    button(harness.root, "Erase facts").props.onClick();
  });
  await act(async () => {
    button(harness.root, "Erase lessons").props.onClick();
  });

  // One armed document at a time: the first row is back to its plain button, so
  // a second click there arms rather than erases.
  assert.equal(
    harness.root.findAll(
      (node) => node.type === "button" && text(node).includes("Confirm erase"),
    ).length,
    1,
  );
  assert.match(text(harness.root), /Erase lessons from the store\?/);
  assert.doesNotMatch(text(harness.root), /Erase facts from the store\?/);
  assert.equal(harness.calls.length, 0);
});

test("cancelling an armed erase leaves the document alone", async (t) => {
  const harness = render(t, { memory: MEMORY });
  openTab(harness.root, "Memory");

  await act(async () => {
    button(harness.root, "Erase facts").props.onClick();
  });
  await act(async () => {
    button(harness.root, "Cancel").props.onClick();
  });

  assert.equal(harness.calls.length, 0);
  assert.match(text(harness.root), /The storefront runs on Next\.js\./);
  assert.doesNotMatch(text(harness.root), /Erased\./);
});

/** Types into the checks ceiling input and returns it. */
function typeCeiling(root: ReactTestInstance, value: string): ReactTestInstance {
  const field = root.findByProps({ "aria-label": "Checks ceiling" });
  act(() => field.props.onChange({ target: { value } }));
  return root.findByProps({ "aria-label": "Checks ceiling" });
}

test("a checks ceiling the contract would refuse disables Save and stays on screen", async (t) => {
  // The field never pushes a refused value into the draft, so before this the
  // Save button stayed armed and saved the previous number while the screen
  // showed the new one. Blocking the save is what makes the two agree.
  const harness = render(t);
  openTab(harness.root, "Scripts");

  typeCeiling(harness.root, "30");
  typeReason(harness.root, "because");
  assert.equal(button(harness.root, "Save changes").props.disabled, false);

  const overMax = typeCeiling(harness.root, "999");
  assert.equal(button(harness.root, "Save changes").props.disabled, true);
  assert.match(text(harness.root), /Save is disabled: the checks ceiling must be a whole number of minutes between 1 and 120, or empty/);
  assert.equal(overMax.props.value, "999", "what was typed stays until it is fixed");

  typeCeiling(harness.root, "45");
  assert.equal(button(harness.root, "Save changes").props.disabled, false);
  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.equal(
    (harness.calls[0].body as { batchTimeoutMinutes: number }).batchTimeoutMinutes,
    45,
  );
});

test("zero and a fraction are refused the same way, and an empty ceiling is not", async (t) => {
  // The saved profile already claims a ceiling, so withdrawing it is a change
  // like any other and the Save bar stays on screen through the whole test.
  const harness = render(t, {
    currentProfile: version(3, { batchTimeoutMinutes: 30 }),
  });
  openTab(harness.root, "Scripts");
  typeCeiling(harness.root, "45");
  typeReason(harness.root, "because");

  for (const refused of ["0", "1.5", "x"]) {
    typeCeiling(harness.root, refused);
    assert.equal(
      button(harness.root, "Save changes").props.disabled,
      true,
      `"${refused}" is not a ceiling the route would accept`,
    );
  }

  // Blank is the claim being withdrawn, not a typo: the run keeps whatever the
  // operator configuration sets, which is what every repository did before the
  // field existed.
  typeCeiling(harness.root, "");
  assert.equal(button(harness.root, "Save changes").props.disabled, false);
  assert.doesNotMatch(text(harness.root), /Save is disabled: the checks ceiling/);
});

test("leaving the tab with a refused ceiling takes the blocker with it", async (t) => {
  // The typed text lives in the field, so the field going away takes it with
  // it and the input comes back showing the draft's value. A blocker that
  // outlived the message would wedge Save behind something nothing renders.
  const harness = render(t);
  openTab(harness.root, "Scripts");

  typeCeiling(harness.root, "20");
  typeReason(harness.root, "because");
  typeCeiling(harness.root, "999");
  assert.equal(button(harness.root, "Save changes").props.disabled, true);

  openTab(harness.root, "Overview");
  assert.equal(button(harness.root, "Save changes").props.disabled, false);

  openTab(harness.root, "Scripts");
  assert.equal(
    harness.root.findByProps({ "aria-label": "Checks ceiling" }).props.value,
    "20",
    "the field returns showing the value the draft actually holds",
  );
});


// D14 / row U08. The open tab used to be local state, so a reload landed on
// Overview whatever was open and there was no link to "the Scripts tab of this
// repository" for a run failure or a Jira comment to point at.
test("a link that names a tab opens that tab", (t) => {
  const harness = render(t, { search: "tab=scripts" });

  assert.match(text(harness.root), /Script groups/);
  // And nothing was replaced on the way in: a load is not a tab switch.
  assert.deepEqual(harness.replaced, []);
});

test("no parameter opens the tab it always did", (t) => {
  const harness = render(t);

  assert.match(text(harness.root), /Overview/);
  assert.deepEqual(harness.replaced, []);
});

test("a parameter nobody wrote opens the entry rather than breaking it", (t) => {
  // A stale link, or a typed one. The screen opens; it does not blank.
  const harness = render(t, { search: "tab=scriptz" });

  assert.match(text(harness.root), /Overview/);
});

test("switching tabs replaces the parameter without navigating", (t) => {
  const harness = render(t, { search: "tab=overview&suggestion=open" });

  openTab(harness.root, "Rules");

  assert.equal(harness.replaced.length, 1);
  assert.match(harness.replaced[0].url, /^\/repositories\/7\?/);
  const params = new URLSearchParams(harness.replaced[0].url.split("?")[1]);
  assert.equal(params.get("tab"), "rules");
  // Every other parameter on the URL survives the switch.
  assert.equal(params.get("suggestion"), "open");
  // The history write is the browser's own, so no navigation was started and
  // the route's server component was not re-run.
  assert.deepEqual(harness.routed, []);
  // And the tab moved without waiting for anything to come back.
  assert.match(text(harness.root), /Repository rules/);
});

// D5 / row P34. The versions route is paged, so the server sends the newest
// page and the tab asks for the rest only when a reader asks for it.
test("the History tab offers Load more only while older versions exist", (t) => {
  const withMore = render(t, { versionsHasMore: true, search: "tab=history" });
  assert.equal(
    withMore.root.findAll(
      (node) => node.type === "button" && text(node).includes("Load more"),
    ).length,
    1,
  );

  const complete = render(t, { versionsHasMore: false, search: "tab=history" });
  assert.equal(
    complete.root.findAll(
      (node) => node.type === "button" && text(node).includes("Load more"),
    ).length,
    0,
  );
});

test("Load more asks for what is older than the oldest row it is showing", async (t) => {
  const harness = render(t, {
    versions: [version(3), version(2)],
    versionsHasMore: true,
    search: "tab=history",
    onVersions: () => Response.json({ versions: [version(1)], hasMore: false }),
  });

  await act(async () => {
    await button(harness.root, "Load more").props.onClick();
  });

  const asked = harness.calls.filter((call) => call.url.includes("/versions"));
  assert.equal(asked.length, 1);
  // The cursor is the version number of the last row on screen, not an offset:
  // rows are only ever appended, so a version number cannot shift under a
  // reader the way an offset would.
  assert.match(asked[0].url, /before=2/);
  // The older page is appended rather than replacing what was rendered.
  const rendered = text(harness.root);
  assert.match(rendered, /reason for v3/);
  assert.match(rendered, /reason for v1/);
  // And the button is gone, because the answer said there is nothing older.
  assert.equal(
    harness.root.findAll(
      (node) => node.type === "button" && text(node).includes("Load more"),
    ).length,
    0,
  );
});

// F8. The tab param used to be written with `router.replace`, which re-runs
// this route's server component: the entry is refetched and the paged history
// is handed back as the first page, so a reader who had loaded three pages and
// glanced at Rules came back to one.
test("a tab switch keeps the history pages already loaded", async (t) => {
  const harness = render(t, {
    versions: [version(3), version(2)],
    versionsHasMore: true,
    search: "tab=history",
    onVersions: () => Response.json({ versions: [version(1)], hasMore: false }),
  });

  await act(async () => {
    await button(harness.root, "Load more").props.onClick();
  });
  assert.match(text(harness.root), /reason for v1/);

  openTab(harness.root, "Overview");
  openTab(harness.root, "History");

  // The older page is still on screen, and nothing went back to the server for
  // it: one versions call in total, the one Load more made.
  assert.match(text(harness.root), /reason for v1/);
  assert.equal(harness.calls.filter((call) => call.url.includes("/versions")).length, 1);
  assert.deepEqual(harness.routed, []);
  // Both switches wrote the param, natively.
  assert.equal(harness.replaced.length, 2);
});

// D3 / row P24. The save is permissive on purpose (the documented uv preset is
// exactly this shape), so what the Scripts tab owes the operator is the warning
// the suggestion path never had to show.
test("a command that downloads and runs remote code is warned about beside it", (t) => {
  const harness = render(t, {
    search: "tab=scripts",
    currentProfile: version(3, {
      scriptGroups: {
        provider: "github",
        repoPath: "acme/web",
        setup: ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
        groups: { test: { commands: ["uv run pytest"] } },
      },
    }),
  });

  const warnings = harness.root.findByProps({ "aria-label": "Remote execution warnings" });
  const rendered = text(warnings);
  assert.match(rendered, /curl -LsSf https:\/\/astral\.sh\/uv\/install\.sh \| sh/);
  assert.match(rendered, /setup/);
  assert.match(rendered, /Suggestions never propose it; saving it is your decision\./);
  // Non-blocking by construction: it is a status region, not a refusal, and it
  // disables nothing. The documented uv setup preset is exactly this shape, so
  // refusing it here would refuse the preset the repository publishes.
  assert.equal(warnings.props.role, "status");
});

test("an ordinary scripts entry raises no warning at all", (t) => {
  const harness = render(t, {
    search: "tab=scripts",
    currentProfile: version(3, {
      scriptGroups: {
        provider: "github",
        repoPath: "acme/web",
        groups: { test: { commands: ["pnpm test"] } },
      },
    }),
  });

  assert.equal(
    harness.root.findAll(
      (node) => node.props["aria-label"] === "Remote execution warnings",
    ).length,
    0,
  );
});

// D12 / row P30. The contract refuses the same repository twice, so the form
// says so before the Save bar finds out from a 400.
test("relating the same repository twice is refused by the form, not by the save", (t) => {
  const other: RepositoryCatalogEntry = {
    ...REPOSITORY,
    id: 8,
    path: "acme/api",
    displayName: "API",
  };
  const harness = render(t, {
    catalog: [REPOSITORY, other],
    currentProfile: version(3, {
      relationships: [{ repositoryId: 8, label: "the client" }],
    }),
  });

  act(() => {
    harness.root
      .findByProps({ "aria-label": "Related repository" })
      .props.onChange({ target: { value: "8" } });
  });
  act(() => {
    harness.root
      .findByProps({ "aria-label": "Relationship label" })
      .props.onChange({ target: { value: "again" } });
  });

  assert.equal(button(harness.root, "Add").props.disabled, true);
  assert.match(text(harness.root), /This repository is already related\./);
});

// F7. The contract caps relationships at 50 and refuses the WHOLE body over it,
// with a zod message about an array length, so a 51st add used to take the
// description and the rules edited beside it down with the save.
test("the 51st relationship is refused by the form, with the count in view", (t) => {
  const catalog: RepositoryCatalogEntry[] = [
    REPOSITORY,
    ...Array.from({ length: REPOSITORY_RELATIONSHIPS_MAX + 1 }, (_unused, index) => ({
      ...REPOSITORY,
      id: 100 + index,
      path: `acme/related-${index}`,
    })),
  ];
  const harness = render(t, {
    catalog,
    currentProfile: version(3, {
      relationships: Array.from(
        { length: REPOSITORY_RELATIONSHIPS_MAX },
        (_unused, index) => ({ repositoryId: 100 + index, label: "calls" }),
      ),
    }),
  });

  // The one repository in the catalog this profile is NOT already related to,
  // so the refusal on screen is the cap and not the duplicate rule.
  act(() => {
    harness.root
      .findByProps({ "aria-label": "Related repository" })
      .props.onChange({ target: { value: String(100 + REPOSITORY_RELATIONSHIPS_MAX) } });
  });
  act(() => {
    harness.root
      .findByProps({ "aria-label": "Relationship label" })
      .props.onChange({ target: { value: "one too many" } });
  });

  assert.equal(button(harness.root, "Add").props.disabled, true);
  assert.match(text(harness.root), /at most 50 relationships/);
  // And the count is on screen before the cap is reached, not only at it.
  assert.match(text(harness.root), /50 of 50/);
});
