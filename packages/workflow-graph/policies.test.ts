import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { WorkflowDefinitionValidationIssue } from "@shared/contracts";
import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import { deploy, parse, runLoad } from "./policies";
import type { WorkflowBlockParamsSchemas } from "./schema";

/**
 * The stored-shape upgrade the parse policy performs, on the row shape that
 * made it necessary: an agent block that pins a Harness Profile and still
 * carries the provider and model an older editor wrote next to it. Reading such
 * a row has to drop the pair, because the profile decides them.
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

/**
 * What today's parse produces for the row above, written out rather than
 * derived: comparing the result against another call of the same function would
 * pass whatever the upgrade did.
 */
const upgradedLegacyStoredRow = {
  schemaVersion: 2,
  nodes: [
    {
      id: "plan",
      type: "planning_agent",
      x: 1,
      y: 2,
      configuration: {
        harnessProfile: { profileId: "builtin-claude", version: 3 },
        prompt: "plan it",
      },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [],
};

/** Every block type accepts any configuration, so these suites read the policy
 *  composition rather than one block's parameter shape. */
const permissiveBlockParamsSchemas = Object.fromEntries(
  Object.keys(BLOCK_TYPE_SPECS).map((type) => [type, z.record(z.string(), z.unknown())]),
) as WorkflowBlockParamsSchemas;

const policyDeps = {
  blockParamsSchemas: permissiveBlockParamsSchemas,
  validateTransformShape: () => [],
};

const workerOnlyIssue: WorkflowDefinitionValidationIssue = {
  code: "deployment",
  severity: "error",
  nodeId: "plan",
  path: "/nodes/0/configuration/cron",
  message: 'Block "plan" must configure a cron schedule before deployment.',
};

const availabilityIssue: WorkflowDefinitionValidationIssue = {
  code: "deployment",
  severity: "error",
  nodeId: "plan",
  path: "/nodes/0/configuration",
  message: 'Block "plan" (planning_agent) is unavailable: no provider is configured.',
};

/** Stands in for the worker's deployment walk: one complaint either policy
 *  reports, and one that only a deployment check produces. */
const deploymentIssues = (options: {
  readonly checkEnvironmentAvailability: boolean;
}): readonly WorkflowDefinitionValidationIssue[] =>
  options.checkEnvironmentAvailability
    ? [workerOnlyIssue, availabilityIssue]
    : [workerOnlyIssue];

function parsedLegacyRow() {
  const parsed = parse(legacyStoredRow);
  assert.equal(parsed.error, null);
  assert.ok(parsed.definition);
  return parsed.definition;
}

test("a legacy stored row parses to exactly the object today's parse produces", () => {
  const parsed = parse(legacyStoredRow);
  assert.deepStrictEqual(parsed.definition, upgradedLegacyStoredRow);
  assert.deepStrictEqual(parsed.issues, []);
  assert.equal(parsed.error, null);
  // The stored row itself is left alone, so a caller may parse it again.
  assert.equal(legacyStoredRow.nodes[0].configuration.provider, "codex");
});

test("parsing an already upgraded row changes nothing further", () => {
  assert.deepStrictEqual(parse(upgradedLegacyStoredRow).definition, upgradedLegacyStoredRow);
});

test("a row with no pinned profile keeps its provider and model", () => {
  const parsed = parse({
    ...legacyStoredRow,
    nodes: [
      {
        ...legacyStoredRow.nodes[0],
        configuration: { provider: "codex", model: "gpt-legacy", prompt: "plan it" },
      },
    ],
  });
  assert.deepStrictEqual(parsed.definition?.nodes[0].configuration, {
    provider: "codex",
    model: "gpt-legacy",
    prompt: "plan it",
  });
});

test("a graph this build cannot read reports the refusal both ways", () => {
  const parsed = parse({
    schemaVersion: 2,
    nodes: [{ id: "", type: "not_a_block", x: 0, y: 0, configuration: {}, inputs: {}, additionalInputs: [] }],
    edges: [],
  });
  assert.equal(parsed.definition, null);
  assert.notEqual(parsed.error, null);
  assert.ok(parsed.issues.length > 0);
  assert.ok(parsed.issues.every((issue) => issue.code === "schema"));
  assert.ok(parsed.issues.some((issue) => issue.path?.startsWith("/nodes/0")));
});

test("a policy reports the structural rules before anything the deployment answers", () => {
  // The fixture is one agent block with no trigger, so the graph rules refuse
  // it twice: the graph has no entry, and the block it does have is orphaned.
  // Those two come first, ahead of everything the injected source contributes.
  const result = runLoad(parsedLegacyRow(), { ...policyDeps, deploymentIssues });
  assert.deepStrictEqual(result.definition, upgradedLegacyStoredRow);
  assert.deepStrictEqual(result.issues, [
    {
      code: "deployment",
      severity: "error",
      nodeId: null,
      path: "/nodes",
      message: "Workflow must contain at least one trigger block.",
    },
    {
      code: "deployment",
      severity: "error",
      nodeId: "plan",
      message: 'Block "plan" is not reachable from a trigger.',
    },
    workerOnlyIssue,
  ]);
});

test("runLoad yields deploy minus the environment availability issues", () => {
  const definition = parsedLegacyRow();
  const deployed = deploy(definition, { ...policyDeps, deploymentIssues });
  const loaded = runLoad(definition, { ...policyDeps, deploymentIssues });

  assert.ok(deployed.issues.some((issue) => issue.message === availabilityIssue.message));
  assert.ok(deployed.issues.some((issue) => issue.message === workerOnlyIssue.message));
  assert.deepStrictEqual(
    loaded.issues,
    deployed.issues.filter((issue) => issue.message !== availabilityIssue.message),
  );
});

test("a policy de-duplicates the list it composes", () => {
  const repeated = () => [workerOnlyIssue, workerOnlyIssue, availabilityIssue];
  const result = deploy(parsedLegacyRow(), { ...policyDeps, deploymentIssues: repeated });
  assert.equal(
    result.issues.filter((issue) => issue.message === workerOnlyIssue.message).length,
    1,
  );
});
