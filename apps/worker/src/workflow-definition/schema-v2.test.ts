import { describe, expect, it } from "vitest";
import type {
  JsonValue,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
} from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  isWorkflowDataReferenceV2,
  upgradeStoredWorkflowDefinition,
  validateWorkflowDefinitionIssuesForDeployment,
  workflowDefinitionSchema,
  workflowDefinitionV1Schema,
  workflowDefinitionV2Schema,
} from "./schema.js";
import { validateWorkflowDefinitionCandidate } from "./validation.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

function v2Definition(): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "ticket",
        type: "trigger_ticket_ai",
        x: 10,
        y: 20,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

function branchingDefinition(condition: JsonValue): WorkflowDefinitionV2 {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "ticket",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "checks",
        type: "run_checks",
        x: 100,
        y: 0,
        configuration: { commands: ["pnpm test"] },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "decision",
        type: "branch",
        x: 200,
        y: 0,
        configuration: { condition },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "success",
        type: "terminate",
        x: 300,
        y: -50,
        configuration: { terminalStatus: "done" },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "failure",
        type: "terminate",
        x: 300,
        y: 50,
        configuration: { terminalStatus: "failed" },
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [
      { id: "ticket-checks", from: "ticket", to: "checks" },
      { id: "checks-decision", from: "checks", to: "decision" },
      {
        id: "decision-success",
        from: "decision",
        fromPort: "true",
        to: "success",
      },
      {
        id: "decision-failure",
        from: "decision",
        fromPort: "false",
        to: "failure",
      },
    ],
  };
}

