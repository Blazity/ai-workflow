import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WorkflowBlockContract,
  WorkflowBlockType,
  WorkflowEditorOptions,
} from "@shared/contracts";
import {
  DEFAULT_OPEN_PR_BODY,
  DEFAULT_OPEN_PR_TITLE,
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

test("v2 palette offers composite Review and Checks helpers without replacing bare blocks", () => {
  const review = contract(
    "review_agent",
    "Review agent",
    {},
    { available: true, unavailableReason: null },
  );
  review.presentation.group = "agents";
  const checks = contract(
    "run_checks",
    "Run checks",
    { commands: [] },
    { available: true, unavailableReason: null },
  );
  checks.presentation.group = "utility";
  const v2Options = {
    ...options,
    blockRegistry: {
      ...options.blockRegistry,
      review_agent: review,
      run_checks: checks,
    },
  } as WorkflowEditorOptions;

  const v1Items = buildPaletteItems(v2Options, 1).flatMap((group) => group.items);
  const v2Items = buildPaletteItems(v2Options, 2).flatMap((group) => group.items);
  assert.equal(v1Items.some((item) => item.templateId), false);
  assert.deepEqual(
    v2Items
      .filter((item) => item.type === "review_agent" || item.type === "run_checks")
      .map(({ id, type, templateId }) => ({ id, type, templateId })),
    [
      {
        id: "block:review_agent",
        type: "review_agent",
        templateId: undefined,
      },
      {
        id: "template:review-with-decision",
        type: "review_agent",
        templateId: "review-with-decision",
      },
      {
        id: "block:run_checks",
        type: "run_checks",
        templateId: undefined,
      },
      {
        id: "template:checks-with-result",
        type: "run_checks",
        templateId: "checks-with-result",
      },
    ],
  );
});

test("new v2 Open PR blocks do not inherit legacy flat-variable templates", () => {
  const openPr = contract(
    "open_pr",
    "Open PR/MR",
    {
      title: DEFAULT_OPEN_PR_TITLE,
      body: DEFAULT_OPEN_PR_BODY,
    },
    { available: true, unavailableReason: null },
  );
  const withOpenPr = {
    ...options,
    blockRegistry: {
      ...options.blockRegistry,
      open_pr: openPr,
    },
  } as WorkflowEditorOptions;

  const v1OpenPr = buildPaletteItems(withOpenPr, 1)
    .flatMap((group) => group.items)
    .find((item) => item.type === "open_pr");
  const v2OpenPr = buildPaletteItems(withOpenPr, 2)
    .flatMap((group) => group.items)
    .find((item) => item.type === "open_pr");

  assert.deepEqual(v1OpenPr?.params, {
    title: DEFAULT_OPEN_PR_TITLE,
    body: DEFAULT_OPEN_PR_BODY,
  });
  assert.deepEqual(v2OpenPr?.params, {});
  assert.doesNotMatch(JSON.stringify(v2OpenPr?.params), /\{\{ticket_/);
  assert.doesNotMatch(JSON.stringify(v2OpenPr?.params), /\{\{change_summary\}\}/);
});
