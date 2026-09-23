// What the canvas warns about when a saved workflow uses a block this
// deployment cannot run. From docs/qa/integrations-scenarios.md INT-033: the
// node names the missing integration and the rest of the workflow is editable.
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowEditorOptions,
} from "@shared/contracts";

import { buildPaletteItems, unavailableBlockNotices } from "./block-palette.ts";

const unknownSchema = { type: "unknown" } as const;

function contract(
  type: WorkflowBlockType,
  label: string,
  availability: WorkflowBlockContract["availability"],
): WorkflowBlockContract {
  return {
    type,
    presentation: {
      group: "utility",
      label,
      description: `${label} description`,
      color: "#123456",
      softColor: "#eef0f2",
      glyph: "•",
    },
    defaults: {},
    ports: ["next"],
    allowsFailurePort: true,
    inputs: {},
    additionalInputs: [],
    output: { schema: unknownSchema, bindingSchema: unknownSchema, statusVariants: ["ok"] },
    availability,
  };
}

const DISABLED_REASON =
  "Demo is disabled. Enable it on the Integrations page to use its blocks.";

const options = {
  defaultModel: "claude-model",
  blockRegistry: {
    call_llm: contract("call_llm", "Ask a model", {
      available: true,
      unavailableReason: null,
    }),
    demo_echo: contract("demo_echo" as WorkflowBlockType, "Demo echo", {
      available: false,
      unavailableReason: DISABLED_REASON,
    }),
    demo_lookup: contract("demo_lookup" as WorkflowBlockType, "Demo lookup", {
      available: false,
      unavailableReason: DISABLED_REASON,
    }),
  } as unknown as WorkflowEditorOptions["blockRegistry"],
} as WorkflowEditorOptions;

test("a workflow whose blocks all run warns about nothing", () => {
  assert.deepEqual(unavailableBlockNotices(options, ["call_llm", "call_llm"]), []);
});

test("an unavailable block is named with the engine's own sentence", () => {
  const notices = unavailableBlockNotices(options, ["call_llm", "demo_echo"]);
  assert.deepEqual(notices, [
    { type: "demo_echo", label: "Demo echo", reason: DISABLED_REASON },
  ]);
});

test("four nodes of one disconnected integration are one thing wrong, not four", () => {
  const notices = unavailableBlockNotices(options, [
    "demo_echo",
    "demo_echo",
    "demo_echo",
    "demo_lookup",
  ]);
  assert.deepEqual(notices.map((notice) => notice.type), ["demo_echo", "demo_lookup"]);
});

test("a block type this build cannot describe at all is left to the unknown-block path", () => {
  // A definition published while an integration existed still stores its type
  // after the build stopped shipping it. The registry has no contract for it,
  // so this warning has nothing true to say and says nothing.
  assert.deepEqual(unavailableBlockNotices(options, ["gone_block"]), []);
});

test("a block grouped under a name this palette was written before still reaches the palette", () => {
  // An integration that groups its blocks under its own name contributes a
  // group id the order in block-palette.ts cannot have known about. Iterating
  // only the known order dropped those blocks out of the palette entirely,
  // with nothing on screen to say a block was missing.
  const echo = options.blockRegistry["demo_echo" as WorkflowBlockType];
  const registry = {
    ...options.blockRegistry,
    demo_echo: {
      ...echo,
      presentation: { ...echo.presentation, group: "demo_provider" },
    },
  } as unknown as WorkflowEditorOptions["blockRegistry"];

  const groups = buildPaletteItems({ ...options, blockRegistry: registry });
  const contributed = groups.find((group) => group.group === "demo_provider");

  assert.ok(contributed, "the contributed group is offered");
  assert.equal(contributed.label, "Demo Provider");
  assert.deepEqual(
    contributed.items.map((item) => item.type),
    ["demo_echo"],
  );
});
