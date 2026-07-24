import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowAvailableValue,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2Node,
  WorkflowInputBindingV2,
} from "@shared/contracts";
import {
  analyzeWorkflowV2Catalog,
  analyzeWorkflowV2Bindings,
} from "./available-values.js";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

function node(
  id: string,
  type: WorkflowBlockType,
  inputBindings: Record<string, WorkflowInputBindingV2> = {},
): WorkflowDefinitionV2Node {
  return {
    id,
    type,
    x: 0,
    y: 0,
    configuration: {},
    inputs: inputBindings,
    additionalInputs: [],
  };
}

function definition(
  nodes: WorkflowDefinitionV2Node[],
  edges: Array<{
    id: string;
    from: string;
    to: string;
    fromPort?: string;
  }>,
): WorkflowDefinitionV2 {
  return { schemaVersion: 2, nodes, edges };
}

function references(
  result: ReturnType<typeof analyzeWorkflowV2Bindings>,
  consumerId: string,
): string[] {
  return result.availableValuesByNode[consumerId]?.map((value) => value.reference) ?? [];
}

function catalogValue(
  result: ReturnType<typeof analyzeWorkflowV2Bindings>,
  consumerId: string,
  reference: string,
): WorkflowAvailableValue {
  const value = result.availableValuesByNode[consumerId]?.find(
    (candidate) => candidate.reference === reference,
  );
  expect(value, `missing ${reference}`).toBeDefined();
  return value!;
}

