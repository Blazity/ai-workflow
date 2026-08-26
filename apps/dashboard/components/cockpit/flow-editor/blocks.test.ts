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
  V2_ONLY_BLOCK_TYPES,
} from "@shared/contracts";
import type { FlowNodeDef } from "@/lib/flows";
import { buildPaletteItems, CONNECTED_CARD_TEXT_CLASS, nodeSummary } from "./blocks.ts";

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

test("the webhook trigger card summarises its endpoint instead of staying blank", () => {
  const node = {
    id: "n7",
    type: "trigger_webhook",
    name: "Webhook",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  } as FlowNodeDef;

  assert.equal(nodeSummary(node, options), "signed webhook endpoint");
});

test("the schedule trigger card summarises its cadence instead of staying blank", () => {
  const node = {
    id: "n8",
    type: "trigger_schedule",
    name: "Schedule",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  } as FlowNodeDef;

  assert.equal(nodeSummary(node, options), "recurring schedule");
});

test("trigger cards append the rate limit to their summary", () => {
  const ticket = {
    id: "n10",
    type: "trigger_ticket_ai",
    x: 0,
    y: 0,
    params: { rateLimitMax: 20, rateLimitWindow: "hour" },
    inputs: {},
  } as FlowNodeDef;
  const pr = {
    id: "n11",
    type: "trigger_pr_created",
    x: 0,
    y: 0,
    params: { scope: "any", rateLimitMax: 5 },
    inputs: {},
  } as FlowNodeDef;
  const unlimited = {
    id: "n12",
    type: "trigger_ticket_ai",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  } as FlowNodeDef;

  assert.equal(nodeSummary(ticket, options), "max 20/hour");
  // A max without a window summarises against the window the editor writes.
  assert.equal(nodeSummary(pr, options), "any PR · max 5/day");
  assert.equal(nodeSummary(unlimited, options), null);
});

test("run_pre_pr_checks no longer shows a fix-cycles subtitle for its inert param", () => {
  const node = {
    id: "n13",
    type: "run_pre_pr_checks",
    x: 0,
    y: 0,
    params: { maxFixCycles: 3 },
    inputs: {},
  } as FlowNodeDef;

  assert.equal(nodeSummary(node, options), null);
});

test("run_scripts summarises its configured group names so two script blocks are distinguishable", () => {
  const node = {
    id: "n14",
    type: "run_scripts",
    x: 0,
    y: 0,
    params: { groups: ["checks", "lint"] },
    inputs: {},
  } as FlowNodeDef;
  const empty = {
    id: "n15",
    type: "run_scripts",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
  } as FlowNodeDef;

  assert.equal(nodeSummary(node, options), "checks, lint");
  assert.equal(nodeSummary(empty, options), null);
});

test("the investigate card summarises its enabled context providers", () => {
  const both = {
    id: "n13",
    type: "investigate",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: { configuration: {}, inputs: {}, additionalInputs: [] },
  } as unknown as FlowNodeDef;
  const jiraOnly = {
    id: "n14",
    type: "investigate",
    x: 0,
    y: 0,
    params: {},
    inputs: {},
    v2: {
      configuration: { providers: ["jira"] },
      inputs: {},
      additionalInputs: [],
    },
  } as unknown as FlowNodeDef;

  assert.equal(nodeSummary(both, options), "jira · slack");
  assert.equal(nodeSummary(jiraOnly, options), "jira");
});

test("connected-card labels clip instead of expanding the node", () => {
  assert.match(CONNECTED_CARD_TEXT_CLASS, /overflow-hidden/);
  assert.match(CONNECTED_CARD_TEXT_CLASS, /text-ellipsis/);
  assert.match(CONNECTED_CARD_TEXT_CLASS, /whitespace-nowrap/);
});

test("the v2 palette offers the composite Review helper without replacing the bare block", () => {
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
    ],
  );
});

test("run_checks is retired from the palette, bare block and composite alike", () => {
  const checks = contract(
    "run_checks",
    "Run checks",
    { commands: [] },
    { available: true, unavailableReason: null },
  );
  const withChecks = {
    ...options,
    blockRegistry: { ...options.blockRegistry, run_checks: checks },
  } as WorkflowEditorOptions;

  for (const schemaVersion of [1, 2] as const) {
    const items = buildPaletteItems(withChecks, schemaVersion).flatMap((group) => group.items);
    // Existing run_checks nodes keep rendering and editing; only the way to add
    // a new one is gone, and the composite would have been a back door.
    assert.deepEqual(
      items.filter((item) => item.type === "run_checks"),
      [],
      `run_checks reachable in the v${schemaVersion} palette`,
    );
  }
});

