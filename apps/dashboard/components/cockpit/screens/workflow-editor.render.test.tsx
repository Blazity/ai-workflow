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
import { WorkflowEditorScreen } from "./workflow-editor";

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
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
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
      />,
    );
  });
  assert.equal(button(renderer.root, /^Deploy$/).props.disabled, true);
  assert.equal(button(renderer.root, /^Save draft$/).props.disabled, true);

  await act(async () => {
    button(renderer.root, /Legacy A/).props.onClick();
  });
  const listText = textOf(renderer.toJSON());
  assert.match(listText, /Retired schema/);
  assert.match(listText, /Stored enabled:\s+yes/);

  await act(async () => {
    button(renderer.root, /History/).props.onClick();
  });
  await act(async () => {
    button(renderer.root, /Show stored JSON/).props.onClick();
  });
  assert.match(textOf(renderer.toJSON()), /"marker": "Legacy A"/);

  await act(async () => {
    button(renderer.root, /Legacy A/).props.onClick();
  });
  await act(async () => {
    await button(renderer.root, /^Legacy B/).props.onClick();
  });
  await act(async () => {
    button(renderer.root, /History/).props.onClick();
  });

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
  mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
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
    },
  );
  t.after(() => mock.restoreAll());

  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
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
      />,
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
