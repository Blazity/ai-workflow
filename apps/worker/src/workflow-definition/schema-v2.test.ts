import { describe, expect, it } from "vitest";
import type {
  JsonValue,
  WorkflowBlockType,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2ControlEdge,
  WorkflowDefinitionV2Node,
} from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "../engine/definition/block-contract-resolver.js";
import {
  testBlockData,
  testDeploymentIssues,
} from "../test-support/block-contracts.js";
import {
  isWorkflowDataReferenceV2,
  parse,
  workflowDefinitionV2Schema,
} from "@shared/workflow-graph";
import { validateWorkflowDefinitionForDeployment } from "./deployment-validation.js";
import { parseStoredWorkflowDefinition } from "./stored-definition.js";
import { validateWorkflowDefinitionCandidate } from "./validation.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

const blockData = testBlockData(registryContext);

/** `validateWorkflowDefinitionForDeployment` analyses the definition itself, so
 *  it takes the block data without the request analyser. */
const deploymentBlockData = (context: WorkflowBlockRegistryContext) => {
  const [resolveContract, blockParamsSchemas, configuredVcsProviders] =
    testBlockData(context);
  return [resolveContract, blockParamsSchemas, configuredVcsProviders] as const;
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
  it("parses the runnable definition as v2", () => {
    expect(workflowDefinitionV2Schema.parse(v2Definition()).schemaVersion).toBe(2);
  });

  it("round-trips a pinned repository scope and rejects an invalid one", () => {
    const repositoryScope = {
      repositories: [
        { provider: "github" as const, repoPath: "acme/web" },
        { provider: "gitlab" as const, repoPath: "acme/group/subgroup/api" },
      ],
      providers: ["github" as const, "gitlab" as const],
    };

    expect(
      workflowDefinitionV2Schema.parse({ ...v2Definition(), repositoryScope }).repositoryScope,
    ).toEqual(repositoryScope);

    expect(
      workflowDefinitionV2Schema.safeParse({ ...v2Definition(), repositoryScope: {} }).success,
    ).toBe(true);
    expect(
      workflowDefinitionV2Schema.safeParse({
        ...v2Definition(),
        repositoryScope: { repositories: [{ provider: "github", repoPath: "acme" }] },
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionV2Schema.safeParse({
        ...v2Definition(),
        repositoryPin: { providers: ["github"] },
      }).success,
    ).toBe(false);
  });

  it("parses a v2 definition without a repository scope exactly as before", () => {
    const parsed = workflowDefinitionV2Schema.parse(v2Definition());
    expect(parsed.repositoryScope).toBeUndefined();
    expect("repositoryScope" in parsed).toBe(false);
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
      validateWorkflowDefinitionCandidate(missingEdgeId, ...blockData).response.issues,
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
    expect(isWorkflowDataReferenceV2("steps.entry.output")).toBe(true);
    expect(isWorkflowDataReferenceV2("steps.review.output")).toBe(true);
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
      testDeploymentIssues(definition, ...blockData),
    ).toEqual([]);

    definition.nodes[1]!.configuration = {
      operation: "build_object",
      fields: [],
    };
    expect(workflowDefinitionV2Schema.safeParse(definition).success).toBe(true);
    expect(
      testDeploymentIssues(definition, ...blockData),
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

  });

  it("accepts a valid v2 definition and still reports real deployment issues", () => {
    const validIssues = testDeploymentIssues(
      v2Definition(),
      ...blockData,
    );
    expect(validIssues).toEqual([]);

    const invalid = v2Definition();
    invalid.nodes[0]!.id = "entry";
    const invalidIssues = testDeploymentIssues(
      invalid,
      ...blockData,
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
      testDeploymentIssues(
        unsupportedSchema,
        ...blockData,
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
    const noSlack = testBlockData({ ...registryContext, slackConfigured: false });
    expect(
      testDeploymentIssues(unavailable, ...noSlack),
    ).toEqual([
      expect.objectContaining({
        code: "deployment",
        nodeId: "notify",
        path: "/nodes/1/configuration",
      }),
    ]);
    expect(
      testDeploymentIssues(unavailable, ...noSlack, {
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
      testDeploymentIssues(
        defaultedReviewTrigger,
        ...testBlockData({
          ...registryContext,
          vcsProviders: ["gitlab"],
          vcsBotIdentities: ["gitlab"],
        }),
      ),
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
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toEqual([]);
  });

  it("deploys a v2 failed-check trigger that names no check", () => {
    const definition = v2Definition();
    definition.nodes[0] = {
      ...definition.nodes[0]!,
      type: "trigger_pr_checks_failed",
      configuration: {},
    };
    // Naming checks is now a narrowing option rather than a precondition, so an
    // author who does not know their CI job names can still deploy.
    expect(
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toEqual([]);
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
      testDeploymentIssues(fanOut, ...blockData).map(
        ({ code }) => code,
      ),
    ).toEqual([]);

    fanOut.edges[0]!.fromPort = "failed";
    const issues = testDeploymentIssues(fanOut, ...blockData);
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
      testDeploymentIssues(
        missingContinue,
        ...blockData,
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
      testDeploymentIssues(noCycle, ...blockData),
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
      testDeploymentIssues(
        definition,
        ...blockData,
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
      testDeploymentIssues(
        definition,
        ...blockData,
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
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toEqual([]);
  });

  it("validates typed Loop carry names, schemas, and bindings", () => {
    const definition = v2Definition();
    const retry = loopNode("retry", "continue");
    retry.configuration.carry = [{
      name: "ticket_status",
      schema: { type: "string" },
      binding: {
        kind: "reference",
        reference: "steps.entry.output.status",
      },
    }];
    definition.nodes.push(
      retry,
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
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toEqual([]);

    const existingCarry = retry.configuration.carry;
    expect(Array.isArray(existingCarry)).toBe(true);
    retry.configuration.carry = [
      ...(Array.isArray(existingCarry) ? existingCarry : []),
      {
        name: "ticket_status",
        schema: { type: "number" },
        binding: {
          kind: "reference",
          reference: "steps.entry.output.status",
        },
      },
    ];
    expect(
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "loop.carry_name",
        nodeId: "retry",
        path: "/nodes/1/configuration/carry/1/name",
      }),
    );

    retry.configuration.carry = [{
      name: "ticket_status",
      schema: { type: "unsupported" },
      binding: {
        kind: "reference",
        reference: "steps.entry.output.status",
      },
    }];
    expect(
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "loop.carry_schema.unsupported_type",
        nodeId: "retry",
        path: "/nodes/1/configuration/carry/0/schema/type",
      }),
    );

    retry.configuration.carry = [{
      name: "ticket_status",
      schema: { type: "string" },
      binding: {
        kind: "literal",
        value: 42,
      },
    }];
    expect(
      testDeploymentIssues(
        definition,
        ...blockData,
      ),
    ).toContainEqual(
      expect.objectContaining({
        code: "binding.literal_type",
        nodeId: "retry",
        path: "/nodes/1/configuration/carry/0/binding/value",
      }),
    );
  });

  it("keeps invalid non-Transform configuration in drafts but blocks deployment", () => {
    const unknown = v2Definition();
    unknown.nodes[0]!.configuration = { hiddenCommand: "echo unsafe" };
    expect(workflowDefinitionV2Schema.safeParse(unknown).success).toBe(true);
    expect(
      testDeploymentIssues(unknown, ...blockData),
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
      testDeploymentIssues(illTyped, ...blockData),
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
      testDeploymentIssues(valid, ...blockData),
    ).toEqual([]);

    const unavailable = branchingDefinition({
      reference: "steps.missing.output.ok",
      operator: "has_value",
    });
    expect(
      testDeploymentIssues(
        unavailable,
        ...blockData,
      ),
    ).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "decision",
        path: "/nodes/2/configuration/conditions/0/reference",
      }),
    ]);

    const conditionallyUnavailable = branchingDefinition({
      reference: "steps.checks.output.ok",
      operator: "has_value",
    });
    conditionallyUnavailable.nodes.splice(1, 0, {
      id: "route",
      type: "branch",
      x: 50,
      y: 0,
      configuration: {
        combinator: "all",
        conditions: [
          {
            reference: "steps.entry.output.ticketKey",
            operator: "has_value",
          },
        ],
      },
      inputs: {},
      additionalInputs: [],
    });
    conditionallyUnavailable.edges = [
      { id: "ticket-route", from: "ticket", to: "route" },
      {
        id: "route-checks",
        from: "route",
        fromPort: "true",
        to: "checks",
      },
      {
        id: "route-decision",
        from: "route",
        fromPort: "false",
        to: "decision",
      },
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
    ];
    expect(
      testDeploymentIssues(
        conditionallyUnavailable,
        ...blockData,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_configuration",
          nodeId: "decision",
          path: "/nodes/3/configuration/conditions/0/reference",
          message: expect.stringContaining(
            "This step can be skipped on a path that reaches the current block.",
          ),
        }),
      ]),
    );

    const incompatible = branchingDefinition({
      reference: "steps.checks.output.ok",
      operator: "equals",
      value: "passed",
    });
    expect(
      testDeploymentIssues(
        incompatible,
        ...blockData,
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
      testDeploymentIssues(nonBoolean, ...blockData),
    ).toEqual([]);

    const nonScalarComparison = branchingDefinition({
      reference: "steps.checks.output.results",
      operator: "equals",
      value: "passed",
    });
    expect(
      testDeploymentIssues(
        nonScalarComparison,
        ...blockData,
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
      testDeploymentIssues(malformed, ...blockData),
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
      testDeploymentIssues(definition, ...blockData),
    ).toContainEqual(
      expect.objectContaining({
        code: "workspace.concurrent_access",
        nodeId: "right",
      }),
    );
  });

  it("round-trips stored v2 snapshots without applying v1 upgrades", () => {
    const definition = v2Definition();
    expect(parse(definition).definition).toEqual(definition);
  });

  it("normalizes duplicate agent provider and model fields to the pinned profile", () => {
    const definition = v2Definition();
    definition.nodes.push({
      id: "agent",
      type: "implementation_agent",
      x: 100,
      y: 0,
      configuration: {
        harnessProfile: {
          profileId: "profile-1",
          version: 2,
        },
        provider: "claude",
        model: "stale-model",
        prompt: "Implement the ticket.",
      },
      inputs: {},
      additionalInputs: [],
    });

    const parsed = workflowDefinitionV2Schema.parse(definition);
    expect(parsed.nodes[1]?.configuration).toEqual({
      harnessProfile: {
        profileId: "profile-1",
        version: 2,
      },
      prompt: "Implement the ticket.",
    });
  });

  it("preserves agent provider and model fields without a pinned profile", () => {
    const definition = v2Definition();
    definition.nodes.push({
      id: "agent",
      type: "implementation_agent",
      x: 100,
      y: 0,
      configuration: {
        provider: "claude",
        model: "claude-opus-4-6",
        prompt: "Implement the ticket.",
      },
      inputs: {},
      additionalInputs: [],
    });

    const parsed = workflowDefinitionV2Schema.parse(definition);
    expect(parsed.nodes[1]?.configuration).toEqual({
      provider: "claude",
      model: "claude-opus-4-6",
      prompt: "Implement the ticket.",
    });
  });
});

describe("repository script node configuration", () => {
  const scriptsDefinition = (
    type: "run_scripts" | "run_pre_pr_checks",
    configuration: Record<string, JsonValue>,
  ): WorkflowDefinitionV2 => ({
    schemaVersion: 2,
    nodes: [
      {
        id: "entry",
        type: "trigger_ticket_ai",
        x: 0,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "workspace",
        type: "prepare_workspace",
        x: 1,
        y: 0,
        configuration: {},
        inputs: {},
        additionalInputs: [],
      },
      {
        id: "scripts",
        type,
        x: 2,
        y: 0,
        configuration,
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [
      { from: "entry", fromPort: "out", to: "workspace" },
      { from: "workspace", fromPort: "out", to: "scripts" },
    ] as WorkflowDefinitionV2ControlEdge[],
  });

  const configurationIssues = (
    type: "run_scripts" | "run_pre_pr_checks",
    configuration: Record<string, JsonValue>,
  ) =>
    testDeploymentIssues(
      scriptsDefinition(type, configuration),
      ...blockData,
    ).filter((issue) => issue.code === "invalid_configuration");

  it("accepts one or many named groups on run_scripts", () => {
    expect(configurationIssues("run_scripts", { groups: ["checks"] })).toEqual([]);
    expect(
      configurationIssues("run_scripts", { groups: ["test", "lint", "type-check"] }),
    ).toEqual([]);
  });

  it("refuses a run_scripts node that selects nothing", () => {
    // A block that runs no group would report a green verdict for a repository
    // nothing verified, which is the exact failure the outcome enum exists to
    // make visible. It is refused at deployment instead.
    expect(configurationIssues("run_scripts", { groups: [] })).not.toEqual([]);
    expect(configurationIssues("run_scripts", {})).not.toEqual([]);
  });

  it("holds group names to the shape the scripts configuration stores", () => {
    expect(configurationIssues("run_scripts", { groups: ["Checks"] })).not.toEqual([]);
    expect(configurationIssues("run_scripts", { groups: ["pnpm test"] })).not.toEqual([]);
    expect(configurationIssues("run_scripts", { groups: ["9lives"] })).not.toEqual([]);
    expect(configurationIssues("run_scripts", { groups: ["a".repeat(41)] })).not.toEqual([]);
    expect(configurationIssues("run_scripts", { groups: ["a".repeat(40)] })).toEqual([]);
  });

  it("rejects any key beyond groups", () => {
    expect(
      configurationIssues("run_scripts", { groups: ["checks"], maxFixCycles: 1 }),
    ).not.toEqual([]);
  });

  it("still accepts maxFixCycles on a gate node deployed before the repair loop went", () => {
    // Every stored definition that carries the key has to keep validating: the
    // parameter is accepted and ignored, never removed from the strict schema.
    expect(configurationIssues("run_pre_pr_checks", { maxFixCycles: 3 })).toEqual([]);
    expect(configurationIssues("run_pre_pr_checks", { maxFixCycles: 0 })).toEqual([]);
    expect(configurationIssues("run_pre_pr_checks", {})).toEqual([]);
    // The bound it was authored under is unchanged, so a definition that was
    // invalid before this change is still invalid.
    expect(configurationIssues("run_pre_pr_checks", { maxFixCycles: 6 })).not.toEqual([]);
  });
});

describe("webhook trigger configuration", () => {
  const webhookDefinition = (configuration: Record<string, JsonValue>) => ({
    schemaVersion: 2 as const,
    nodes: [
      {
        id: "entry",
        type: "trigger_webhook" as const,
        x: 0,
        y: 0,
        configuration,
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  });

  const configurationIssues = (configuration: Record<string, JsonValue>) =>
    testDeploymentIssues(
      webhookDefinition(configuration),
      ...blockData,
    ).filter((issue) => issue.code === "invalid_configuration");

  it("accepts an empty configuration so a freshly dropped block deploys", () => {
    expect(configurationIssues({})).toEqual([]);
  });

  it("accepts every supported key", () => {
    expect(
      configurationIssues({
        authScheme: "shared_token",
        headerName: "X-Zendesk-Token",
        subjectPath: "ticket.id",
        mapSubject: "ticket.subject",
        mapDescription: "ticket.description",
        mapRequester: "ticket.requester.email",
        mapPriority: "ticket.priority",
      }),
    ).toEqual([]);
  });

  it("rejects an unknown auth scheme", () => {
    expect(configurationIssues({ authScheme: "basic" })).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "entry",
        path: "/nodes/0/configuration/authScheme",
      }),
    ]);
  });

  it("rejects an empty header name", () => {
    expect(configurationIssues({ headerName: "" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/nodes/0/configuration/headerName" }),
      ]),
    );
  });

  it("rejects a header name that is not an HTTP header token", () => {
    for (const headerName of ["X Workflow Signature", "X-Signature:", "X-Sig\nInjected"]) {
      expect(configurationIssues({ headerName }), headerName).toEqual([
        expect.objectContaining({
          path: "/nodes/0/configuration/headerName",
          message: expect.stringContaining("valid HTTP header token"),
        }),
      ]);
    }
  });

  it("accepts the timestamp replay-protection keys", () => {
    expect(
      configurationIssues({
        requireTimestamp: true,
        timestampHeader: "X-Zendesk-Timestamp",
        timestampToleranceSeconds: 600,
      }),
    ).toEqual([]);
  });

  it("accepts requireTimestamp with the HMAC scheme, explicit or defaulted", () => {
    expect(
      configurationIssues({ authScheme: "hmac_sha256", requireTimestamp: true }),
    ).toEqual([]);
    // hmac_sha256 is the default, so an absent scheme is fine too.
    expect(configurationIssues({ requireTimestamp: true })).toEqual([]);
  });

  it("rejects requireTimestamp with the shared_token scheme", () => {
    // Silently no-opping would give a false sense of protection; the deploy fails.
    expect(
      configurationIssues({ authScheme: "shared_token", requireTimestamp: true }),
    ).toEqual([
      expect.objectContaining({
        path: "/nodes/0/configuration/requireTimestamp",
        message: expect.stringContaining("HMAC SHA-256 scheme"),
      }),
    ]);
  });

  it("rejects a tolerance below the minimum or above the maximum", () => {
    for (const timestampToleranceSeconds of [5, 100000]) {
      expect(
        configurationIssues({ timestampToleranceSeconds }),
        String(timestampToleranceSeconds),
      ).toEqual([
        expect.objectContaining({
          path: "/nodes/0/configuration/timestampToleranceSeconds",
        }),
      ]);
    }
  });

  it("accepts a tolerance at the 900s ceiling and rejects 901", () => {
    expect(configurationIssues({ timestampToleranceSeconds: 900 })).toEqual([]);
    expect(configurationIssues({ timestampToleranceSeconds: 901 })).toEqual([
      expect.objectContaining({
        path: "/nodes/0/configuration/timestampToleranceSeconds",
      }),
    ]);
  });

  it("rejects a timestamp header that is not an HTTP header token", () => {
    expect(configurationIssues({ timestampHeader: "X Timestamp Header" })).toEqual([
      expect.objectContaining({
        path: "/nodes/0/configuration/timestampHeader",
        message: expect.stringContaining("valid HTTP header token"),
      }),
    ]);
  });

  it("rejects payload paths with empty, unsafe, or prototype-mutating segments", () => {
    for (const path of ["", "ticket..id", "ticket.", ".id", "ticket.sub ject"]) {
      // An empty string trips both the length and the shape rule, so assert the
      // offending path rather than an exact issue count.
      expect(configurationIssues({ mapSubject: path }), path).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "/nodes/0/configuration/mapSubject" }),
        ]),
      );
    }
    expect(configurationIssues({ subjectPath: "__proto__.id" })).toEqual([
      expect.objectContaining({ path: "/nodes/0/configuration/subjectPath" }),
    ]);
  });

  it("rejects a key the block does not own", () => {
    expect(configurationIssues({ secret: "whsec_leak" })).toEqual([
      expect.objectContaining({ path: "/nodes/0/configuration/secret" }),
    ]);
  });

  it("is unavailable for deployment without a configured encryption key", () => {
    expect(
      validateWorkflowDefinitionForDeployment(
        webhookDefinition({}),
        ...deploymentBlockData({
          ...registryContext,
          webhookTriggerConfigured: false,
        }),
      ),
    ).toContain(
      'Block "entry" (trigger_webhook) is unavailable: Webhook trigger encryption is not configured.',
    );
  });
});

