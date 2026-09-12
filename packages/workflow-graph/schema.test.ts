import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isWorkflowDataReferenceV2,
  upgradeStoredWorkflowDefinition,
  workflowDefinitionV2Schema,
} from "./schema";

/**
 * The stored-shape upgrade the parser performs, on the row shape that made it
 * necessary: an agent block that pins a Harness Profile and still carries the
 * provider and model an older editor wrote next to it. Reading such a row has
 * to drop the pair, because the profile decides them.
 */
const legacyStoredRow = {
  schemaVersion: 2,
  nodes: [
    {
      id: "plan",
      type: "planning_agent",
      x: 1,
      y: 2,
      configuration: {
        harnessProfile: { profileId: "builtin-claude", version: 3 },
        provider: "codex",
        model: "gpt-legacy",
        prompt: "plan it",
      },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [],
};

test("a legacy stored row round-trips with provider and model dropped", () => {
  const upgraded = upgradeStoredWorkflowDefinition(legacyStoredRow);
  assert.deepEqual(upgraded.nodes[0].configuration, {
    harnessProfile: { profileId: "builtin-claude", version: 3 },
    prompt: "plan it",
  });
  // Everything else survives untouched, and the input is not mutated.
  assert.equal(upgraded.nodes[0].id, "plan");
  assert.equal(upgraded.nodes[0].x, 1);
  assert.equal(legacyStoredRow.nodes[0].configuration.provider, "codex");
});

test("upgrading is idempotent", () => {
  const once = upgradeStoredWorkflowDefinition(legacyStoredRow);
  assert.deepEqual(upgradeStoredWorkflowDefinition(once), once);
});

test("a row with no pinned profile keeps its provider and model", () => {
  const parsed = upgradeStoredWorkflowDefinition({
    ...legacyStoredRow,
    nodes: [
      {
        ...legacyStoredRow.nodes[0],
        configuration: { provider: "codex", model: "gpt-legacy", prompt: "plan it" },
      },
    ],
  });
  assert.deepEqual(parsed.nodes[0].configuration, {
    provider: "codex",
    model: "gpt-legacy",
    prompt: "plan it",
  });
});

test("a retired v1 row is refused rather than upgraded", () => {
  assert.equal(
    workflowDefinitionV2Schema.safeParse({ schemaVersion: 1, nodes: [], edges: [] })
      .success,
    false,
  );
});

test("data references are recognised by their canonical shape", () => {
  assert.equal(isWorkflowDataReferenceV2("steps.entry.output.ticket.key"), true);
  assert.equal(isWorkflowDataReferenceV2("run.attempt"), true);
  assert.equal(isWorkflowDataReferenceV2("steps.plan.output"), true);
  assert.equal(isWorkflowDataReferenceV2("steps.plan.result"), false);
  assert.equal(isWorkflowDataReferenceV2("steps.plan.output.__proto__"), false);
  assert.equal(isWorkflowDataReferenceV2(" steps.entry.output.a"), false);
});
