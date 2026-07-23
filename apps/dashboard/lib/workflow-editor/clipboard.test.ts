import assert from "node:assert/strict";
import { test } from "node:test";
import type { FlowEdgeDef, FlowNodeDef } from "../flows.ts";
import {
  clearSessionWorkflowClipboard,
  createWorkflowClipboardPayload,
  planWorkflowClipboardPaste,
  readSessionWorkflowClipboard,
  writeSessionWorkflowClipboard,
  type SessionStorageLike,
} from "./clipboard.ts";

interface Geometry {
  bend: { x: number; y: number };
}

function v2Node(
  id: string,
  type: FlowNodeDef["type"] = "post_ticket_comment",
  x = 0,
  y = 0,
): FlowNodeDef {
  return {
    id,
    type,
    x,
    y,
    params: {},
    inputs: {},
    v2: { configuration: {}, inputs: {}, additionalInputs: [] },
  };
}

function memoryStorage(): SessionStorageLike & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

test("copies selected nodes, internal edges, and their geometry only", () => {
  const nodes = [v2Node("a"), v2Node("b"), v2Node("outside")];
  const edges: FlowEdgeDef[] = [
    { id: "a-b", from: "a", to: "b" },
    { id: "b-outside", from: "b", to: "outside" },
  ];
  const payload = createWorkflowClipboardPayload<Geometry>({
    schemaVersion: 2,
    nodes,
    edges,
    selectedNodeIds: ["a", "b"],
    edgeGeometry: {
      "a-b": { bend: { x: 40, y: 50 } },
      "b-outside": { bend: { x: 80, y: 90 } },
    },
  });

  assert(payload);
  assert.deepEqual(
    payload.nodes.map((node) => node.id),
    ["a", "b"],
  );
  assert.deepEqual(payload.edges, [
    {
      edge: { id: "a-b", from: "a", to: "b" },
      geometry: { bend: { x: 40, y: 50 } },
    },
  ]);
});

test("returns no payload for an edge-only or empty node selection", () => {
  assert.equal(
    createWorkflowClipboardPayload({
      schemaVersion: 2,
      nodes: [v2Node("a")],
      edges: [],
      selectedNodeIds: [],
    }),
    null,
  );
});