describe("v2 available values", () => {
  it("includes every unconditional fan-out producer at a fan-in join", () => {
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("plan", "planning_agent"),
          node("workspace", "prepare_workspace"),
          node("join", "post_ticket_comment"),
        ],
        [
          { id: "split-plan", from: "trigger", to: "plan" },
          { id: "split-workspace", from: "trigger", to: "workspace" },
          { id: "join-plan", from: "plan", to: "join" },
          { id: "join-workspace", from: "workspace", to: "join" },
        ],
      ),
      registryContext,
    );

    expect(references(result, "join")).toEqual(
      expect.arrayContaining([
        "steps.plan.output.plan",
        "steps.workspace.output.sandboxId",
      ]),
    );
    expect(catalogValue(result, "join", "steps.plan.output.plan")).toMatchObject({
      source: { kind: "step", nodeId: "plan", blockType: "planning_agent" },
      guarantee: {
        kind: "join",
        triggerNodeIds: ["trigger"],
        viaEdgeIds: ["join-plan"],
      },
      schema: { type: "string" },
      compatibleInputNames: ["body"],
    });
  });

  it("excludes values produced on only one conditional branch", () => {
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("decision", "branch"),
          node("plan", "planning_agent"),
          node("workspace", "prepare_workspace"),
          node("join", "post_ticket_comment"),
        ],
        [
          { id: "to-decision", from: "trigger", to: "decision" },
          { id: "true-plan", from: "decision", fromPort: "true", to: "plan" },
          { id: "false-workspace", from: "decision", fromPort: "false", to: "workspace" },
          { id: "plan-join", from: "plan", to: "join" },
          { id: "workspace-join", from: "workspace", to: "join" },
        ],
      ),
      registryContext,
    );

    expect(references(result, "join")).not.toContain("steps.plan.output.plan");
    expect(references(result, "join")).not.toContain(
      "steps.workspace.output.sandboxId",
    );
    expect(references(result, "join")).toContain("steps.entry.output.ticketKey");
    expect(references(result, "join")).toContain("run.id");
  });

  it("intersects active trigger contracts behind the virtual entry source", () => {
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("ticket-trigger", "trigger_ticket_ai"),
          node("approval-trigger", "trigger_plan_approved"),
          node("consumer", "post_ticket_comment"),
        ],
        [
          { id: "ticket-path", from: "ticket-trigger", to: "consumer" },
          { id: "approval-path", from: "approval-trigger", to: "consumer" },
        ],
      ),
      registryContext,
    );

    const entry = catalogValue(
      result,
      "consumer",
      "steps.entry.output.ticketKey",
    );
    expect(entry.guarantee).toEqual({
      kind: "active_entry",
      triggerNodeIds: ["approval-trigger", "ticket-trigger"],
      viaEdgeIds: [],
    });
    expect(references(result, "consumer")).not.toContain(
      "steps.entry.output.approvedPlan",
    );
  });

  it("requires a causal path even when producer and consumer activation match", () => {
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("unrelated", "planning_agent"),
          node("consumer", "post_ticket_comment"),
        ],
        [
          { id: "to-unrelated", from: "trigger", to: "unrelated" },
          { id: "to-consumer", from: "trigger", to: "consumer" },
        ],
      ),
      registryContext,
    );

    expect(references(result, "consumer")).not.toContain(
      "steps.unrelated.output.plan",
    );
  });

  it("conservatively excludes outputs produced inside a loop SCC", () => {
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("loop", "loop"),
          node("inside", "planning_agent"),
          node("after", "post_ticket_comment"),
        ],
        [
          { id: "to-loop", from: "trigger", to: "loop" },
          { id: "loop-continue", from: "loop", fromPort: "continue", to: "inside" },
          { id: "inside-back", from: "inside", to: "loop" },
          { id: "loop-exhausted", from: "loop", fromPort: "exhausted", to: "after" },
        ],
      ),
      registryContext,
    );

    expect(references(result, "after")).not.toContain("steps.inside.output.plan");
    expect(references(result, "after")).toContain("steps.entry.output.ticketKey");
    expect(references(result, "after")).toContain("run.branchName");
  });

  it("derives downstream Transform output paths from its declared input schemas", () => {
    const transform = node("shape", "transform");
    transform.configuration = {
      operation: "map_object",
      fields: [
        {
          name: "title",
          value: {
            kind: "input",
            source: { input: "plan", path: [] },
          },
        },
      ],
    };
    transform.additionalInputs = [
      {
        name: "plan",
        schema: { type: "string" },
        binding: {
          kind: "reference",
          reference: "steps.plan.output.plan",
        },
      },
    ];
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("plan", "planning_agent"),
          transform,
          node("consumer", "post_ticket_comment"),
        ],
        [
          { id: "to-plan", from: "trigger", to: "plan" },
          { id: "to-transform", from: "plan", to: "shape" },
          { id: "to-consumer", from: "shape", to: "consumer" },
        ],
      ),
      registryContext,
    );

    expect(references(result, "consumer")).toEqual(
      expect.arrayContaining([
        "steps.shape.output.output",
        "steps.shape.output.output.title",
      ]),
    );
    expect(
      catalogValue(
        result,
        "consumer",
        "steps.shape.output.output.title",
      ).schema,
    ).toEqual({ type: "string" });
  });
});