describe("Workflow Definition v2 schema", () => {
  it("parses v1 and v2 through a discriminated public contract", () => {
    const v1: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        {
          id: "ticket",
          type: "trigger_ticket_ai",
          x: 0,
          y: 0,
          params: {},
          inputs: {},
        },
      ],
      edges: [],
    };
    const v2 = v2Definition();

    expect(workflowDefinitionSchema.parse(v1).schemaVersion).toBe(1);
    expect(workflowDefinitionSchema.parse(v2).schemaVersion).toBe(2);
    expect(workflowDefinitionV1Schema.safeParse(v2).success).toBe(false);
    expect(workflowDefinitionV2Schema.safeParse(v1).success).toBe(false);
  });

  it("accepts typed reference and literal bindings plus ordered additional inputs", () => {
    const definition = v2Definition();
    definition.nodes.push({
      id: "notify",
      type: "send_slack_message",
      x: 100,
      y: 20,
      configuration: { message: "Done" },
      inputs: {
        ticket: {
          kind: "reference",
          reference: "steps.entry.output.ticket",
        },
        enabled: { kind: "literal", value: true },
      },
      additionalInputs: [
        {
          name: "summary",
          schema: { type: "string" },
          binding: { kind: "literal", value: "Ready" },
        },
        {
          name: "run_id",
          schema: { type: "string" },
          binding: { kind: "reference", reference: "run.id" },
        },
      ],
    });
    definition.edges.push({ id: "edge-ticket-notify", from: "ticket", to: "notify" });

    const parsed = workflowDefinitionV2Schema.parse(definition);
    expect(parsed.nodes[1]?.additionalInputs.map(({ name }) => name)).toEqual([
      "summary",
      "run_id",
    ]);
  });

  it("requires stable edge ids and canonical references", () => {
    const missingEdgeId = {
      ...v2Definition(),
      edges: [{ from: "ticket", to: "ticket" }],
    };
    expect(workflowDefinitionV2Schema.safeParse(missingEdgeId).success).toBe(false);
    expect(
      validateWorkflowDefinitionCandidate(missingEdgeId, registryContext).response.issues,
    ).toEqual([
      expect.objectContaining({
        code: "schema",
        path: "/edges/0/id",
      }),
    ]);

    const invalidReference = v2Definition();
    invalidReference.nodes[0]!.inputs = {
      ticket: {
        kind: "reference",
        reference: "trigger.ticket" as never,
      },
    };
    expect(workflowDefinitionV2Schema.safeParse(invalidReference).success).toBe(false);
    expect(isWorkflowDataReferenceV2("steps.entry.output.ticket")).toBe(true);
    expect(isWorkflowDataReferenceV2("steps.plan.output.summary")).toBe(true);
    expect(isWorkflowDataReferenceV2("run.id")).toBe(true);
    expect(isWorkflowDataReferenceV2("trigger.ticket")).toBe(false);
  });

  it("accepts exact Transform configuration only in v2", () => {
    const definition = v2Definition();
    definition.nodes.push({
      id: "shape",
      type: "transform",
      x: 100,
      y: 20,
      configuration: {
        operation: "map_object",
        fields: [
          {
            name: "title",
            value: {
              kind: "input",
              source: { input: "title", path: [] },
              defaultValue: "Untitled",
            },
          },
        ],
      },
      inputs: {},
      additionalInputs: [
        {
          name: "title",
          schema: { type: "string" },
          binding: {
            kind: "reference",
            reference: "steps.entry.output.ticket.title",
          },
        },
      ],
    });
    definition.edges.push({ id: "edge-ticket-shape", from: "ticket", to: "shape" });
    expect(workflowDefinitionV2Schema.safeParse(definition).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "v2_runtime_unavailable",
      }),
    ]);

    definition.nodes[1]!.configuration = {
      operation: "map_object",
      fields: [],
    };
    expect(workflowDefinitionV2Schema.safeParse(definition).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "shape",
        path: "/nodes/1/configuration/fields",
      }),
    ]);

    definition.nodes[1]!.configuration = {
      operation: "map_object",
      fields: [{ name: "title", value: { kind: "shell", command: "echo no" } }],
    };
    expect(workflowDefinitionV2Schema.safeParse(definition).success).toBe(false);

    expect(
      workflowDefinitionV1Schema.safeParse({
        schemaVersion: 1,
        nodes: [
          { id: "ticket", type: "transform", x: 0, y: 0, params: {}, inputs: {} },
        ],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("reports the runtime gate only after all real deployment issues are clear", () => {
    const validIssues = validateWorkflowDefinitionIssuesForDeployment(
      v2Definition(),
      registryContext,
    );
    expect(validIssues).toEqual([
      expect.objectContaining({
        code: "v2_runtime_unavailable",
        nodeId: null,
        path: "/schemaVersion",
      }),
    ]);

    const invalid = v2Definition();
    invalid.nodes[0]!.id = "entry";
    const invalidIssues = validateWorkflowDefinitionIssuesForDeployment(
      invalid,
      registryContext,
    );
    expect(invalidIssues).toEqual([
      expect.objectContaining({
        code: "deployment",
        nodeId: "entry",
        path: "/nodes/0/id",
      }),
    ]);
    expect(invalidIssues.some(({ code }) => code === "v2_runtime_unavailable")).toBe(false);
  });

  it("allows multi-edge fan-out but rejects execution-failure ports", () => {
    const fanOut = v2Definition();
    fanOut.nodes.push(
      {
        id: "first",
        type: "terminate",
        x: 100,
        y: 0,
        configuration: { terminalStatus: "done" },
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "second",
        type: "terminate",
        x: 100,
        y: 100,
        configuration: { terminalStatus: "done" },
        inputs: {},
        additionalInputs: [],
      },
    );
    fanOut.edges.push(
      { id: "first-edge", from: "ticket", to: "first" },
      { id: "second-edge", from: "ticket", to: "second" },
    );
    expect(
      validateWorkflowDefinitionIssuesForDeployment(fanOut, registryContext).map(
        ({ code }) => code,
      ),
    ).toEqual(["v2_runtime_unavailable"]);

    fanOut.edges[0]!.fromPort = "failed";
    const issues = validateWorkflowDefinitionIssuesForDeployment(fanOut, registryContext);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "deployment",
        path: "/edges/0/fromPort",
      }),
    ]);
  });

  it("keeps invalid non-Transform configuration in drafts but blocks deployment", () => {
    const unknown = v2Definition();
    unknown.nodes[0]!.configuration = { hiddenCommand: "echo unsafe" };
    expect(workflowDefinitionV2Schema.safeParse(unknown).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(unknown, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "ticket",
        path: "/nodes/0/configuration/hiddenCommand",
      }),
    ]);

    const illTyped = v2Definition();
    illTyped.nodes.push({
      id: "checks",
      type: "run_checks",
      x: 100,
      y: 0,
      configuration: { commands: "pnpm test" },
      inputs: {},
      additionalInputs: [],
    });
    illTyped.edges.push({ id: "ticket-checks", from: "ticket", to: "checks" });
    expect(workflowDefinitionV2Schema.safeParse(illTyped).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(illTyped, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "checks",
        path: "/nodes/1/configuration/commands",
      }),
    ]);
  });

  it("validates typed Branch conditions against guaranteed available values", () => {
    const valid = branchingDefinition({
      kind: "eq",
      left: {
        kind: "path",
        reference: "steps.checks.output.ok",
      },
      right: { kind: "lit", value: true },
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(valid, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "v2_runtime_unavailable",
      }),
    ]);

    const unavailable = branchingDefinition({
      kind: "path",
      reference: "steps.missing.output.ok",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        unavailable,
        registryContext,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/condition/reference",
      }),
    ]);

    const incompatible = branchingDefinition({
      kind: "eq",
      left: {
        kind: "path",
        reference: "steps.checks.output.ok",
      },
      right: { kind: "lit", value: "passed" },
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        incompatible,
        registryContext,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/condition/right/value",
      }),
    ]);

    const nonBoolean = branchingDefinition({
      kind: "path",
      reference: "steps.checks.output.results",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(nonBoolean, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/condition/reference",
      }),
    ]);
  });

  it("rejects malformed or excessively nested Branch ASTs at deployment", () => {
    const malformed = branchingDefinition({
      kind: "shell",
      command: "echo unsafe",
    });
    expect(workflowDefinitionV2Schema.safeParse(malformed).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(malformed, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/condition/kind",
      }),
    ]);

    let condition: JsonValue = { kind: "lit", value: true };
    for (let depth = 0; depth <= 20; depth += 1) {
      condition = { kind: "not", operand: condition };
    }
    const nested = branchingDefinition(condition);
    expect(workflowDefinitionV2Schema.safeParse(nested).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(nested, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/condition",
      }),
    ]);
  });

  it("round-trips stored v2 snapshots without applying v1 upgrades", () => {
    const definition = v2Definition();
    expect(upgradeStoredWorkflowDefinition(definition)).toEqual(definition);
  });
});
