import { describe, expect, it } from "vitest";
import type {
  WorkflowBlockTypeV1,
  WorkflowDefinitionV1,
  WorkflowDefinitionV1Node,
} from "@shared/contracts";
import type { WorkflowBlockRegistryContext } from "./block-registry.js";
import {
  convertWorkflowDefinitionV1ToV2,
  deterministicV2ControlEdgeId,
  workflowV2PromptResolutionKey,
} from "./v2-converter.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-sonnet-4-5" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

function node(
  id: string,
  type: WorkflowBlockTypeV1,
  params: WorkflowDefinitionV1Node["params"] = {},
  inputs: WorkflowDefinitionV1Node["inputs"] = {},
): WorkflowDefinitionV1Node {
  return { id, type, x: 0, y: 0, params, inputs };
}

function convert(
  definition: WorkflowDefinitionV1,
  overrides: Partial<Parameters<typeof convertWorkflowDefinitionV1ToV2>[0]> = {},
) {
  return convertWorkflowDefinitionV1ToV2({
    sourceDefinitionId: 17,
    sourceVersion: 4,
    definition,
    registryContext,
    ...overrides,
  });
}

describe("convertWorkflowDefinitionV1ToV2", () => {
  it("pins migrated agents to the exact published profile and blocks incompatible model overrides", () => {
    const base: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("agent", "planning_agent", { provider: "codex" }),
      ],
      edges: [{ from: "trigger", to: "agent" }],
    };
    const harnessProfiles = {
      codex: {
        reference: { profileId: "builtin-codex", version: 7 },
        modelId: "gpt-5.4",
      },
    } as const;

    const converted = convert(base, { harnessProfiles });
    expect(converted.blockers).toEqual([]);
    expect(converted.definition?.nodes[1]?.configuration).toEqual({
      harnessProfile: { profileId: "builtin-codex", version: 7 },
    });
    expect(converted.conversions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.agent.profile_pinned",
          nodeId: "agent",
        }),
      ]),
    );

    const incompatible = structuredClone(base);
    incompatible.nodes[1]!.params.model = "gpt-custom";
    const blocked = convert(incompatible, { harnessProfiles });
    expect(blocked.definition).toBeNull();
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.agent.profile_model_override",
          nodeId: "agent",
          path: "/nodes/1/params/model",
        }),
      ]),
    );
  });

  it("converts nodes, canonical bindings, typed branch conditions, additional inputs, and stable edges", () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      budgets: { maxDurationMs: 60_000 },
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent", {}, { ticket: "trigger.ticket" }),
        node("checks", "run_checks"),
        node("decision", "branch", { condition: "steps.checks.output.ok == true" }),
        node(
          "finalize",
          "finalize_workspace",
          {},
          { "checks.checks": "steps.checks.output.status" },
        ),
        node("stop", "terminate", { terminalStatus: "failed" }),
      ],
      edges: [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "checks" },
        { from: "checks", to: "decision" },
        { from: "decision", to: "finalize", fromPort: "true" },
        { from: "decision", to: "stop", fromPort: "false" },
      ],
    };

    const result = convert(definition);

    expect(result.blockers).toEqual([]);
    expect(result.definition).toMatchObject({
      schemaVersion: 2,
      budgets: { maxDurationMs: 60_000 },
      nodes: [
        { id: "trigger", configuration: {}, inputs: {}, additionalInputs: [] },
        {
          id: "planning",
          configuration: {},
          inputs: {
            ticket: {
              kind: "reference",
              reference: "steps.entry.output.ticket",
            },
          },
          additionalInputs: [],
        },
        { id: "checks", configuration: {}, inputs: {}, additionalInputs: [] },
        {
          id: "decision",
          configuration: {
            condition: {
              kind: "eq",
              left: {
                kind: "path",
                reference: "steps.checks.output.ok",
              },
              right: { kind: "lit", value: true },
            },
          },
        },
        {
          id: "finalize",
          inputs: {},
          additionalInputs: [
            {
              name: "checks.checks",
              schema: { type: "string" },
              binding: {
                kind: "reference",
                reference: "steps.checks.output.status",
              },
            },
          ],
        },
        {
          id: "stop",
          configuration: { terminalStatus: "failed" },
          inputs: {},
          additionalInputs: [],
        },
      ],
    });
    expect(result.definition?.edges[0]).toEqual({
      id: deterministicV2ControlEdgeId({
        sourceDefinitionId: 17,
        sourceVersion: 4,
        edgeIndex: 0,
        from: "trigger",
        to: "planning",
      }),
      from: "trigger",
      to: "planning",
    });
    expect(result.conversions.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "migration.binding.canonicalized",
        "migration.branch.condition_parsed",
        "migration.input.additional_materialized",
        "migration.edge.id_assigned",
      ]),
    );
    expect(result.conversionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is byte-deterministic and incorporates exact source identity into ids and hash", () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("finish", "terminate", { terminalStatus: "done" }),
      ],
      edges: [{ from: "trigger", to: "finish" }],
    };

    const first = convert(definition);
    const second = convert(structuredClone(definition));
    const otherVersion = convert(definition, { sourceVersion: 5 });

    expect(second).toEqual(first);
    expect(otherVersion.definition?.edges[0]?.id).not.toBe(
      first.definition?.edges[0]?.id,
    );
    expect(otherVersion.conversionHash).not.toBe(first.conversionHash);
  });

  it("pins reusable prompts and converts only provably available legacy prompt variables", () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("llm", "call_llm", {
          prompt:
            "Plan {{ ticket_title }} on {{branch_name}} using {{prompt:research-plan}}",
        }),
      ],
      edges: [{ from: "trigger", to: "llm" }],
    };
    const promptResolutions = new Map([
      [
        workflowV2PromptResolutionKey({
          slug: "research-plan",
          version: "latest",
        }),
        {
          slug: "research-plan",
          requestedVersion: "latest" as const,
          resolvedVersion: 7,
        },
      ],
    ]);

    const result = convert(definition, { promptResolutions });

    expect(result.blockers).toEqual([]);
    expect(result.definition?.nodes[1]?.configuration.prompt).toBe(
      "Plan {{data:steps.entry.output.ticket.title}} on {{data:run.branchName}} using {{prompt:research-plan@7}}",
    );
    expect(result.conversions.filter(({ code }) => code.includes("prompt"))).toHaveLength(3);
  });

  it("validates canonical prompt data tokens and proves run paths against the run schema", () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        node("planning", "planning_agent"),
        node("llm", "call_llm", {
          prompt: [
            "{{data:run.id}}",
            "{{ data:run.branchName }}",
            "{{data:run.missing}}",
            "{{data:run.}}",
            "{{data:run.__proto__}}",
            "{{data:steps.planning.output.plan}}",
            "{{data:steps.planning.output.missing}}",
          ].join(" "),
        }),
      ],
      edges: [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "llm" },
      ],
    };

    const result = convert(definition);

    expect(result.definition).toBeNull();
    expect(result.conversionHash).toBeNull();
    expect(
      result.blockers.filter(({ code }) => code.startsWith("migration.prompt.")),
    ).toHaveLength(4);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.prompt.invalid_data_reference",
          message: expect.stringContaining("{{data:run.}}"),
        }),
        expect.objectContaining({
          code: "migration.prompt.invalid_data_reference",
          message: expect.stringContaining("{{data:run.__proto__}}"),
        }),
        expect.objectContaining({
          code: "migration.prompt.unavailable_data_reference",
          message: expect.stringContaining("{{data:run.missing}}"),
        }),
        expect.objectContaining({
          code: "migration.prompt.unavailable_data_reference",
          message: expect.stringContaining(
            "{{data:steps.planning.output.missing}}",
          ),
        }),
      ]),
    );
    expect(result.conversions).toContainEqual(
      expect.objectContaining({
        code: "migration.prompt.data_reference_canonicalized",
        message: expect.stringContaining("{{ data:run.branchName }}"),
      }),
    );
  });

  it("reports every blocker and never returns a partially converted definition", () => {
    const badBranch = node("branch", "branch", {
      condition: "steps.missing.output.ok === true",
      hiddenMode: "legacy",
    });
    const definition = {
      schemaVersion: 1,
      nodes: [
        node("entry", "trigger_ticket_ai"),
        node(
          "llm",
          "call_llm",
          { prompt: "{{ticket_url}} {{unknown_variable}}" },
          { prompt: "steps.missing.output.text" },
        ),
        badBranch,
      ],
      edges: [
        { from: "entry", to: "llm", fromPort: "failed" },
        { from: "llm", to: "branch" },
      ],
    } as WorkflowDefinitionV1;

    const result = convert(definition);
    const codes = result.blockers.map(({ code }) => code);

    expect(result.definition).toBeNull();
    expect(result.conversionHash).toBeNull();
    expect(codes).toEqual(
      expect.arrayContaining([
        "migration.node.reserved_id",
        "migration.node.unknown_parameter",
        "migration.edge.failure_port",
        "migration.binding.unprovable",
        "migration.branch.unparseable_condition",
        "migration.prompt.unsafe_variable",
        "migration.prompt.unresolved_placeholder",
      ]),
    );
  });

  it("never reports blocker-free success for an invalid converted target", () => {
    const result = convert({
      schemaVersion: 1,
      nodes: [
        node("orphan", "post_ticket_comment", {
          body: "This source has no trigger.",
        }),
      ],
      edges: [],
    });

    expect(result.definition).toBeNull();
    expect(result.conversionHash).toBeNull();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "migration.target.deployment",
          path: "/nodes",
        }),
        expect.objectContaining({
          code: "migration.target.deployment",
          nodeId: "orphan",
        }),
      ]),
    );
  });

  it("blocks an unpinned prompt reference and reports copied-prompt metadata explicitly", () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      nodes: [
        node("trigger", "trigger_ticket_ai"),
        {
          ...node("llm", "call_llm", { prompt: "{{prompt:missing}}" }),
          promptRefs: { prompt: { promptId: 2, version: 1 } },
        },
      ],
      edges: [{ from: "trigger", to: "llm" }],
    };

    const result = convert(definition);

    expect(result.definition).toBeNull();
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "migration.prompt.unresolved_reference" }),
      ]),
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "migration.prompt.provenance_removed" }),
    ]);
  });
});