test("the publication gate is named and drawn apart from run_scripts", () => {
  // Both names and both glyphs come from the registry, the one source every
  // surface reads: the palette must not rename a block the block reference page
  // and blocks_list still call something else.
  const gate = contract(
    "run_pre_pr_checks",
    "Run scripts (publication gate)",
    {},
    { available: true, unavailableReason: null },
  );
  gate.presentation.glyph = "◈";
  const scripts = contract(
    "run_scripts",
    "Run scripts",
    { groups: ["checks"] },
    { available: true, unavailableReason: null },
  );
  scripts.presentation.glyph = "❯";
  const withBoth = {
    ...options,
    blockRegistry: { ...options.blockRegistry, run_pre_pr_checks: gate, run_scripts: scripts },
  } as WorkflowEditorOptions;

  const items = buildPaletteItems(withBoth).flatMap((group) => group.items);
  const gateItem = items.find((item) => item.type === "run_pre_pr_checks");
  const scriptsItem = items.find((item) => item.type === "run_scripts");
  assert.equal(gateItem?.name, "Run scripts (publication gate)");
  assert.equal(gateItem?.presentation.label, "Run scripts (publication gate)");
  assert.notEqual(gateItem?.name, scriptsItem?.name);
  assert.notEqual(gateItem?.presentation.glyph, scriptsItem?.presentation.glyph);
});

test("the schedule trigger is v2-only and never offered in a v1 palette", () => {
  const schedule = contract(
    "trigger_schedule",
    "Schedule",
    { timezone: "UTC", overlapPolicy: "skip", catchUpGraceMinutes: 60 },
    { available: true, unavailableReason: null },
  );
  schedule.presentation.group = "trigger";
  const scheduleOptions = {
    ...options,
    blockRegistry: {
      ...options.blockRegistry,
      trigger_schedule: schedule,
    },
  } as WorkflowEditorOptions;

  const v1Items = buildPaletteItems(scheduleOptions, 1).flatMap((group) => group.items);
  const v2Items = buildPaletteItems(scheduleOptions, 2).flatMap((group) => group.items);
  assert.equal(v1Items.some((item) => item.type === "trigger_schedule"), false);
  assert.equal(v2Items.some((item) => item.type === "trigger_schedule"), true);
});

test("every v2-only block type is excluded from the v1 palette and offered in v2", () => {
  const v2OnlyOptions = {
    ...options,
    blockRegistry: {
      ...options.blockRegistry,
      ...Object.fromEntries(
        V2_ONLY_BLOCK_TYPES.map((type) => [
          type,
          contract(type, type, {}, { available: true, unavailableReason: null }),
        ]),
      ),
    },
  } as WorkflowEditorOptions;

  const v1Items = buildPaletteItems(v2OnlyOptions, 1).flatMap((group) => group.items);
  const v2Items = buildPaletteItems(v2OnlyOptions, 2).flatMap((group) => group.items);
  for (const type of V2_ONLY_BLOCK_TYPES) {
    assert.equal(v1Items.some((item) => item.type === type), false, `${type} should not be in v1`);
    assert.equal(v2Items.some((item) => item.type === type), true, `${type} should be in v2`);
  }
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

test("a Named run_checks node names its groups on the canvas, the way run_scripts does", () => {
  const named: FlowNodeDef = {
    id: "rc",
    type: "run_checks",
    name: "Checks",
    x: 0,
    y: 0,
    params: { groups: ["lint", "unit"] },
    inputs: {},
  };
  // Two Named run_checks nodes used to read "config checks" alike, which is
  // also what a gate-mode node says.
  assert.equal(nodeSummary(named, options), "lint, unit");
  assert.equal(
    nodeSummary({ ...named, params: { commands: ["pnpm test"] } }, options),
    "1 command",
  );
  assert.equal(nodeSummary({ ...named, params: {} }, options), "config checks");
});