describe("v2 authoring catalog", () => {
  it("includes whole outputs and marks conditional producers unavailable", () => {
    const result = analyzeWorkflowV2Catalog(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("decision", "branch"),
          node("plan", "planning_agent"),
          node("consumer", "post_ticket_comment"),
        ],
        [
          { id: "to-decision", from: "trigger", to: "decision" },
          { id: "true-plan", from: "decision", fromPort: "true", to: "plan" },
          { id: "false-consumer", from: "decision", fromPort: "false", to: "consumer" },
          { id: "plan-consumer", from: "plan", to: "consumer" },
        ],
      ),
      registryContext,
    );
    const catalog = result.catalogByNode.consumer ?? [];

    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: "steps.entry.output",
          source: { kind: "trigger", nodeId: "trigger" },
          availability: expect.objectContaining({ state: "available" }),
        }),
        expect.objectContaining({
          reference: "steps.plan.output",
          source: { kind: "step", nodeId: "plan" },
          availability: expect.objectContaining({ state: "unavailable" }),
        }),
      ]),
    );
  });

  it("describes common and trigger-specific values for multiple triggers", () => {
    const result = analyzeWorkflowV2Catalog(
      definition(
        [
          node("ticket", "trigger_ticket_ai"),
          node("approval", "trigger_plan_approved"),
          node("consumer", "post_ticket_comment"),
        ],
        [
          { id: "ticket-consumer", from: "ticket", to: "consumer" },
          { id: "approval-consumer", from: "approval", to: "consumer" },
        ],
      ),
      registryContext,
    );
    const catalog = result.catalogByNode.consumer ?? [];
    const common = catalog.find(
      (entry) => entry.reference === "steps.entry.output.ticketKey",
    );
    const triggerSpecific = catalog.find(
      (entry) => entry.reference === "steps.entry.output.approvedPlan",
    );

    expect(common).toMatchObject({
      label: "Trigger that started this run · ticketKey",
      availability: { state: "available" },
    });
    expect(triggerSpecific).toMatchObject({
      availability: { state: "unavailable" },
    });
    expect(
      triggerSpecific?.availability.state === "unavailable"
        ? triggerSpecific.availability.reason
        : "",
    ).toContain("Trigger ID or Trigger type");
  });

  it("publishes friendly typed run trigger enums", () => {
    const result = analyzeWorkflowV2Catalog(
      definition(
        [
          node("ticket", "trigger_ticket_ai"),
          node("approval", "trigger_plan_approved"),
          node("consumer", "post_ticket_comment"),
        ],
        [
          { id: "ticket-consumer", from: "ticket", to: "consumer" },
          { id: "approval-consumer", from: "approval", to: "consumer" },
        ],
      ),
      registryContext,
    );
    const catalog = result.catalogByNode.consumer ?? [];

    expect(
      catalog.find((entry) => entry.reference === "run.trigger.id")?.schema,
    ).toMatchObject({ type: "string", enum: ["ticket", "approval"] });
    expect(
      catalog.find((entry) => entry.reference === "run.trigger.type")?.schema,
    ).toMatchObject({
      type: "string",
      enum: ["trigger_ticket_ai", "trigger_plan_approved"],
    });
  });
});