describe("schedule trigger configuration", () => {
  // "entry" is a reserved block id (see validateWorkflowGraphV2Issues), so the
  // full-deployment-issues assertions below stay clean with a plain id.
  const scheduleDefinition = (configuration: Record<string, JsonValue>) => ({
    schemaVersion: 2 as const,
    nodes: [
      {
        id: "schedule",
        type: "trigger_schedule" as const,
        x: 0,
        y: 0,
        configuration,
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  });

  const configurationIssues = (configuration: Record<string, JsonValue>) =>
    testDeploymentIssues(
      scheduleDefinition(configuration),
      ...blockData,
    ).filter((issue) => issue.code === "invalid_configuration");

  const deploymentIssues = (configuration: Record<string, JsonValue>) =>
    validateWorkflowDefinitionForDeployment(
      scheduleDefinition(configuration),
      ...deploymentBlockData(registryContext),
    );

  it("applies defaults for an empty configuration so a freshly dropped block still saves", () => {
    expect(configurationIssues({})).toEqual([]);
  });

  it("accepts every supported key", () => {
    expect(
      configurationIssues({
        cron: "0 9 * * 1",
        timezone: "Europe/Warsaw",
        overlapPolicy: "queue",
        catchUpGraceMinutes: 30,
        taskTitle: "Weekly dependency refresh",
        taskDescription: "Check and update outdated dependencies.",
      }),
    ).toEqual([]);
  });

  it("rejects a key the block does not own", () => {
    expect(configurationIssues({ secret: "whsec_leak" })).toEqual([
      expect.objectContaining({ path: "/nodes/0/configuration/secret" }),
    ]);
  });

  it("rejects an unknown overlap policy", () => {
    expect(configurationIssues({ overlapPolicy: "retry" })).toEqual([
      expect.objectContaining({
        code: "invalid_configuration",
        nodeId: "schedule",
        path: "/nodes/0/configuration/overlapPolicy",
      }),
    ]);
  });

  it("rejects a non-positive catch-up grace period", () => {
    for (const catchUpGraceMinutes of [0, -5]) {
      expect(
        configurationIssues({ catchUpGraceMinutes }),
        String(catchUpGraceMinutes),
      ).toEqual([
        expect.objectContaining({ path: "/nodes/0/configuration/catchUpGraceMinutes" }),
      ]);
    }
  });

  it("rejects a non-integer catch-up grace period", () => {
    // Deliberately above the five-minute floor so this keeps testing integrality
    // on its own. 1.5 would now trip the floor as well and the single-issue
    // assertion would stop telling us which rule fired.
    expect(configurationIssues({ catchUpGraceMinutes: 7.5 })).toEqual([
      expect.objectContaining({ path: "/nodes/0/configuration/catchUpGraceMinutes" }),
    ]);
  });

  it("blocks deployment of an empty or whitespace-only cron before deployment", () => {
    for (const cron of ["", "   "]) {
      expect(deploymentIssues({ cron, taskTitle: "t", taskDescription: "d" }), cron).toContain(
        'Block "schedule" (trigger_schedule) must configure a cron schedule before deployment.',
      );
    }
  });

  it("blocks deployment of an empty or whitespace-only task title before deployment", () => {
    for (const taskTitle of ["", "   "]) {
      expect(
        deploymentIssues({ cron: "0 9 * * 1", taskTitle, taskDescription: "d" }),
        taskTitle,
      ).toContain(
        'Block "schedule" (trigger_schedule) must configure a task title before deployment.',
      );
    }
  });

  it("blocks deployment of an empty or whitespace-only task description before deployment", () => {
    for (const taskDescription of ["", "   "]) {
      expect(
        deploymentIssues({ cron: "0 9 * * 1", taskTitle: "t", taskDescription }),
        taskDescription,
      ).toContain(
        'Block "schedule" (trigger_schedule) must configure a task description before deployment.',
      );
    }
  });

  it("deploys once cron, task title, and task description are all set", () => {
    expect(
      deploymentIssues({
        cron: "0 9 * * 1",
        taskTitle: "Weekly dependency refresh",
        taskDescription: "Check and update outdated dependencies.",
      }),
    ).toEqual([]);
  });

  // The three checks below delegate to the schedule-trigger evaluator, so these
  // assert the wiring and the field each problem points at, not the time
  // arithmetic itself, which is covered in schedule-trigger/occurrence.test.ts.
  const scheduleDeploymentIssues = (configuration: Record<string, JsonValue>) =>
    testDeploymentIssues(
      scheduleDefinition(configuration),
      ...blockData,
    ).filter((issue) => issue.code === "deployment");

  const configured = (configuration: Record<string, JsonValue>) => ({
    taskTitle: "Weekly dependency refresh",
    taskDescription: "Check and update outdated dependencies.",
    ...configuration,
  });

  it("blocks deployment of a syntactically invalid cron expression", () => {
    for (const cron of ["every monday", "0 9 * *", "99 9 * * *"]) {
      expect(scheduleDeploymentIssues(configured({ cron })), cron).toEqual([
        expect.objectContaining({
          nodeId: "schedule",
          path: "/nodes/0/configuration/cron",
          message: expect.stringContaining(
            'Block "schedule" (trigger_schedule) must configure a valid cron expression before deployment:',
          ),
        }),
      ]);
    }
  });

  it("blocks deployment of an unknown timezone and points at the timezone field", () => {
    // A schedule that quietly ran in UTC because the zone was misspelled would
    // look correct in every log line and be an hour out for half the year.
    expect(
      scheduleDeploymentIssues(
        configured({ cron: "0 9 * * 1", timezone: "Europe/Warszawa" }),
      ),
    ).toEqual([
      expect.objectContaining({
        nodeId: "schedule",
        path: "/nodes/0/configuration/timezone",
        message: expect.stringContaining(
          'Block "schedule" (trigger_schedule) must configure a known IANA timezone before deployment:',
        ),
      }),
    ]);
  });

  it("blocks deployment of a schedule that fires more often than the floor", () => {
    const [issue] = scheduleDeploymentIssues(
      configured({ cron: "*/5 * * * *", timezone: "Europe/Warsaw" }),
    );
    expect(issue).toMatchObject({
      nodeId: "schedule",
      path: "/nodes/0/configuration/cron",
    });
    expect(issue?.message).toContain(
      'Block "schedule" (trigger_schedule) must leave at least 15 minutes between runs before deployment:',
    );
    expect(issue?.message).toContain(
      "Agent runs occupy a small shared pool, so a schedule firing faster than that can starve the rest of the queue.",
    );
  });

  it("deploys a schedule sitting exactly on the fifteen-minute floor", () => {
    expect(
      deploymentIssues(
        configured({ cron: "*/15 * * * *", timezone: "Europe/Warsaw" }),
      ),
    ).toEqual([]);
  });

  it("deploys a valid weekly schedule in a named timezone", () => {
    expect(
      deploymentIssues(
        configured({ cron: "30 9 * * 1-5", timezone: "Asia/Kolkata" }),
      ),
    ).toEqual([]);
  });

  it("reports an empty cron once, without also calling it invalid syntax", () => {
    // Two issues on one field in one deploy is noise: the emptiness issue
    // already tells the user exactly what to do.
    for (const cron of ["", "   "]) {
      expect(deploymentIssues(configured({ cron })), cron).toEqual([
        'Block "schedule" (trigger_schedule) must configure a cron schedule before deployment.',
      ]);
    }
  });

  it("blocks deployment of a present but empty timezone instead of reading it as UTC", () => {
    // The gap this closes: `timezone: z.string().default("UTC")` only fills in a
    // *missing* key, so an empty string parses fine and reaches the evaluator,
    // which refuses it. Substituting UTC here would let the definition deploy
    // clean and then have every tick of the dispatcher come back invalid, and this
    // validator is the last place able to catch it before shipping.
    for (const timezone of ["", "   "]) {
      const issues = scheduleDeploymentIssues(
        configured({ cron: "0 9 * * *", timezone }),
      );
      expect(issues, JSON.stringify(timezone)).toEqual([
        expect.objectContaining({
          nodeId: "schedule",
          path: "/nodes/0/configuration/timezone",
          message: expect.stringContaining(
            'Block "schedule" (trigger_schedule) must configure a known IANA timezone before deployment:',
          ),
        }),
      ]);
    }
  });

  it("still treats an absent timezone key as the schema default", () => {
    // Only a genuinely missing key gets UTC, because that is what the runtime
    // reads too. An author who never touched the field is not making a mistake.
    expect(deploymentIssues(configured({ cron: "0 9 * * *" }))).toEqual([]);
  });

  it("blocks deployment of a fixed-offset timezone, which does not follow daylight saving", () => {
    for (const timezone of ["+02:00", "Etc/GMT+5"]) {
      const [issue] = scheduleDeploymentIssues(
        configured({ cron: "0 9 * * *", timezone }),
      );
      expect(issue, timezone).toMatchObject({
        path: "/nodes/0/configuration/timezone",
      });
      expect(issue?.message, timezone).toContain("daylight saving");
    }
  });

  it("blocks deployment of an expression that will never fire, with its own message", () => {
    // 30 February. Distinct wording on purpose: the floor message would tell an
    // author their never-firing schedule is too frequent, sending them to look at
    // the wrong thing entirely.
    const [issue] = scheduleDeploymentIssues(
      configured({ cron: "0 0 30 2 *", timezone: "Europe/Warsaw" }),
    );
    expect(issue).toMatchObject({
      nodeId: "schedule",
      path: "/nodes/0/configuration/cron",
    });
    expect(issue?.message).toContain(
      'Block "schedule" (trigger_schedule) must configure a cron expression with upcoming occurrences before deployment:',
    );
    expect(issue?.message).not.toContain("minutes between runs");
  });

  it("rejects a catch-up grace below five minutes, because the scheduler ticks once a minute", () => {
    // The dial reads like "how stale a run may be" but buys "how many missed
    // ticks I tolerate". At 1 minute a single two-minute stall of the platform
    // cron loses the run outright, so an author tightening this to avoid stale
    // work would instead be trading away runs silently.
    for (const catchUpGraceMinutes of [1, 2, 3, 4]) {
      expect(
        configurationIssues({ catchUpGraceMinutes }),
        String(catchUpGraceMinutes),
      ).toEqual([
        expect.objectContaining({
          path: "/nodes/0/configuration/catchUpGraceMinutes",
          message: expect.stringContaining("evaluates once a minute"),
        }),
      ]);
    }
  });

  it("accepts a catch-up grace at the five-minute floor and above", () => {
    for (const catchUpGraceMinutes of [5, 30, 60, 720]) {
      expect(
        configurationIssues({ catchUpGraceMinutes }),
        String(catchUpGraceMinutes),
      ).toEqual([]);
    }
  });
});

describe("schedule graphs run unattended", () => {
  const node = (
    id: string,
    type: WorkflowBlockType,
    configuration: Record<string, JsonValue> = {},
  ): WorkflowDefinitionV2Node => ({
    id,
    type,
    x: 0,
    y: 0,
    configuration,
    inputs: {},
    additionalInputs: [],
  });

  const edge = (from: string, to: string): WorkflowDefinitionV2ControlEdge => ({
    id: `${from}-${to}`,
    from,
    to,
  });

  const scheduleTrigger = (id = "schedule") =>
    node(id, "trigger_schedule", {
      cron: "*/15 * * * *",
      timezone: "UTC",
      taskTitle: "Weekly dependency refresh",
      taskDescription: "Check and update outdated dependencies.",
    });

  const graph = (
    nodes: WorkflowDefinitionV2["nodes"],
    edges: WorkflowDefinitionV2["edges"],
  ): WorkflowDefinitionV2 => ({ schemaVersion: 2, nodes, edges });

  const unattendedIssues = (definition: WorkflowDefinitionV2) =>
    testDeploymentIssues(definition, ...blockData).filter(
      (issue) => issue.message.includes("waits for a person"),
    );

  // A parked subject is protected from reconciliation, so under skip and queue one
  // run stopped on a decision holds the schedule's turn forever, and no product
  // surface can cancel a scheduled run (Slack cancellation addresses runs by ticket
  // key, and this one has no ticket). The price of the rule is real and deliberate:
  // no recurring workflow can ask for plan approval.
  it.each(["human_question", "send_plan_approval"] as const)(
    "refuses to deploy a schedule graph that can reach %s",
    (blockType) => {
      const issues = unattendedIssues(
        graph(
          [scheduleTrigger(), node("waiter", blockType)],
          [edge("schedule", "waiter")],
        ),
      );

      expect(issues).toEqual([
        expect.objectContaining({
          code: "deployment",
          // Names the exact block, because that is the one the author has to remove.
          nodeId: "waiter",
          path: "/nodes/1",
          message: expect.stringContaining(`Block "waiter" (${blockType})`),
        }),
      ]);
      expect(issues[0]?.message).toContain("recurring trigger runs unattended");
    },
  );

  it("catches a human wait several blocks downstream of the schedule", () => {
    expect(
      unattendedIssues(
        graph(
          [
            scheduleTrigger(),
            node("prepare", "prepare_workspace"),
            node("waiter", "human_question"),
          ],
          [edge("schedule", "prepare"), edge("prepare", "waiter")],
        ),
      ),
    ).toHaveLength(1);
  });

  it("leaves an unattended schedule graph alone", () => {
    expect(
      unattendedIssues(
        graph(
          [scheduleTrigger(), node("prepare", "prepare_workspace")],
          [edge("schedule", "prepare")],
        ),
      ),
    ).toEqual([]);
  });

  // The rule is about the schedule's own path, not about the block existing in the
  // product: a ticket graph may still park on a question.
  it("leaves a human wait reachable only from a ticket trigger alone", () => {
    expect(
      unattendedIssues(
        graph(
          [node("ticket", "trigger_ticket_ai"), node("waiter", "human_question")],
          [edge("ticket", "waiter")],
        ),
      ),
    ).toEqual([]);
  });

  // A scheduled occurrence has no ticket, no labels and a fresh subject, so nothing
  // in it names a repository. Without a pin the discovery agent guesses from the
  // task description, the input is identical every occurrence, and an uncertain
  // guess fails the run with no ticket to report the failure on.
  describe("and must know which repository they work in", () => {
    const pinnedIssues = (definition: WorkflowDefinitionV2) =>
      testDeploymentIssues(definition, ...blockData).filter(
        (issue) => issue.message.includes("pins no repository"),
      );

    const pinned = (definition: WorkflowDefinitionV2): WorkflowDefinitionV2 => ({
      ...definition,
      repositoryScope: { repositories: [{ provider: "github", repoPath: "acme/app" }] },
    });

    const scheduleToWorkspace = () =>
      graph(
        [scheduleTrigger(), node("prepare", "prepare_workspace")],
        [edge("schedule", "prepare")],
      );

    it("refuses a schedule graph that prepares a workspace with no pinned repository", () => {
      const issues = pinnedIssues(scheduleToWorkspace());

      expect(issues).toEqual([
        expect.objectContaining({
          code: "deployment",
          // The fix is the definition's pin, so the issue points at the pin the way
          // every other definition-wide issue does, not at a block's configuration.
          nodeId: null,
          path: "/repositoryScope",
          message: expect.stringContaining(
            'Block "prepare" (prepare_workspace) is reachable from schedule trigger "schedule"',
          ),
        }),
      ]);
      // The message has to say why, or an operator reads it as red tape and pins the
      // first repository in the list.
      expect(issues[0]?.message).toContain("carries no ticket");
      expect(issues[0]?.message).toContain("nowhere to report the failure");
    });

    it("catches a workspace several blocks downstream of the schedule", () => {
      expect(
        pinnedIssues(
          graph(
            [
              scheduleTrigger(),
              node("hop", "fetch_pr_context"),
              node("prepare", "prepare_workspace"),
            ],
            [edge("schedule", "hop"), edge("hop", "prepare")],
          ),
        ),
      ).toHaveLength(1);
    });

    it("accepts the same graph once the definition pins a repository", () => {
      expect(pinnedIssues(pinned(scheduleToWorkspace()))).toEqual([]);
    });

    // A provider list narrows a pin, it is not one: it names no repository, so the
    // agent is still guessing which one to work in.
    it("does not accept a pinned provider list as a repository pin", () => {
      expect(
        pinnedIssues({
          ...scheduleToWorkspace(),
          repositoryScope: { providers: ["github"] },
        }),
      ).toHaveLength(1);
    });

    // The rule is about the schedule's own path. A schedule that never touches a
    // repository has nothing to guess at, and a ticket graph brings its own routing.
    it("leaves a schedule that never prepares a workspace alone", () => {
      expect(
        pinnedIssues(
          graph(
            [scheduleTrigger(), node("done", "terminate", { terminalStatus: "done" })],
            [edge("schedule", "done")],
          ),
        ),
      ).toEqual([]);
    });

    it("leaves a workspace reachable only from a ticket trigger alone", () => {
      expect(
        pinnedIssues(
          graph(
            [node("ticket", "trigger_ticket_ai"), node("prepare", "prepare_workspace")],
            [edge("ticket", "prepare")],
          ),
        ),
      ).toEqual([]);
    });
  });
});

describe("stored definition reader", () => {
  it("returns malformed historical v1 content exactly as stored", () => {
    const stored = {
      schemaVersion: 1,
      nodes: [{ id: "  historical node  ", type: "removed_block", params: { broken: true } }],
      edges: [{ from: "", to: 42 }],
      unexpected: "kept for operator inspection",
    };

    const parsed = parseStoredWorkflowDefinition(stored);

    expect(parsed).toEqual({ schema: "legacy-v1", definition: stored });
    expect(parsed.definition).toBe(stored);
  });
});