test("pastes atomically with collision-free ids, fresh edges, remapped references, and a 32px offset", () => {
  const source = v2Node("consumer", "generic_agent", 100, 200);
  source.params = {
    prompt: "{{data:steps.producer.output.value}}",
  };
  source.v2 = {
    inputs: {
      value: {
        kind: "reference",
        reference: "steps.producer.output.value",
      },
    },
    additionalInputs: [],
    configuration: {
      prompt: "{{data:steps.producer.output.value}}",
      promptSlotBindings: {
        plan: {
          kind: "reference",
          reference: "steps.producer.output.value",
        },
      },
    },
  };
  const payload = createWorkflowClipboardPayload<Geometry>({
    schemaVersion: 2,
    nodes: [v2Node("producer", "generic_agent", 0, 0), source],
    edges: [{ id: "source-edge", from: "producer", to: "consumer" }],
    selectedNodeIds: ["producer", "consumer"],
    edgeGeometry: {
      "source-edge": { bend: { x: 50, y: 60 } },
    },
  })!;
  const generated = ["existing-edge", "fresh-edge"];
  const result = planWorkflowClipboardPaste({
    payload,
    schemaVersion: 2,
    destinationNodes: [
      v2Node("trigger", "trigger_ticket_ai"),
      v2Node("producer-copy"),
    ],
    destinationEdges: [
      { id: "existing-edge", from: "trigger", to: "producer-copy" },
    ],
    destinationEdgeGeometry: {
      "existing-edge": { bend: { x: 1, y: 2 } },
    },
    generateEdgeId: () => generated.shift()!,
    offsetEdgeGeometry: (geometry, delta) => ({
      bend: {
        x: geometry.bend.x + delta.x,
        y: geometry.bend.y + delta.y,
      },
    }),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.selectedNodeIds, [
    "producer-copy-2",
    "consumer-copy",
  ]);
  assert.deepEqual(
    result.addedNodes.map(({ id, x, y }) => ({ id, x, y })),
    [
      { id: "producer-copy-2", x: 32, y: 32 },
      { id: "consumer-copy", x: 132, y: 232 },
    ],
  );
  const consumer = result.addedNodes[1]!;
  assert.equal(
    consumer.v2?.inputs.value?.kind === "reference"
      ? consumer.v2.inputs.value.reference
      : null,
    "steps.producer-copy-2.output.value",
  );
  assert.deepEqual(consumer.v2?.configuration, {
    prompt: "{{data:steps.producer-copy-2.output.value}}",
    promptSlotBindings: {
      plan: {
        kind: "reference",
        reference: "steps.producer-copy-2.output.value",
      },
    },
  });
  assert.deepEqual(result.addedEdges, [
    {
      id: "fresh-edge",
      from: "producer-copy-2",
      to: "consumer-copy",
    },
  ]);
  assert.deepEqual(result.edgeGeometry, {
    "existing-edge": { bend: { x: 1, y: 2 } },
    "fresh-edge": { bend: { x: 82, y: 92 } },
  });
  assert.deepEqual(result.selectedEdgeKeys, ["fresh-edge"]);
  assert.deepEqual(result.issues, []);
});

test("repeated pastes advance the offset by another 32px", () => {
  const payload = createWorkflowClipboardPayload({
    schemaVersion: 2,
    nodes: [v2Node("a", "post_ticket_comment", 10, 20)],
    edges: [],
    selectedNodeIds: ["a"],
  })!;
  const first = planWorkflowClipboardPaste({
    payload,
    schemaVersion: 2,
    destinationNodes: [v2Node("trigger", "trigger_ticket_ai")],
    destinationEdges: [],
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(
    { x: first.addedNodes[0]?.x, y: first.addedNodes[0]?.y },
    { x: 42, y: 52 },
  );

  const second = planWorkflowClipboardPaste({
    payload: first.nextClipboard,
    schemaVersion: 2,
    destinationNodes: first.nodes,
    destinationEdges: first.edges,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    { x: second.addedNodes[0]?.x, y: second.addedNodes[0]?.y },
    { x: 74, y: 84 },
  );
});

test("preserves valid external references and reports missing destination sources", () => {
  const validConsumer = v2Node("valid");
  validConsumer.v2!.inputs = {
    source: {
      kind: "reference",
      reference: "steps.existing.output.value",
    },
  };
  const invalidConsumer = v2Node("invalid");
  invalidConsumer.v2!.inputs = {
    source: {
      kind: "reference",
      reference: "steps.missing.output.value",
    },
  };
  const payload = createWorkflowClipboardPayload({
    schemaVersion: 2,
    nodes: [validConsumer, invalidConsumer],
    edges: [],
    selectedNodeIds: ["valid", "invalid"],
  })!;

  const result = planWorkflowClipboardPaste({
    payload,
    schemaVersion: 2,
    destinationNodes: [
      v2Node("trigger", "trigger_ticket_ai"),
      v2Node("existing"),
    ],
    destinationEdges: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.addedNodes[0]?.v2?.inputs.source?.kind === "reference"
      ? result.addedNodes[0].v2.inputs.source.reference
      : null,
    "steps.existing.output.value",
  );
  assert.equal(result.issues.length, 1);
  assert.deepEqual(result.issues[0], {
    code: "clipboard.reference.unavailable",
    severity: "error",
    nodeId: "invalid-copy",
    path: "/nodes/3/inputs/source/reference",
    message:
      'Pasted block "invalid-copy" references unavailable block "missing".',
  });
  assert.notEqual(result.selectedNodeIds[0], "missing");
  assert.notEqual(result.selectedNodeIds[1], "missing");
});

test("new node ids cannot shadow a missing external reference", () => {
  const source = v2Node("foo");
  source.v2!.inputs = {
    external: {
      kind: "reference",
      reference: "steps.foo-copy.output.value",
    },
  };
  const payload = createWorkflowClipboardPayload({
    schemaVersion: 2,
    nodes: [source],
    edges: [],
    selectedNodeIds: ["foo"],
  })!;

  const result = planWorkflowClipboardPaste({
    payload,
    schemaVersion: 2,
    destinationNodes: [v2Node("trigger", "trigger_ticket_ai")],
    destinationEdges: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.selectedNodeIds[0], "foo-copy-2");
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0]!.message, /unavailable block "foo-copy"/);
});

test("refuses cross-schema paste rather than silently converting definitions", () => {
  const payload = createWorkflowClipboardPayload({
    schemaVersion: 1,
    nodes: [
      {
        id: "legacy",
        type: "post_ticket_comment",
        x: 0,
        y: 0,
        params: { body: "hello" },
        inputs: {},
      },
    ],
    edges: [],
    selectedNodeIds: ["legacy"],
  })!;

  assert.deepEqual(
    planWorkflowClipboardPaste({
      payload,
      schemaVersion: 2,
      destinationNodes: [],
      destinationEdges: [],
    }),
    { ok: false, reason: "schema_version_mismatch" },
  );
});

test("round-trips the session clipboard and fails closed on corrupt storage", () => {
  const storage = memoryStorage();
  const payload = createWorkflowClipboardPayload({
    schemaVersion: 2,
    nodes: [v2Node("a")],
    edges: [],
    selectedNodeIds: ["a"],
  })!;

  assert.equal(writeSessionWorkflowClipboard(storage, payload), true);
  assert.deepEqual(readSessionWorkflowClipboard(storage), payload);
  clearSessionWorkflowClipboard(storage);
  assert.equal(readSessionWorkflowClipboard(storage), null);

  storage.setItem(
    "ai-workflow.workflow-editor.clipboard.v1",
    '{"version":1,"schemaVersion":2,"nodes":"bad","edges":[],"pasteCount":0}',
  );
  assert.equal(readSessionWorkflowClipboard(storage), null);
  storage.setItem(
    "ai-workflow.workflow-editor.clipboard.v1",
    "{not-json",
  );
  assert.equal(readSessionWorkflowClipboard(storage), null);
  storage.setItem(
    "ai-workflow.workflow-editor.clipboard.v1",
    '{"version":1,"schemaVersion":2,"nodes":[{"id":"a","type":"post_ticket_comment","x":0,"y":0,"params":{},"inputs":{}}],"edges":[{"edge":{"from":"a","to":"missing"}}],"pasteCount":0}',
  );
  assert.equal(readSessionWorkflowClipboard(storage), null);
});
