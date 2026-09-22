import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type {
  RunBlockStatusesResponse,
  WorkflowBlockContract,
  WorkflowDefinitionDetailResponse,
  WorkflowDefinitionMeta,
  WorkflowEditorOptions,
} from "@shared/contracts";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { WorkflowEditorScreen } from "./workflow-editor";

// The editor refreshes its block registry through the app router when an
// integration is connected or switched off somewhere else, so rendering it
// needs a router mounted.
const ROUTER = {
  refresh: () => {},
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: globalThis.setTimeout as unknown as Window["setTimeout"],
  clearTimeout: globalThis.clearTimeout as unknown as Window["clearTimeout"],
  innerWidth: 1440,
  innerHeight: 900,
  matchMedia: () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
  sessionStorage: {
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {},
    key: () => null,
    length: 0,
  },
} satisfies Partial<Window> });

const seed = {
  schemaVersion: 2 as const,
  nodes: [
    {
      id: "trigger",
      type: "trigger_ticket_ai" as const,
      x: 0,
      y: 0,
      configuration: {},
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [],
};
const triggerContract = {
  type: "trigger_ticket_ai",
  presentation: {
    group: "trigger",
    label: "Ticket",
    description: "Ticket trigger",
    color: "#123456",
    softColor: "#eef0f2",
    glyph: "T",
  },
  defaults: {},
  ports: ["next"],
  allowsFailurePort: false,
  inputs: {},
  additionalInputs: [],
  output: {
    schema: { type: "unknown" },
    bindingSchema: { type: "unknown" },
    statusVariants: ["ok"],
  },
  availability: { available: true, unavailableReason: null },
} satisfies WorkflowBlockContract;

function meta(id: number, name: string): WorkflowDefinitionMeta {
  return {
    id,
    name,
    enabled: true,
    deployedSchema: "legacy-v1",
    retiredMessage: RETIRED_SCHEMA_MESSAGE,
    triggerTypes: [],
    currentVersion: 1,
    draftRevision: 1,
    layoutRevision: 1,
    deployedVersion: 1,
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function detail(id: number, name: string): WorkflowDefinitionDetailResponse {
  const definition = { schemaVersion: 1, marker: name };
  const version = {
    definitionId: id,
    version: 1,
    createdAt: "2026-09-10T00:00:00.000Z",
    createdById: "admin",
    createdByLabel: "Admin",
    restoredFromVersion: null,
    schema: "legacy-v1" as const,
    definition,
  };
  return {
    meta: meta(id, name),
    draft: null,
    layout: { nodes: { trigger: { x: 0, y: 0 } }, edges: {} },
    deployed: version,
    current: version,
    versions: [version],
  };
}

function savedDetail(id: number, name: string) {
  return {
    meta: { ...meta(id, name), draftRevision: 2 },
    draft: seed,
    validation: {
      valid: true,
      issues: [],
      nodeContracts: {},
      availableValuesByNode: {},
    },
    validationError: null,
  };
}

function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(" ");
  if (value && typeof value === "object" && "children" in value) {
    return textOf((value as { children?: unknown }).children);
  }
  return "";
}

/** What `settle` watches: the reads this screen has out, and how many it has
 *  started, so a turn that started another one is not mistaken for quiet.
 *  One render per test, and this file's tests run one at a time. */
interface Reads {
  inFlight: number;
  started: number;
}
let reads: Reads = { inFlight: 0, started: 0 };

/**
 * Installs `handler` as the fetch for one test, counting what is out.
 *
 * Every answer lands a turn later, the way a response does: resolving in the
 * caller's own microtask is what let a counted wait look reliable.
 * `FIXTURE_SLOW_MS` delays every answer by that many milliseconds, which is how
 * this harness reproduces a runner slow enough to break a counted wait.
 */
function installFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  // The count belongs to this installation, not to the file: a test may end
  // while an answer is still on its way, and a count the next test had zeroed
  // would go negative when that answer lands, so nothing would ever look quiet
  // again. A leftover answer decrements the count of the test it belongs to,
  // where nobody is watching any more.
  const mine: Reads = { inFlight: 0, started: 0 };
  reads = mine;
  return mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    mine.inFlight += 1;
    mine.started += 1;
    const answer = async () => {
      const slow = Number(process.env.FIXTURE_SLOW_MS ?? 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(slow, 0)));
      return handler(url, init);
    };
    return answer().finally(() => {
      mine.inFlight -= 1;
    });
  });
}

/** One turn of what a browser does between two paints: the microtasks a
 *  resolved promise queues, and the macrotask a fetch body lands on. */
async function turn() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Lets the chain of loads the editor starts finish, and waits for exactly that.
 *
 * NEVER A COUNT OF TURNS. Opening a definition reads it, then validates it,
 * then fetches its catalog, each a fetch whose body lands a turn or more after
 * the call. How many turns that costs is the runner's business, so a fixed
 * count passes on an idle machine and, on a loaded one, returns while a read is
 * still in flight: the assertion then reads an editor showing the definition it
 * has left and the failure looks like the product. Quiet is the condition those
 * assertions mean, and it is two things, because a read that lands usually
 * starts the next one: nothing in flight, and a turn that started nothing new.
 *
 * The bound is wall clock, so a slower machine waits longer instead of failing,
 * and a screen that never settles fails as a readable timeout rather than
 * hanging the suite.
 */
async function settle(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn();
    if (reads.inFlight === 0) {
      const started = reads.started;
      await turn();
      if (reads.inFlight === 0 && reads.started === started) return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`the editor was still loading after ${timeoutMs} ms: ${reads.inFlight} request(s) in flight`);
    }
  }
}

