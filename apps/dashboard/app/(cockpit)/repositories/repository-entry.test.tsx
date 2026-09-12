// apps/dashboard/app/(cockpit)/repositories/repository-entry.test.tsx
//
// The three things the entry screen does that cannot be undone by reloading:
// it saves a whole profile over whatever is stored, it restores an old version
// by saving it forward, and it erases a memory document. Each has its own guard
// and this file is those guards.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type {
  RepositoryCatalogEntry,
  RepositoryProfileVersion,
} from "@shared/contracts";

import { RepositoryEntryScreen } from "./repository-entry";

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
 * By URL and not by turn: every save is now two requests, the pre-flight read
 * and the write, so a queue keyed by position would hand the write's answer to
 * the read.
 */
function render(
  t: TestContext,
  options: {
    versions?: RepositoryProfileVersion[];
    currentProfile?: RepositoryProfileVersion | null;
    memory?: React.ComponentProps<typeof RepositoryEntryScreen>["memory"];
    storedVersion?: number;
    onPreflight?: () => Response;
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
    if (String(url) === "/api/repository-catalog/7" && method === "GET") {
      if (options.onPreflight) return Promise.resolve(options.onPreflight());
      return Promise.resolve(
        Response.json({
          repository: {
            ...REPOSITORY,
            profileVersion: options.storedVersion ?? REPOSITORY.profileVersion,
          },
          currentProfile: null,
        }),
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

test("a profile that moved while the screen held a draft refuses the save instead of overwriting it", async (t) => {
  // The upsert sends the whole merged profile and the route takes no version
  // token, so a save on a stale baseline REPLACES the other edit. The screen
  // re-reads the row first and stops.
  const harness = render(t, { storedVersion: 5 });

  openTab(harness.root, "Rules");
  const rules = harness.root.findByProps({ "aria-label": "Rules" });
  act(() => rules.props.onChange({ target: { value: "new rules" } }));
  const reason = harness.root.findByProps({ "aria-label": "Reason" });
  act(() => reason.props.onChange({ target: { value: "because" } }));

  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.match(
    text(harness.root),
    /This repository moved to v5 while you were editing\. Reload to see the change before saving\./,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === "PUT").length,
    0,
    "a refused save must not have sent anything",
  );
});

test("an unmoved profile is saved, and the pre-flight read runs before the write", async (t) => {
  const harness = render(t);

  openTab(harness.root, "Rules");
  act(() =>
    harness.root
      .findByProps({ "aria-label": "Rules" })
      .props.onChange({ target: { value: "new rules" } }),
  );
  act(() =>
    harness.root
      .findByProps({ "aria-label": "Reason" })
      .props.onChange({ target: { value: "because" } }),
  );

  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ["GET", "PUT"],
  );
  assert.match(text(harness.root), /Saved as version 4\./);
});

test("a group name the Scripts tab stored is blamed on the Scripts tab, not on what was edited", async (t) => {
  // Every save sends the whole profile, so a stored group name refuses a save
  // whose only edit was the Rules text.
  const harness = render(t, {
    currentProfile: version(3, {
      scriptGroups: {
        provider: "github",
        repoPath: "acme/web",
        groups: { "Bad Name": { commands: ["pnpm test"] } },
      } as unknown as Record<string, unknown>,
    }),
    onSave: () =>
      Response.json(
        { error: "invalid_script_group_name: Bad Name (must be lower case)" },
        { status: 400 },
      ),
  });

  openTab(harness.root, "Rules");
  act(() =>
    harness.root
      .findByProps({ "aria-label": "Rules" })
      .props.onChange({ target: { value: "new rules" } }),
  );
  act(() =>
    harness.root
      .findByProps({ "aria-label": "Reason" })
      .props.onChange({ target: { value: "because" } }),
  );
  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  const rendered = text(harness.root);
  assert.match(rendered, /The stored script group "Bad Name" is not valid/);
  assert.match(rendered, /The Scripts tab holds it/);
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
  assert.ok(put, "restore sends the same full-profile PUT");
  const body = put.body as { reason: string; description: string; rules: string };
  assert.equal(body.reason, "Restore v2");
  assert.equal(body.description, "description at v2");
  assert.equal(body.rules, "rules at v2");
});

test("a restore refuses on a moved profile exactly as a save does", async (t) => {
  const harness = render(t, { storedVersion: 9 });
  openTab(harness.root, "History");

  await act(async () => {
    harness.root
      .findAll((node) => node.type === "button" && text(node).includes("Restore this version"))[0]
      .props.onClick();
  });

  assert.match(text(harness.root), /This repository moved to v9 while you were editing/);
  assert.equal(harness.calls.filter((call) => call.method === "PUT").length, 0);
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

test("a pre-flight read that fails stops the save instead of quietly turning the guard off", async (t) => {
  // "Could not read" is not "unmoved". Treating it as a pass would mean one
  // flaky GET lets a stale full-profile overwrite through, which is the exact
  // outcome the pre-flight exists to prevent.
  const harness = render(t, {
    onPreflight: () => Response.json({ error: "nope" }, { status: 503 }),
  });

  openTab(harness.root, "Rules");
  act(() =>
    harness.root
      .findByProps({ "aria-label": "Rules" })
      .props.onChange({ target: { value: "new rules" } }),
  );
  act(() =>
    harness.root
      .findByProps({ "aria-label": "Reason" })
      .props.onChange({ target: { value: "because" } }),
  );
  await act(async () => {
    button(harness.root, "Save changes").props.onClick();
  });

  assert.match(
    text(harness.root),
    /The current version could not be read, so this save was not sent\. Try again\./,
  );
  assert.equal(harness.calls.filter((call) => call.method === "PUT").length, 0);
});
