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

import type {
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
} from "@shared/contracts";

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
    currentProfile?: RepositoryProfileVersion | null;
    memory?: React.ComponentProps<typeof RepositoryEntryScreen>["memory"];
    onSave?: (body: unknown) => Response;
    onDelete?: () => Response;
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
          currentProfile={options.currentProfile ?? version(3)}
          versions={options.versions ?? [version(3), version(2)]}
          catalog={[REPOSITORY]}
          allowedEnv={undefined}
          memory={options.memory ?? []}
          canManage
        />
      </AppRouterContext.Provider>,
    );
  });
  t.after(() => {
    act(() => renderer.unmount());
    globalThis.fetch = originalFetch;
  });
  return { root: renderer.root, calls };
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