function button(root: ReactTestInstance, label: RegExp): ReactTestInstance {
  const found = root
    .findAllByType("button")
    .find((candidate) => label.test(textOf(candidate.children)));
  assert.ok(found, `button not found: ${label}`);
  return found;
}

test("retired list status wins and a legacy JSON toggle resets across a definition switch", async (t) => {
  const first = detail(1, "Legacy A");
  const second = detail(2, "Legacy B");
  const fetchMock = installFetch(async (url) => {
    if (url.endsWith("/api/workflow-definitions/2")) return Response.json(second);
    if (url.includes("/validate")) {
      return Response.json({ issues: [], nodeContracts: {}, availableValuesByNode: {} });
    }
    if (url.includes("/catalog")) {
      return Response.json({ nodeContracts: {}, catalogByNode: {} });
    }
    return Response.json({ profiles: [], repositories: [] });
  });
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>
      <WorkflowEditorScreen
        definitions={[first.meta, second.meta]}
        templates={[]}
        initialDetail={first}
        defaultDefinition={seed}
        options={{
          blockRegistry: { trigger_ticket_ai: triggerContract },
        } as unknown as WorkflowEditorOptions}
        liveBlocks={{
          generatedAt: "2026-09-10T00:00:00.000Z",
          run: null,
        } satisfies RunBlockStatusesResponse}
        canEdit
        canDispatch={false}
        actorLabel="Admin"
      />
      </AppRouterContext.Provider>,
    );
  });
  await settle();
  assert.equal(button(renderer.root, /^Deploy$/).props.disabled, true);
  assert.equal(button(renderer.root, /^Save draft$/).props.disabled, true);

  act(() => {
    button(renderer.root, /Legacy A/).props.onClick();
  });
  await settle();
  const listText = textOf(renderer.toJSON());
  assert.match(listText, /Retired schema/);
  assert.match(listText, /Stored enabled:\s+yes/);

  act(() => {
    button(renderer.root, /History/).props.onClick();
  });
  await settle();
  act(() => {
    button(renderer.root, /Show stored JSON/).props.onClick();
  });
  await settle();
  assert.match(textOf(renderer.toJSON()), /"marker": "Legacy A"/);

  act(() => {
    button(renderer.root, /Legacy A/).props.onClick();
  });
  await settle();
  act(() => {
    button(renderer.root, /^Legacy B/).props.onClick();
  });
  await settle();
  act(() => {
    button(renderer.root, /History/).props.onClick();
  });
  await settle();

  const switchedText = textOf(renderer.toJSON());
  assert.match(switchedText, /Show stored JSON/);
  assert.doesNotMatch(switchedText, /"marker": "Legacy B"/);
  assert.ok(fetchMock.mock.callCount() > 0);
  await act(async () => renderer.unmount());
});

test("a divergent legacy recovery seed does not autosave layout before semantic save", async (t) => {
  const legacy = detail(1, "Legacy recovery");
  legacy.layout.nodes.trigger = { x: 320, y: 180 };
  const writes: Array<{ method: string; url: string }> = [];
  installFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (method === "PUT" || method === "PATCH") writes.push({ method, url });
    if (method === "PUT") return Response.json(savedDetail(1, "Legacy recovery"));
    if (method === "PATCH") {
      return Response.json({
        meta: { ...meta(1, "Legacy recovery"), layoutRevision: 2 },
        layout: { nodes: { trigger: { x: 0, y: 0 } }, edges: {} },
      });
    }
    if (url.endsWith("/api/json-schema/inspect")) {
      return Response.json({
        deployable: true,
        dialect: "https://json-schema.org/draft/2020-12/schema",
        schema: { type: "unknown" },
        valueSchema: { type: "unknown" },
        issues: [],
      });
    }
    if (url.includes("/validate")) {
      return Response.json({ issues: [], nodeContracts: {}, availableValuesByNode: {} });
    }
    if (url.includes("/catalog")) {
      return Response.json({ nodeContracts: {}, catalogByNode: {} });
    }
    return Response.json({ profiles: [], repositories: [] });
  });
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <AppRouterContext.Provider value={ROUTER as never}>
      <WorkflowEditorScreen
        definitions={[legacy.meta]}
        templates={[]}
        initialDetail={legacy}
        defaultDefinition={seed}
        options={{
          blockRegistry: { trigger_ticket_ai: triggerContract },
        } as unknown as WorkflowEditorOptions}
        liveBlocks={{
          generatedAt: "2026-09-10T00:00:00.000Z",
          run: null,
        } satisfies RunBlockStatusesResponse}
        canEdit
        canDispatch={false}
        actorLabel="Admin"
        initialNodeId="trigger"
      />
      </AppRouterContext.Provider>,
    );
  });

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 650));
  });
  assert.equal(writes.length, 0);

  const numberInput = renderer.root
    .findAllByType("input")
    .find((input) => input.props.type === "number");
  assert.ok(numberInput);
  await act(async () => {
    numberInput.props.onChange({ target: { value: "5" } });
  });
  assert.equal(button(renderer.root, /^Save draft$/).props.disabled, false);
  await act(async () => {
    await button(renderer.root, /^Save draft$/).props.onClick();
  });
  assert.equal(writes[0]?.method, "PUT");
  assert.doesNotMatch(writes[0]?.url ?? "", /\/layout$/);
  await act(async () => renderer.unmount());
});
