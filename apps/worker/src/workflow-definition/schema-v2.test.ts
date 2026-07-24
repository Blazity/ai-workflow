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
        configuration: { combinator: "all", conditions: [condition] },
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

function loopNode(
  id: string,
  onExhaust: "fail" | "human" | "continue",
): WorkflowDefinitionV2["nodes"][number] {
  return {
    id,
    type: "loop",
    x: 100,
    y: 0,
    configuration: { maxAttempts: 2, onExhaust },
    inputs: {},
    additionalInputs: [],
  };
}

function loopBodyNode(id: string): WorkflowDefinitionV2["nodes"][number] {
  return {
    id,
    type: "send_slack_message",
    x: 200,
    y: 0,
    configuration: { message: "Retrying" },
    inputs: {},
    additionalInputs: [],
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
        operation: "build_object",
        fields: [
          {
            name: "title",
            value: {
              kind: "reference",
              reference: "steps.entry.output.ticket.title",
            },
          },
        ],
      },
      inputs: {},
      additionalInputs: [],
    });
    definition.edges.push({ id: "edge-ticket-shape", from: "ticket", to: "shape" });
    expect(workflowDefinitionV2Schema.safeParse(definition).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, registryContext),
    ).toEqual([]);

    definition.nodes[1]!.configuration = {
      operation: "build_object",
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
      operation: "build_object",
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

  it("accepts a valid v2 definition and still reports real deployment issues", () => {
    const validIssues = validateWorkflowDefinitionIssuesForDeployment(
      v2Definition(),
      registryContext,
    );
    expect(validIssues).toEqual([]);

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
  });

  it("runs block deployment and environment checks for v2 definitions", () => {
    const unsupportedSchema = v2Definition();
    unsupportedSchema.nodes.push({
      id: "agent",
      type: "generic_agent",
      x: 100,
      y: 20,
      configuration: {
        prompt: "Return a result",
        outputSchema: JSON.stringify({
          type: "object",
          properties: {
            result: { type: "string", pattern: "^ready$" },
          },
          required: ["result"],
          additionalProperties: false,
        }),
        workspaceMode: "none",
      },
      inputs: {},
      additionalInputs: [],
    });
    unsupportedSchema.edges.push({
      id: "ticket-agent",
      from: "ticket",
      to: "agent",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        unsupportedSchema,
        registryContext,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "unsupported_keyword",
        nodeId: "agent",
        path: "/nodes/1/configuration/outputSchema/properties/result/pattern",
      }),
    ]);

    const unavailable = v2Definition();
    unavailable.nodes.push({
      id: "notify",
      type: "send_slack_message",
      x: 100,
      y: 20,
      configuration: { message: "Ready" },
      inputs: {},
      additionalInputs: [],
    });
    unavailable.edges.push({
      id: "ticket-notify",
      from: "ticket",
      to: "notify",
    });
    const noSlack = { ...registryContext, slackConfigured: false };
    expect(
      validateWorkflowDefinitionIssuesForDeployment(unavailable, noSlack),
    ).toEqual([
      expect.objectContaining({
        code: "deployment",
        nodeId: "notify",
        path: "/nodes/1/configuration",
      }),
    ]);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(unavailable, noSlack, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual([]);

    const defaultedReviewTrigger = v2Definition();
    defaultedReviewTrigger.nodes[0] = {
      ...defaultedReviewTrigger.nodes[0]!,
      type: "trigger_pr_review",
      configuration: {},
    };
    expect(
      validateWorkflowDefinitionIssuesForDeployment(defaultedReviewTrigger, {
        ...registryContext,
        vcsProviders: ["gitlab"],
        vcsBotIdentities: ["gitlab"],
      }),
    ).toEqual([
      expect.objectContaining({
        code: "deployment",
        nodeId: "ticket",
        path: "/nodes/0/configuration",
      }),
    ]);
  });

  it("accepts canonical JSON Schema dialect metadata without passing it to the block", () => {
    const definition = v2Definition();
    definition.nodes.push({
      id: "agent",
      type: "generic_agent",
      x: 100,
      y: 20,
      configuration: {
        prompt: "Return a result",
        outputSchemaDialect:
          "https://json-schema.org/draft/2020-12/schema",
        outputSchema: JSON.stringify({
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        }),
        workspaceMode: "none",
      },
      inputs: {},
      additionalInputs: [],
    });
    definition.edges.push({
      id: "ticket-agent",
      from: "ticket",
      to: "agent",
    });

    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        definition,
        registryContext,
      ),
    ).toEqual([]);
  });

  it("requires exact CI check names for v2 failed-check triggers", () => {
    const definition = v2Definition();
    definition.nodes[0] = {
      ...definition.nodes[0]!,
      type: "trigger_pr_checks_failed",
      configuration: {},
    };
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        definition,
        registryContext,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "deployment",
        nodeId: "ticket",
        path: "/nodes/0/configuration/checkNames",
      }),
    ]);
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
    ).toEqual([]);

    fanOut.edges[0]!.fromPort = "failed";
    const issues = validateWorkflowDefinitionIssuesForDeployment(fanOut, registryContext);
    expect(issues).toEqual([
      expect.objectContaining({
        code: "deployment",
        path: "/edges/0/fromPort",
      }),
    ]);
  });

  it("requires every v2 Loop continue route to form a cycle", () => {
    const missingContinue = v2Definition();
    missingContinue.nodes.push(loopNode("retry", "fail"));
    missingContinue.edges.push({
      id: "ticket-retry",
      from: "ticket",
      to: "retry",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        missingContinue,
        registryContext,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "deployment",
        nodeId: "retry",
        message: 'Loop "retry" must have its "continue" port connected.',
      }),
    );

    const noCycle = v2Definition();
    noCycle.nodes.push(loopNode("retry", "fail"), {
      id: "done",
      type: "terminate",
      x: 200,
      y: 0,
      configuration: { terminalStatus: "done" },
      inputs: {},
      additionalInputs: [],
    });
    noCycle.edges.push(
      { id: "ticket-retry", from: "ticket", to: "retry" },
      {
        id: "retry-done",
        from: "retry",
        fromPort: "continue",
        to: "done",
      },
    );
    expect(
      validateWorkflowDefinitionIssuesForDeployment(noCycle, registryContext),
    ).toContainEqual(
      expect.objectContaining({
        code: "deployment",
        nodeId: "retry",
        message: 'Loop "retry"\'s continue port must lead back to it.',
      }),
    );
  });

  it('requires an exhausted route when a v2 Loop uses onExhaust "continue"', () => {
    const definition = v2Definition();
    definition.nodes.push(
      loopNode("retry", "continue"),
      loopBodyNode("body"),
    );
    definition.edges.push(
      { id: "ticket-retry", from: "ticket", to: "retry" },
      {
        id: "retry-body",
        from: "retry",
        fromPort: "continue",
        to: "body",
      },
      { id: "body-retry", from: "body", to: "retry" },
    );

    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        definition,
        registryContext,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "deployment",
        nodeId: "retry",
        message:
          'Loop "retry" with onExhaust "continue" must have its "exhausted" port connected.',
      }),
    );
  });

  it("rejects v2 cycle regions containing multiple Loop blocks", () => {
    const definition = v2Definition();
    definition.nodes.push(
      loopNode("outer", "fail"),
      loopNode("inner", "fail"),
      loopBodyNode("body"),
    );
    definition.edges.push(
      { id: "ticket-outer", from: "ticket", to: "outer" },
      {
        id: "outer-inner",
        from: "outer",
        fromPort: "continue",
        to: "inner",
      },
      {
        id: "inner-body",
        from: "inner",
        fromPort: "continue",
        to: "body",
      },
      { id: "body-outer", from: "body", to: "outer" },
    );

    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        definition,
        registryContext,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "deployment",
        message: expect.stringContaining(
          "form a cycle region with 2 Loop blocks; each cycle region must contain exactly one.",
        ),
      }),
    );
  });

  it("accepts a valid v2 Loop cycle and exhausted route", () => {
    const definition = v2Definition();
    definition.nodes.push(
      loopNode("retry", "continue"),
      loopBodyNode("body"),
      {
        id: "done",
        type: "terminate",
        x: 300,
        y: 0,
        configuration: { terminalStatus: "done" },
        inputs: {},
        additionalInputs: [],
      },
    );
    definition.edges.push(
      { id: "ticket-retry", from: "ticket", to: "retry" },
      {
        id: "retry-body",
        from: "retry",
        fromPort: "continue",
        to: "body",
      },
      { id: "body-retry", from: "body", to: "retry" },
      {
        id: "retry-done",
        from: "retry",
        fromPort: "exhausted",
        to: "done",
      },
    );

    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        definition,
        registryContext,
      ),
    ).toEqual([]);
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
      reference: "steps.checks.output.ok",
      operator: "equals",
      value: true,
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(valid, registryContext),
    ).toEqual([]);

    const unavailable = branchingDefinition({
      reference: "steps.missing.output.ok",
      operator: "has_value",
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
        path: "/nodes/2/configuration/conditions/0/reference",
      }),
    ]);

    const incompatible = branchingDefinition({
      reference: "steps.checks.output.ok",
      operator: "equals",
      value: "passed",
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
        path: "/nodes/2/configuration/conditions/0/value",
      }),
    ]);

    const nonBoolean = branchingDefinition({
      reference: "steps.checks.output.results",
      operator: "has_value",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(nonBoolean, registryContext),
    ).toEqual([]);

    const nonScalarComparison = branchingDefinition({
      reference: "steps.checks.output.results",
      operator: "equals",
      value: "passed",
    });
    expect(
      validateWorkflowDefinitionIssuesForDeployment(
        nonScalarComparison,
        registryContext,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/conditions/0/reference",
      }),
    ]);
  });

  it("keeps incomplete Branch rows in drafts and reports exact deployment paths", () => {
    const malformed = branchingDefinition({
      reference: "steps.checks.output.ok",
      operator: "contains",
    });
    expect(workflowDefinitionV2Schema.safeParse(malformed).success).toBe(true);
    expect(
      validateWorkflowDefinitionIssuesForDeployment(malformed, registryContext),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/conditions/0/value",
      }),
    ]);
  });

  it("rejects potentially concurrent shared-workspace writers", () => {
    const definition: WorkflowDefinitionV2 = {
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
          id: "left",
          type: "generic_agent",
          x: 100,
          y: -50,
          configuration: {
            prompt: "Left",
            workspaceMode: "read_write",
          },
          inputs: {},
          additionalInputs: [],
        },
        {
          id: "right",
          type: "generic_agent",
          x: 100,
          y: 50,
          configuration: {
            prompt: "Right",
            workspaceMode: "read_write",
          },
          inputs: {},
          additionalInputs: [],
        },
      ],
      edges: [
        { id: "left-edge", from: "ticket", to: "left" },
        { id: "right-edge", from: "ticket", to: "right" },
      ],
    };

    expect(
      validateWorkflowDefinitionIssuesForDeployment(definition, registryContext),
    ).toContainEqual(
      expect.objectContaining({
        code: "workspace.concurrent_access",
        nodeId: "right",
      }),
    );
  });

  it("round-trips stored v2 snapshots without applying v1 upgrades", () => {
    const definition = v2Definition();
    expect(upgradeStoredWorkflowDefinition(definition)).toEqual(definition);
  });
});