describe("v2 binding validation", () => {
  it("accepts a guaranteed compatible reference and rejects a conditional one", () => {
    const valid = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("plan", "planning_agent"),
          node("consumer", "post_ticket_comment", {
            body: {
              kind: "reference",
              reference: "steps.plan.output.plan",
            },
          }),
        ],
        [
          { id: "to-plan", from: "trigger", to: "plan" },
          { id: "to-consumer", from: "plan", to: "consumer" },
        ],
      ),
      registryContext,
    );
    expect(valid.issues).toEqual([]);

    const unavailable = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("decision", "branch"),
          node("plan", "planning_agent"),
          node("consumer", "post_ticket_comment", {
            body: {
              kind: "reference",
              reference: "steps.plan.output.plan",
            },
          }),
        ],
        [
          { id: "to-decision", from: "trigger", to: "decision" },
          { id: "true-plan", from: "decision", fromPort: "true", to: "plan" },
          { id: "false-consumer", from: "decision", fromPort: "false", to: "consumer" },
          { id: "plan-consumer", from: "plan", to: "consumer" },
        ],
      ),
      registryContext,
    );
    expect(unavailable.issues).toEqual([
      expect.objectContaining({
        code: "binding.unavailable_reference",
        nodeId: "consumer",
        path: "/nodes/3/inputs/body/reference",
      }),
    ]);
  });

  it("validates fixed and author-defined literals against canonical schemas", () => {
    const consumer = node("consumer", "post_ticket_comment", {
      body: { kind: "literal", value: 42 },
    });
    consumer.additionalInputs = [
      {
        name: "score",
        schema: { type: "number" },
        binding: { kind: "literal", value: "wrong" },
      },
    ];
    const result = analyzeWorkflowV2Bindings(
      definition(
        [node("trigger", "trigger_ticket_ai"), consumer],
        [{ id: "edge", from: "trigger", to: "consumer" }],
      ),
      registryContext,
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "binding.literal_type",
          path: "/nodes/1/inputs/body/value",
        }),
        expect.objectContaining({
          code: "binding.literal_type",
          path: "/nodes/1/additionalInputs/0/binding/value",
        }),
      ]),
    );
  });

  it("requires Open PR repositories to come from the exact guaranteed Finalize output", () => {
    const exact = definition(
      [
        node("trigger", "trigger_ticket_ai"),
        node("finalize", "finalize_workspace"),
        node("open", "open_pr", {
          repositories: {
            kind: "reference",
            reference: "steps.finalize.output.repositories",
          },
        }),
      ],
      [
        { id: "trigger-finalize", from: "trigger", to: "finalize" },
        { id: "finalize-open", from: "finalize", to: "open" },
      ],
    );
    expect(
      analyzeWorkflowV2Bindings(exact, registryContext).issues.filter(
        (issue) => issue.code === "binding.open_pr_finalize",
      ),
    ).toEqual([]);

    const literal = structuredClone(exact);
    literal.nodes.find((candidate) => candidate.id === "open")!.inputs = {
      repositories: {
        kind: "literal",
        value: [
          {
            provider: "github",
            repoPath: "acme/app",
            branch: "forged",
            defaultBranch: "main",
            expectedHead: "before",
            pushedHead: "after",
          },
        ],
      },
    };
    expect(
      analyzeWorkflowV2Bindings(literal, registryContext).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "binding.open_pr_finalize" }),
      ]),
    );

    const wrongField = structuredClone(exact);
    wrongField.nodes.find((candidate) => candidate.id === "open")!.inputs = {
      repositories: {
        kind: "reference",
        reference: "steps.finalize.output.status",
      },
    };
    expect(
      analyzeWorkflowV2Bindings(wrongField, registryContext).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "binding.open_pr_finalize" }),
      ]),
    );
  });

  it("reports incompatible references and preserves per-target compatibility", () => {
    const consumer = node("consumer", "post_ticket_comment");
    consumer.additionalInputs = [
      {
        name: "score",
        schema: { type: "number" },
        binding: {
          kind: "reference",
          reference: "steps.plan.output.plan",
        },
      },
    ];
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("plan", "planning_agent"),
          consumer,
        ],
        [
          { id: "to-plan", from: "trigger", to: "plan" },
          { id: "to-consumer", from: "plan", to: "consumer" },
        ],
      ),
      registryContext,
    );

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "binding.reference_type",
        path: "/nodes/2/additionalInputs/0/binding/reference",
      }),
    ]);
    expect(
      catalogValue(result, "consumer", "steps.plan.output.plan")
        .compatibleInputNames,
    ).toEqual(["body"]);
  });

  it("accepts safe dotted additional input names used by existing contracts", () => {
    const finalize = node("finalize", "finalize_workspace");
    finalize.additionalInputs = [
      {
        name: "checks.lint",
        schema: { type: "string" },
        binding: {
          kind: "reference",
          reference: "steps.checks.output.status",
        },
      },
    ];
    const result = analyzeWorkflowV2Bindings(
      definition(
        [
          node("trigger", "trigger_ticket_ai"),
          node("checks", "run_checks"),
          finalize,
        ],
        [
          { id: "to-checks", from: "trigger", to: "checks" },
          { id: "to-finalize", from: "checks", to: "finalize" },
        ],
      ),
      registryContext,
    );

    expect(result.issues).toEqual([]);
    expect(
      catalogValue(result, "finalize", "steps.checks.output.status")
        .compatibleInputNames,
    ).toContain("checks.lint");
  });
});
