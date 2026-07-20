import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowEditorOptions,
} from "@shared/contracts";
import { buildPaletteItems, CONNECTED_CARD_TEXT_CLASS } from "./blocks.ts";

const unknownSchema = { type: "unknown" } as const;

function contract(
  type: WorkflowBlockType,
  label: string,
  defaults: WorkflowBlockContract["defaults"],
  availability: WorkflowBlockContract["availability"],
): WorkflowBlockContract {
  return {
    type,
    presentation: {
      group: type === "generic_agent" ? "agents" : "utility",
      label,
      description: `${label} description`,
      color: "#123456",
      softColor: "#eef0f2",
      glyph: "•",
    },
    defaults,
    ports: ["next"],
    allowsFailurePort: true,
    inputs: {},
    additionalInputs: [],
    output: { schema: unknownSchema, bindingSchema: unknownSchema, statusVariants: ["ok"] },
    availability,
  };
}

const options = {
  defaultModel: "claude-model",
  blockRegistry: {
    generic_agent: contract(
      "generic_agent",
      "Server agent",
      { model: "claude-model", workspaceMode: "none" },
      { available: true, unavailableReason: null },
    ),
    call_llm: contract(
      "call_llm",
      "Server LLM",
      { model: "server-model" },
      { available: false, unavailableReason: "Structured LLM output is not configured." },
    ),
  },
} as WorkflowEditorOptions;

test("new Generic Agent blocks default to no code workspace", () => {
  const generic = buildPaletteItems(options)
    .flatMap((group) => group.items)
    .find((item) => item.type === "generic_agent");

  assert.deepEqual(generic?.params, {
    model: "claude-model",
    workspaceMode: "none",
  });
});

test("palette presentation, defaults, and unavailable reasons come from the server registry", () => {
  const items = buildPaletteItems(options).flatMap((group) => group.items);
  assert.deepEqual(
    items.map(({ type, name, params, available, unavailableReason }) => ({
      type,
      name,
      params,
      available,
      unavailableReason,
    })),
    [
      {
        type: "generic_agent",
        name: "Server agent",
        params: { model: "claude-model", workspaceMode: "none" },
        available: true,
        unavailableReason: null,
      },
      {
        type: "call_llm",
        name: "Server LLM",
        params: { model: "server-model" },
        available: false,
        unavailableReason: "Structured LLM output is not configured.",
      },
    ],
  );
});

test("connected-card labels clip instead of expanding the node", () => {
  assert.match(CONNECTED_CARD_TEXT_CLASS, /overflow-hidden/);
  assert.match(CONNECTED_CARD_TEXT_CLASS, /text-ellipsis/);
  assert.match(CONNECTED_CARD_TEXT_CLASS, /whitespace-nowrap/);
});
