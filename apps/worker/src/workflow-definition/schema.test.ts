import { describe, expect, it } from "vitest";
import type {
  JsonValue,
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowDefinition,
  WorkflowDefinitionV1,
  WorkflowDefinitionV2,
  WorkflowDefinitionV2ControlEdge,
  WorkflowDefinitionV2Node,
  WorkflowDefinitionEdge,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { isV2OnlyBlockType } from "@shared/contracts";
import { defaultWorkflowDefinition } from "./default.js";
import {
  humanGateLoopDefinition,
  linearPipelineDefinition,
  planApprovalDefinition,
  prReviewFixDefinition,
} from "./graph-fixtures.js";
import { workflowDefinitionTemplates } from "./templates.js";
import {
  ANY_SCOPE_BLOCK_POLICY,
  upgradeStoredWorkflowDefinition,
  validateWorkflowDefinitionForDeployment,
  validateWorkflowDefinitionIssuesForDeployment,
  validateWorkflowGraph,
  workflowDefinitionV2Schema,
  workflowDefinitionV1Schema as workflowDefinitionSchema,
} from "./schema.js";
import { BLOCK_TYPE_SPECS } from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

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

function node(
  id: string,
  type: WorkflowBlockTypeV1,
  params: Record<string, WorkflowParamValue> = {},
  inputs: WorkflowDefinitionNode["inputs"] = {},
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs };
}

function graph(
  nodes: WorkflowDefinitionNode[],
  edges: WorkflowDefinitionEdge[],
): WorkflowDefinitionV1 {
  return { schemaVersion: 1, nodes, edges };
}

function clone(def: WorkflowDefinition): any {
  return JSON.parse(JSON.stringify(def));
}

function shapeOk(nodes: unknown[], edges: unknown[] = []): boolean {
  return workflowDefinitionSchema.safeParse({ schemaVersion: 1, nodes, edges }).success;
}

describe("workflowDefinitionSchema", () => {
  it("accepts omitted and partial execution budgets", () => {
    const omitted = workflowDefinitionSchema.parse({ schemaVersion: 1, nodes: [], edges: [] });
    expect(omitted).toEqual({ schemaVersion: 1, nodes: [], edges: [] });

    const partial = workflowDefinitionSchema.parse({
      schemaVersion: 1,
      budgets: { maxTokens: 12_345 },
      nodes: [],
      edges: [],
    });
    expect(partial.budgets).toEqual({ maxTokens: 12_345 });
  });

  it.each([
    { maxDurationMs: 0 },
    { maxDurationMs: -1 },
    { maxDurationMs: 1.5 },
    { maxTokens: 0 },
    { maxTokens: -1 },
    { maxTokens: 1.5 },
    { maxCostUsd: 0 },
    { maxCostUsd: -1 },
    { maxCostUsd: Number.POSITIVE_INFINITY },
    { unexpected: 1 },
  ])("rejects invalid execution budgets %#", (budgets) => {
    expect(
      workflowDefinitionSchema.safeParse({ schemaVersion: 1, budgets, nodes: [], edges: [] }).success,
    ).toBe(false);
  });

  it("preserves execution budgets while upgrading a stored definition", () => {
    expect(
      upgradeStoredWorkflowDefinition({
        schemaVersion: 1,
        budgets: { maxDurationMs: 30_000, maxTokens: 8_000, maxCostUsd: 1.25 },
        nodes: [],
        edges: [],
      }).budgets,
    ).toEqual({ maxDurationMs: 30_000, maxTokens: 8_000, maxCostUsd: 1.25 });
  });

  it("round-trips a pinned repository scope through the v1 schema", () => {
    const repositoryScope = {
      repositories: [
        { provider: "github" as const, repoPath: "acme/web" },
        { provider: "gitlab" as const, repoPath: "acme/group/subgroup/api" },
      ],
      providers: ["github" as const, "gitlab" as const],
    };

    expect(
      workflowDefinitionSchema.parse({
        schemaVersion: 1,
        repositoryScope,
        nodes: [],
        edges: [],
      }).repositoryScope,
    ).toEqual(repositoryScope);
  });

  it("treats an omitted repository scope as today's behavior", () => {
    expect(
      workflowDefinitionSchema.parse({ schemaVersion: 1, nodes: [], edges: [] }),
    ).toEqual({ schemaVersion: 1, nodes: [], edges: [] });
  });

  it("accepts each repository scope sub-field on its own", () => {
    expect(
      workflowDefinitionSchema.parse({
        schemaVersion: 1,
        repositoryScope: { repositories: [{ provider: "github", repoPath: "acme/web" }] },
        nodes: [],
        edges: [],
      }).repositoryScope,
    ).toEqual({ repositories: [{ provider: "github", repoPath: "acme/web" }] });

    expect(
      workflowDefinitionSchema.parse({
        schemaVersion: 1,
        repositoryScope: { providers: ["gitlab"] },
        nodes: [],
        edges: [],
      }).repositoryScope,
    ).toEqual({ providers: ["gitlab"] });
  });

  // filterPinnedRepositories in adapters/vcs/repository-directory.ts restricts a
  // listing only when repositories or providers is non-empty, so every scope this
  // schema accepts as "no pin" has to reach it carrying neither. Pinned here so a
  // schema change cannot turn an empty pin into one that matches nothing.
  it("admits exactly three no-pin spellings, none of them carrying a restriction", () => {
    const parseScope = (repositoryScope?: unknown) =>
      workflowDefinitionSchema.parse({
        schemaVersion: 1,
        ...(repositoryScope === undefined ? {} : { repositoryScope }),
        nodes: [],
        edges: [],
      }).repositoryScope;

    for (const scope of [parseScope(), parseScope({}), parseScope({ repositories: [] })]) {
      expect(scope?.repositories?.length ?? 0).toBe(0);
      expect(scope?.providers?.length ?? 0).toBe(0);
    }

    expect(parseScope()).toBeUndefined();
    expect(parseScope({})).toEqual({});
    expect(parseScope({ repositories: [] })).toEqual({ repositories: [] });

    expect(
      workflowDefinitionSchema.safeParse({
        schemaVersion: 1,
        repositoryScope: { providers: [] },
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("caps repoPath length at 200 characters", () => {
    const pathOfLength = (length: number) => `acme/${"r".repeat(length - "acme/".length)}`;
    const parseRepoPath = (repoPath: string) =>
      workflowDefinitionSchema.safeParse({
        schemaVersion: 1,
        repositoryScope: { repositories: [{ provider: "github", repoPath }] },
        nodes: [],
        edges: [],
      }).success;

    expect(pathOfLength(200)).toHaveLength(200);
    expect(parseRepoPath(pathOfLength(200))).toBe(true);
    expect(parseRepoPath(pathOfLength(201))).toBe(false);
  });

  it("stores a padded repoPath trimmed", () => {
    expect(
      workflowDefinitionSchema.parse({
        schemaVersion: 1,
        repositoryScope: { repositories: [{ provider: "github", repoPath: "  acme/web  " }] },
        nodes: [],
        edges: [],
      }).repositoryScope?.repositories,
    ).toEqual([{ provider: "github", repoPath: "acme/web" }]);
  });

  it("preserves the repoPath case the operator picked", () => {
    expect(
      workflowDefinitionSchema.parse({
        schemaVersion: 1,
        repositoryScope: { repositories: [{ provider: "github", repoPath: "Acme/Web" }] },
        nodes: [],
        edges: [],
      }).repositoryScope?.repositories,
    ).toEqual([{ provider: "github", repoPath: "Acme/Web" }]);
  });

  it("accepts exactly eight pinned repositories and rejects a ninth", () => {
    const pin = (count: number) => ({
      schemaVersion: 1,
      repositoryScope: {
        repositories: Array.from({ length: count }, (_unused, index) => ({
          provider: "github" as const,
          repoPath: `acme/repo-${index}`,
        })),
      },
      nodes: [],
      edges: [],
    });

    expect(workflowDefinitionSchema.safeParse(pin(8)).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(pin(9)).success).toBe(false);
  });

  it("rejects duplicate pinned repositories case-insensitively but keeps the same path on two providers", () => {
    const withRepositories = (
      repositories: Array<{ provider: "github" | "gitlab"; repoPath: string }>,
    ) =>
      workflowDefinitionSchema.safeParse({
        schemaVersion: 1,
        repositoryScope: { repositories },
        nodes: [],
        edges: [],
      }).success;

    expect(
      withRepositories([
        { provider: "github", repoPath: "acme/web" },
        { provider: "github", repoPath: "acme/web" },
      ]),
    ).toBe(false);
    expect(
      withRepositories([
        { provider: "github", repoPath: "acme/web" },
        { provider: "github", repoPath: "Acme/Web" },
      ]),
    ).toBe(false);
    expect(
      withRepositories([
        { provider: "github", repoPath: "acme/web" },
        { provider: "gitlab", repoPath: "acme/web" },
      ]),
    ).toBe(true);
  });

  it.each([
    { repositories: [{ provider: "github", repoPath: "acme" }] },
    { repositories: [{ provider: "github", repoPath: "" }] },
    { repositories: [{ provider: "github", repoPath: "acme/" }] },
    { repositories: [{ provider: "github", repoPath: "/web" }] },
    { repositories: [{ provider: "github", repoPath: "acme/we b" }] },
    { repositories: [{ provider: "svn", repoPath: "acme/web" }] },
    { repositories: [{ provider: "github", repoPath: "acme/web", extra: 1 }] },
    { repositories: [{ repoPath: "acme/web" }] },
    { providers: [] },
    { providers: ["svn"] },
    { unexpected: 1 },
  ])("rejects an invalid repository scope %#", (repositoryScope) => {
    expect(
      workflowDefinitionSchema.safeParse({
        schemaVersion: 1,
        repositoryScope,
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown sibling of repositoryScope at the definition root", () => {
    expect(
      workflowDefinitionSchema.safeParse({
        schemaVersion: 1,
        repositoryScope: { providers: ["github"] },
        repositoryPin: { providers: ["github"] },
        nodes: [],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it("preserves a pinned repository scope while upgrading a stored definition", () => {
    expect(
      upgradeStoredWorkflowDefinition({
        schemaVersion: 1,
        repositoryScope: {
          repositories: [{ provider: "gitlab", repoPath: "acme/group/api" }],
          providers: ["gitlab"],
        },
        nodes: [],
        edges: [],
      }).repositoryScope,
    ).toEqual({
      repositories: [{ provider: "gitlab", repoPath: "acme/group/api" }],
      providers: ["gitlab"],
    });
  });

  it("leaves repositoryScope absent when upgrading a stored definition that lacks it", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      budgets: { maxTokens: 100 },
      nodes: [],
      edges: [],
    });

    expect(upgraded.repositoryScope).toBeUndefined();
    expect("repositoryScope" in upgraded).toBe(false);
  });

  it("removes retired arthur_trace and splices only its normal output", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "branch", type: "branch", x: 0, y: 0, params: { condition: "true" } },
        { id: "trace", type: "arthur_trace", x: 1, y: 0, params: {} },
        { id: "next", type: "open_pr", x: 2, y: 0, params: {} },
        { id: "impossible", type: "terminate", x: 2, y: 1, params: { terminalStatus: "failed" } },
      ],
      edges: [
        { from: "branch", to: "trace", fromPort: "false" },
        { from: "trace", to: "next", fromPort: "out" },
        { from: "trace", to: "impossible", fromPort: "failed" },
      ],
    });

    expect(upgraded.nodes.map((node) => node.type)).toEqual([
      "branch",
      "finalize_workspace",
      "open_pr",
      "terminate",
    ]);
    expect(upgraded.nodes.every((node) => Object.hasOwn(node, "inputs"))).toBe(true);
    expect(upgraded.edges).toEqual([
      { from: "branch", to: "next-finalize", fromPort: "false" },
      { from: "next-finalize", to: "next" },
    ]);
  });

  it("still rejects truly unknown stored block types", () => {
    expect(() =>
      upgradeStoredWorkflowDefinition({
        schemaVersion: 1,
        nodes: [{ id: "unknown", type: "retired_elsewhere", x: 0, y: 0, params: {} }],
        edges: [],
      }),
    ).toThrow(/Unknown workflow block type/);
  });

  it("preserves exact input binding source paths and defaults legacy nodes to no bindings", () => {
    const parsed = workflowDefinitionSchema.parse({
      schemaVersion: 1,
      nodes: [
        {
          id: "llm",
          type: "call_llm",
          x: 0,
          y: 0,
          params: { prompt: "summarize" },
          inputs: {
            prompt: "steps.plan.output.plan",
            context: "trigger.ticket.description",
            runId: "run.id",
          },
        },
        { id: "legacy", type: "open_pr", x: 0, y: 0, params: {} },
      ],
      edges: [],
    });

    expect(parsed.nodes[0].inputs).toEqual({
      prompt: "steps.plan.output.plan",
      context: "trigger.ticket.description",
      runId: "run.id",
    });
    expect(parsed.nodes[1].inputs).toEqual({});
  });

  it("upgrades the legacy combined Open PR block into Finalize followed by bound Open PR", () => {
    const legacyDefault = {
      schemaVersion: 1 as const,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "planning", type: "planning_agent", x: 1, y: 0, params: {} },
        { id: "implementation", type: "implementation_agent", x: 2, y: 0, params: {} },
        { id: "checks", type: "run_pre_pr_checks", x: 3, y: 0, params: {} },
        { id: "open-pr", type: "open_pr", x: 4, y: 0, params: {} },
        { id: "slack", type: "send_slack_message", x: 5, y: 0, params: {} },
        {
          id: "status",
          type: "update_ticket_status",
          x: 6,
          y: 0,
          params: { target: "ai_review" },
        },
      ],
      edges: [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
        { from: "implementation", to: "checks" },
        { from: "checks", to: "open-pr" },
        { from: "open-pr", to: "slack" },
        { from: "slack", to: "status" },
      ],
    };

    const upgraded = upgradeStoredWorkflowDefinition(legacyDefault);

    expect(upgraded.nodes.map((entry) => entry.id)).toEqual([
      "trigger",
      "planning",
      "implementation",
      "checks",
      "open-pr-finalize",
      "open-pr",
      "slack",
      "status",
    ]);
    expect(upgraded.nodes.find((entry) => entry.id === "open-pr-finalize")).toMatchObject({
      type: "finalize_workspace",
      params: {},
      inputs: {},
    });
    expect(upgraded.nodes.find((entry) => entry.id === "open-pr")?.inputs).toEqual({
      repositories: "steps.open-pr-finalize.output.repositories",
    });
    expect(upgraded.edges).toEqual([
      { from: "trigger", to: "planning" },
      { from: "planning", to: "implementation" },
      { from: "implementation", to: "checks" },
      { from: "checks", to: "open-pr-finalize" },
      { from: "open-pr", to: "slack" },
      { from: "slack", to: "status" },
      { from: "open-pr-finalize", to: "open-pr" },
    ]);
    expect(validateWorkflowDefinitionForDeployment(upgraded, registryContext)).toEqual([]);
    expect(upgradeStoredWorkflowDefinition(upgraded)).toEqual(upgraded);
  });

  it("chooses a deterministic unused Finalize id and preserves current definitions", () => {
    const collision = {
      schemaVersion: 1 as const,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "open-pr-finalize", type: "run_checks", x: 1, y: 0, params: {} },
        { id: "open-pr", type: "open_pr", x: 2, y: 0, params: {} },
      ],
      edges: [
        { from: "trigger", to: "open-pr-finalize" },
        { from: "open-pr-finalize", to: "open-pr" },
      ],
    };

    const upgraded = upgradeStoredWorkflowDefinition(collision);
    expect(upgraded.nodes.map((entry) => entry.id)).toEqual([
      "trigger",
      "open-pr-finalize",
      "open-pr-finalize-2",
      "open-pr",
    ]);
    expect(upgraded.nodes.find((entry) => entry.id === "open-pr")?.inputs).toEqual({
      repositories: "steps.open-pr-finalize-2.output.repositories",
    });
    expect(upgradeStoredWorkflowDefinition(upgraded)).toEqual(upgraded);

    const current = defaultWorkflowDefinition({ includeReview: true });
    expect(upgradeStoredWorkflowDefinition(current)).toEqual(current);
  });

  it("upgrades legacy Generic Agent blocks to read_write without changing explicit modes", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "legacy", type: "generic_agent", x: 0, y: 0, params: { prompt: "edit" } },
        {
          id: "new",
          type: "generic_agent",
          x: 1,
          y: 0,
          params: { prompt: "plan", workspaceMode: "none" },
        },
      ],
      edges: [],
    });

    expect(upgraded.nodes.find((node) => node.id === "legacy")?.params.workspaceMode).toBe(
      "read_write",
    );
    expect(upgraded.nodes.find((node) => node.id === "new")?.params.workspaceMode).toBe("none");
  });

  it("upgrades bespoke step params and preserves requiredChecks as typed inputs", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "plan", type: "planning_agent", x: 0, y: 0, params: {} },
        { id: "checks", type: "run_checks", x: 0, y: 0, params: {} },
        {
          id: "approval",
          type: "send_plan_approval",
          x: 1,
          y: 0,
          params: { planFromStep: "plan", mirrorComment: false },
        },
        {
          id: "explicit",
          type: "send_plan_approval",
          x: 1,
          y: 1,
          params: { planFromStep: "plan" },
          inputs: { plan: "run.branchName" },
        },
        {
          id: "finalize",
          type: "finalize_workspace",
          x: 2,
          y: 0,
          params: { requiredChecks: ["checks"] },
        },
      ],
      edges: [
        { from: "trigger", to: "checks" },
        { from: "checks", to: "finalize" },
      ],
    });

    expect(upgraded.nodes.find((entry) => entry.id === "approval")).toMatchObject({
      params: { mirrorComment: false },
      inputs: {
        plan: "steps.plan.output.plan",
      },
    });
    expect(upgraded.nodes.find((entry) => entry.id === "explicit")).toMatchObject({
      params: {},
      inputs: {
        plan: "run.branchName",
      },
    });
    expect(upgraded.nodes.find((entry) => entry.id === "finalize")).toMatchObject({
      params: {},
      inputs: { "checks.checks": "steps.checks.output.status" },
    });
  });

  it("upgrades representable legacy Finalize gates and discards obsolete references", () => {
    const raw = {
      schemaVersion: 1 as const,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "safe", type: "run_checks", x: 0, y: 0, params: {} },
        { id: "side", type: "run_checks", x: 0, y: 1, params: {} },
        { id: "checks.with.dot", type: "run_checks", x: 0, y: 2, params: {} },
        { id: "checks space", type: "run_checks", x: 0, y: 3, params: {} },
        {
          id: "finalize",
          type: "finalize_workspace",
          x: 1,
          y: 0,
          params: {
            requiredChecks: [
              "safe",
              "checks.with.dot",
              "checks space",
              "missing",
              "side",
              "safe",
            ],
          },
        },
      ],
      edges: [
        { from: "trigger", to: "safe" },
        { from: "safe", to: "finalize" },
        { from: "trigger", to: "side" },
      ],
    };

    const upgraded = upgradeStoredWorkflowDefinition(raw);
    expect(upgraded.nodes.find((entry) => entry.id === "finalize")).toMatchObject({
      inputs: { "checks.safe": "steps.safe.output.status" },
      params: {},
    });
    expect(upgradeStoredWorkflowDefinition(upgraded)).toEqual(upgraded);
  });

  it("upgrades default Arthur content producers and discards obsolete dynamic references", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "plan", type: "planning_agent", x: 0, y: 0, params: {} },
        { id: "generic", type: "generic_agent", x: 0, y: 1, params: { prompt: "p" } },
        { id: "llm", type: "call_llm", x: 0, y: 2, params: { prompt: "p" } },
        {
          id: "generic-dynamic",
          type: "generic_agent",
          x: 0,
          y: 3,
          params: { prompt: "p", outputSchema: '{"type":"string"}' },
        },
        {
          id: "llm-dynamic",
          type: "call_llm",
          x: 0,
          y: 4,
          params: { prompt: "p", outputSchema: '{"type":"string"}' },
        },
        { id: "fix", type: "fix_agent", x: 0, y: 5, params: {} },
        {
          id: "check-plan",
          type: "arthur_injection_check",
          x: 1,
          y: 0,
          params: { contentFromStep: "plan" },
        },
        {
          id: "check-generic",
          type: "arthur_injection_check",
          x: 1,
          y: 1,
          params: { contentFromStep: "generic" },
        },
        {
          id: "check-llm",
          type: "arthur_injection_check",
          x: 1,
          y: 2,
          params: { contentFromStep: "llm" },
        },
        {
          id: "check-generic-dynamic",
          type: "arthur_injection_check",
          x: 1,
          y: 3,
          params: { contentFromStep: "generic-dynamic" },
        },
        {
          id: "check-llm-dynamic",
          type: "arthur_injection_check",
          x: 1,
          y: 4,
          params: { contentFromStep: "llm-dynamic" },
        },
        {
          id: "check-unknown",
          type: "arthur_injection_check",
          x: 1,
          y: 5,
          params: { contentFromStep: "fix" },
        },
      ],
      edges: [],
    });

    expect(upgraded.nodes.find((entry) => entry.id === "check-plan")?.inputs.content).toBe(
      "steps.plan.output.plan",
    );
    expect(upgraded.nodes.find((entry) => entry.id === "check-generic")?.inputs.content).toBe(
      "steps.generic.output.body",
    );
    expect(upgraded.nodes.find((entry) => entry.id === "check-llm")?.inputs.content).toBe(
      "steps.llm.output.output",
    );
    expect(upgraded.nodes.find((entry) => entry.id === "check-generic-dynamic")).toMatchObject({
      params: {},
      inputs: {},
    });
    expect(upgraded.nodes.find((entry) => entry.id === "check-llm-dynamic")).toMatchObject({
      params: {},
      inputs: {},
    });
    expect(upgraded.nodes.find((entry) => entry.id === "check-unknown")).toMatchObject({
      params: {},
      inputs: {},
    });
  });

  it("rejects blank or non-string input binding sources", () => {
    const base = { id: "n", type: "call_llm", x: 0, y: 0, params: { prompt: "p" } };
    expect(shapeOk([{ ...base, inputs: { prompt: "" } }])).toBe(false);
    expect(shapeOk([{ ...base, inputs: { prompt: 42 } }])).toBe(false);
  });

  it("rejects binding sources outside the three persisted source roots", () => {
    const base = { id: "n", type: "call_llm", x: 0, y: 0, params: { prompt: "p" } };
    for (const source of [
      "banana",
      "trigger.",
      "run.",
      "steps..output.plan",
      "steps.self.output",
      "steps.self.output.",
      "steps.self.plan",
    ]) {
      expect(shapeOk([{ ...base, inputs: { prompt: source } }]), source).toBe(false);
    }
  });

  it("rejects whitespace-normalized and prototype-bearing binding sources", () => {
    const base = { id: "n", type: "call_llm", x: 0, y: 0, params: { prompt: "p" } };
    for (const source of [
      " trigger.ticketKey",
      "trigger.ticketKey ",
      "run.constructor.name",
      "steps.plan.output.__proto__.value",
    ]) {
      expect(shapeOk([{ ...base, inputs: { prompt: source } }]), source).toBe(false);
    }
  });

  it("rejects unsafe dynamic input names before validation", () => {
    const base = {
      id: "n",
      type: "finalize_workspace",
      x: 0,
      y: 0,
      params: {},
    };
    for (const name of ["constructor", "checks.constructor", "checks.__proto__", "checks..lint"]) {
      expect(
        shapeOk([{ ...base, inputs: { [name]: "steps.lint.output.status" } }]),
        name,
      ).toBe(false);
    }
  });

  it("accepts the default definition (with and without review) and graph validates", () => {
    for (const includeReview of [true, false]) {
      const def = defaultWorkflowDefinition({ includeReview });
      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
      expect(validateWorkflowGraph(def)).toEqual([]);
      expect(def.nodes.find((node) => node.id === "planning")?.inputs).toEqual({
        ticket: "trigger.ticket",
        comments: "trigger.comments",
        priorAnswers: "trigger.priorAnswers",
      });
      expect(def.nodes.find((node) => node.id === "implementation")?.inputs).toEqual({
        ticket: "trigger.ticket",
        plan: "steps.planning.output.plan",
      });
    }
  });

  it("upgrades only direct canonical plan producers into explicit implementation bindings", () => {
    const upgraded = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "planning", type: "planning_agent", x: 1, y: 0, params: {} },
        { id: "implementation", type: "implementation_agent", x: 2, y: 0, params: {} },
      ],
      edges: [
        { from: "trigger", to: "planning" },
        { from: "planning", to: "implementation" },
      ],
    });

    expect(upgraded.nodes.find((node) => node.id === "planning")?.inputs).toEqual({
      ticket: "trigger.ticket",
      comments: "trigger.comments",
      priorAnswers: "trigger.priorAnswers",
    });
    expect(upgraded.nodes.find((node) => node.id === "implementation")?.inputs).toEqual({
      ticket: "trigger.ticket",
      plan: "steps.planning.output.plan",
    });

    const custom = upgradeStoredWorkflowDefinition({
      schemaVersion: 1,
      nodes: [
        { id: "trigger", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "branch", type: "branch", x: 1, y: 0, params: { condition: "true" } },
        { id: "implementation", type: "implementation_agent", x: 2, y: 0, params: {} },
      ],
      edges: [
        { from: "trigger", to: "branch" },
        { from: "branch", to: "implementation", fromPort: "true" },
      ],
    });
    expect(custom.nodes.find((node) => node.id === "implementation")?.inputs).toEqual({});
  });

  it("rejects an unknown param key", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "planning_agent").params.foo = 1;
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects an unknown block type", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes[1].type = "does_not_exist";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects a blank update_ticket_status target", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "update_ticket_status").params.target = "";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects maxFixCycles out of bounds", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "run_pre_pr_checks").params.maxFixCycles = 6;
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects schemaVersion 2", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: false }));
    def.schemaVersion = 2;
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("accepts a provider on every agent block type", () => {
    for (const provider of ["claude", "codex"] as const) {
      const def = clone(defaultWorkflowDefinition({ includeReview: true }));
      for (const type of ["planning_agent", "implementation_agent", "review_agent"]) {
        def.nodes.find((n: WorkflowDefinitionNode) => n.type === type).params.provider = provider;
      }
      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    }
  });

  it("rejects an invalid provider value", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: true }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "planning_agent").params.provider = "gemini";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("rejects a provider on a non-agent block type", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: true }));
    def.nodes.find((n: WorkflowDefinitionNode) => n.type === "open_pr").params.provider = "claude";
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(false);
  });

  it("accepts a legacy definition without a provider", () => {
    const def = defaultWorkflowDefinition({ includeReview: true });
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it("accepts a well-formed branch node and rejects out-of-bound conditions", () => {
    const good = { id: "b", type: "branch", x: 0, y: 0, params: { condition: "steps.a.output.ok" } };
    expect(shapeOk([good])).toBe(true);
    expect(shapeOk([{ ...good, params: { condition: "" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { condition: "x".repeat(1001) } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { condition: "steps.a.output.ok", extra: 1 } }])).toBe(false);
  });

  it("accepts a well-formed loop node and rejects invalid params", () => {
    const good = { id: "l", type: "loop", x: 0, y: 0, params: { maxAttempts: 3, onExhaust: "fail" } };
    expect(shapeOk([good])).toBe(true);
    expect(shapeOk([{ ...good, params: { maxAttempts: 0, onExhaust: "fail" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 21, onExhaust: "fail" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 2.5, onExhaust: "fail" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 3, onExhaust: "bogus" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { maxAttempts: 3 } }])).toBe(false);
  });

  it("accepts a well-formed terminate node and rejects invalid params", () => {
    const good = { id: "x", type: "terminate", x: 0, y: 0, params: { terminalStatus: "done" } };
    expect(shapeOk([good])).toBe(true);
    expect(
      shapeOk([{ ...good, params: { terminalStatus: "waiting_for_human", postComment: "please review" } }]),
    ).toBe(true);
    expect(shapeOk([{ ...good, params: { terminalStatus: "unknown" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { terminalStatus: "done", postComment: "" } }])).toBe(false);
    expect(shapeOk([{ ...good, params: { terminalStatus: "done", extra: 1 } }])).toBe(false);
  });

  it("accepts an edge fromPort and rejects an empty one", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    expect(shapeOk(nodes, [{ from: "t", to: "p", fromPort: "out" }])).toBe(true);
    expect(shapeOk(nodes, [{ from: "t", to: "p", fromPort: "" }])).toBe(false);
  });
});

describe("workflowDefinitionSchema block-executor node types", () => {
  function parseNode(raw: Record<string, unknown>) {
    const parsed = workflowDefinitionSchema.safeParse({
      schemaVersion: 1,
      nodes: [{ id: "n", x: 0, y: 0, ...raw }],
      edges: [],
    });
    return parsed.success ? parsed.data.nodes[0] : null;
  }

  it("accepts valid params for every new block type", () => {
    const valid: Array<[WorkflowBlockTypeV1, Record<string, WorkflowParamValue>]> = [
      ["trigger_plan_approved", {}],
      ["trigger_pr_created", {}],
      ["trigger_pr_checks_failed", {}],
      ["trigger_pr_review", {}],
      ["trigger_pr_merged", {}],
      ["prepare_workspace", {}],
      ["finalize_workspace", {}],
      ["fix_agent", { provider: "codex", model: "gpt-5", instructions: "focus", maxMinutes: 30 }],
      ["generic_agent", { provider: "claude", prompt: "do it", outputSchema: "{}" }],
      ["call_llm", { prompt: "summarize", system: "be terse", model: "claude-haiku-4-5" }],
      ["fetch_pr_context", {}],
      ["run_checks", { commands: ["pnpm test"] }],
      ["post_ticket_comment", { body: "done" }],
      ["post_pr_comment", { body: "done", target: "all" }],
      ["human_question", { questions: ["Which env?"] }],
      ["arthur_injection_check", {}],
      ["leak_review", { model: "claude-haiku-4-5", llmScan: false, maxDiffBytes: 4096 }],
    ];
    for (const [type, params] of valid) {
      expect(shapeOk([node("n", type, params)]), type).toBe(true);
    }
  });

  it("rejects unknown param keys on every new block type", () => {
    const types: WorkflowBlockTypeV1[] = [
      "trigger_plan_approved",
      "trigger_pr_created",
      "trigger_pr_checks_failed",
      "trigger_pr_review",
      "trigger_pr_merged",
      "prepare_workspace",
      "finalize_workspace",
      "fix_agent",
      "call_llm",
      "fetch_pr_context",
      "run_checks",
      "human_question",
      "arthur_injection_check",
      "leak_review",
    ];
    for (const type of types) {
      expect(shapeOk([node("n", type, { bogus: 1 })]), type).toBe(false);
    }
    expect(shapeOk([node("n", "generic_agent", { prompt: "p", bogus: 1 })])).toBe(false);
    expect(shapeOk([node("n", "post_ticket_comment", { body: "b", bogus: 1 })])).toBe(false);
    expect(shapeOk([node("n", "post_pr_comment", { body: "b", bogus: 1 })])).toBe(false);
  });

  it("applies PR-trigger param defaults and rejects unknown keys", () => {
    expect(parseNode({ type: "trigger_plan_approved", params: {} })?.params).toEqual({});
    expect(parseNode({ type: "trigger_pr_created", params: {} })?.params).toEqual({
      providers: ["github", "gitlab"],
      scope: "workflow_owned",
    });
    expect(parseNode({ type: "trigger_pr_checks_failed", params: {} })?.params).toEqual({
      checkNames: [],
      githubAppSlugs: ["github-actions"],
      gitlabPipelineSources: ["merge_request_event"],
      providers: ["github", "gitlab"],
      scope: "workflow_owned",
    });
    expect(parseNode({ type: "trigger_pr_review", params: {} })?.params).toEqual({
      providers: ["github"],
      on: ["changes_requested"],
      scope: "workflow_owned",
    });
    expect(parseNode({ type: "trigger_pr_merged", params: {} })?.params).toEqual({
      providers: ["github", "gitlab"],
      scope: "workflow_owned",
    });
    // Explicit scope round-trips on every PR trigger.
    expect(
      parseNode({ type: "trigger_pr_created", params: { scope: "any" } })?.params,
    ).toEqual({ providers: ["github", "gitlab"], scope: "any" });
    expect(
      parseNode({ type: "trigger_pr_review", params: { on: ["changes_requested", "commented"] } })
        ?.params,
    ).toEqual({
      providers: ["github"],
      on: ["changes_requested", "commented"],
      scope: "workflow_owned",
    });
    // Unknown keys and out-of-enum values are still rejected (strict).
    expect(parseNode({ type: "trigger_pr_created", params: { bogus: 1 } })).toBeNull();
    expect(parseNode({ type: "trigger_pr_review", params: { on: [] } })).toBeNull();
    expect(parseNode({ type: "trigger_pr_review", params: { on: ["approved"] } })).toBeNull();
    expect(
      parseNode({
        type: "trigger_pr_checks_failed",
        params: {
          checkNames: ["ci / build"],
          githubAppSlugs: ["github-actions"],
          gitlabPipelineSources: ["merge_request_event"],
        },
      })?.params,
    ).toEqual({
      checkNames: ["ci / build"],
      githubAppSlugs: ["github-actions"],
      gitlabPipelineSources: ["merge_request_event"],
      providers: ["github", "gitlab"],
      scope: "workflow_owned",
    });
    for (const type of [
      "trigger_pr_created",
      "trigger_pr_checks_failed",
      "trigger_pr_review",
      "trigger_pr_merged",
    ] as const) {
      expect(parseNode({ type, params: { providers: [] } }), type).toBeNull();
    }
  });

  it("upgrades the legacy onlyWorkflowOwned flag to explicit scope", () => {
    const upgraded = upgradeStoredWorkflowDefinition(
      graph(
        [
          node("owned", "trigger_pr_created", { onlyWorkflowOwned: true } as any),
          node("any", "trigger_pr_created", { onlyWorkflowOwned: false } as any),
        ],
        [],
      ),
    );
    expect(upgraded.nodes.map(({ params }) => params)).toEqual([
      { scope: "workflow_owned" },
      { scope: "any" },
    ]);
  });

  it("normalizes a stored empty PR review state list to its runtime default", () => {
    const upgraded = upgradeStoredWorkflowDefinition(
      graph([node("review", "trigger_pr_review", { providers: ["github"], on: [] })], []),
    );

    expect(upgraded.nodes[0]?.params.on).toEqual(["changes_requested"]);
    expect(workflowDefinitionSchema.safeParse(upgraded).success).toBe(true);
  });

  it("applies action param defaults", () => {
    expect(parseNode({ type: "fix_agent", params: {} })?.params).toEqual({ maxMinutes: 25 });
    // call_llm intentionally has NO model default: leaving it unset lets the
    // executor resolve the model from provider/run default at runtime.
    expect(parseNode({ type: "call_llm", params: { prompt: "p" } })?.params).toEqual({
      prompt: "p",
    });
    expect(parseNode({ type: "post_pr_comment", params: { body: "b" } })?.params).toEqual({
      body: "b",
      target: "primary",
    });
  });

  it("allowlists the model param and rejects shell-metacharacter model ids", () => {
    // Safe ids (alphanumerics + . _ : / -) pass on every agent-ish block.
    expect(shapeOk([node("n", "planning_agent", { model: "claude-opus-4-6" })])).toBe(true);
    expect(shapeOk([node("n", "implementation_agent", { model: "us.anthropic.claude:v1/2" })])).toBe(true);
    expect(shapeOk([node("n", "review_agent", { model: "gpt-5-codex" })])).toBe(true);
    // Injection payloads are rejected at save time (400).
    expect(shapeOk([node("n", "planning_agent", { model: "m'; rm -rf /" })])).toBe(false);
    expect(shapeOk([node("n", "implementation_agent", { model: "$(whoami)" })])).toBe(false);
    expect(shapeOk([node("n", "generic_agent", { prompt: "p", model: "has space" })])).toBe(false);
    expect(shapeOk([node("n", "fix_agent", { model: 'gpt"5' })])).toBe(false);
    expect(shapeOk([node("n", "call_llm", { prompt: "p", model: "back`tick" })])).toBe(false);
  });

  it("bounds fix_agent maxMinutes", () => {
    expect(shapeOk([node("n", "fix_agent", { maxMinutes: 4 })])).toBe(false);
    expect(shapeOk([node("n", "fix_agent", { maxMinutes: 61 })])).toBe(false);
  });

  it.each([
    ["call_llm", "prompt"],
    ["generic_agent", "prompt"],
    ["post_ticket_comment", "body"],
    ["post_pr_comment", "body"],
  ] as const)("accepts a binding-only %s draft through its typed %s input", (type, inputName) => {
    expect(
      shapeOk([
        node("source", "planning_agent"),
        node("consumer", type, {}, { [inputName]: "steps.source.output.plan" }),
      ]),
    ).toBe(true);
  });

  it("accepts provider status ids and rejects blank update_ticket_status targets", () => {
    expect(shapeOk([node("n", "update_ticket_status", { target: "ai_review" })])).toBe(true);
    expect(shapeOk([node("n", "update_ticket_status", { target: "backlog" })])).toBe(true);
    expect(shapeOk([node("n", "update_ticket_status", { target: "10042" })])).toBe(true);
    expect(shapeOk([node("n", "update_ticket_status", { target: "Code Review" })])).toBe(true);
    expect(shapeOk([node("n", "update_ticket_status", { target: "" })])).toBe(false);
    expect(shapeOk([node("n", "update_ticket_status", { target: "   " })])).toBe(false);
  });

  it("caps the graph size", () => {
    const trigger = node("t", "trigger_ticket_ai");
    const filler = (count: number) =>
      Array.from({ length: count }, (_, i) => node(`n${i}`, "open_pr"));
    expect(shapeOk([trigger, ...filler(199)])).toBe(true);
    expect(shapeOk([trigger, ...filler(200)])).toBe(false);

    const edges = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ from: "t", to: `n${i}` }));
    expect(shapeOk([trigger, ...filler(199)], edges(400))).toBe(true);
    expect(shapeOk([trigger, ...filler(199)], edges(401))).toBe(false);
  });
});

describe("validateWorkflowGraph fixtures", () => {
  it("ships eight deployable starter templates with the production ticket workflow first", () => {
    const templates = workflowDefinitionTemplates({ includeReview: true });
    expect(templates.map((template) => template.name)).toEqual([
      "Ticket workflow",
      "Human-approved plan",
      "Review & fix after PR",
      "Reviewed ticket workflow",
      "Post-PR review",
      "Post-PR review with autofix",
      "Fully modular",
      "Ticket triage (webhook)",
    ]);
    expect(templates[0].definition.nodes.some((node) => node.type === "review_agent")).toBe(true);
    for (const template of templates) {
      const parsed =
        template.definition.schemaVersion === 2
          ? workflowDefinitionV2Schema.safeParse(template.definition)
          : workflowDefinitionSchema.safeParse(template.definition);
      expect(parsed.success).toBe(true);
      expect(validateWorkflowDefinitionForDeployment(template.definition, registryContext)).toEqual([]);
    }
  });

  it("accepts the linear pipeline fixture", () => {
    const def = linearPipelineDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("accepts the human-gate loop fixture", () => {
    const def = humanGateLoopDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("accepts the plan-approval fixture", () => {
    const def = planApprovalDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("accepts the PR-review-fix fixture", () => {
    const def = prReviewFixDefinition();
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("keeps canonical V4 free of an explicit Prepare block", () => {
    const def = prReviewFixDefinition();
    expect(def.nodes.some((node) => node.type === "prepare_workspace")).toBe(false);
    expect(def.edges).toContainEqual({ from: "fetch-context", to: "fix" });
  });
});

describe("validateWorkflowGraph rules", () => {
  it("rule 1: flags a duplicate node id", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("dup", "planning_agent"), node("dup", "open_pr")],
      [{ from: "t", to: "dup" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes('Block id "dup" is used more than once')),
    ).toBe(true);
  });

  it("rule 2: flags a workflow without any trigger", () => {
    const def = graph([node("p", "planning_agent")], []);
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("Workflow must contain at least one trigger block."),
      ),
    ).toBe(true);
  });

  it("rule 3: flags two triggers of the same type", () => {
    const def = graph(
      [node("t1", "trigger_ticket_ai"), node("t2", "trigger_ticket_ai")],
      [],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("Workflow contains more than one trigger_ticket_ai trigger block."),
      ),
    ).toBe(true);
  });

  it("rule 4: flags a trigger with an incoming edge", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [{ from: "p", to: "t" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) => issue.includes("must not have incoming connections")),
    ).toBe(true);
  });

  it("rule 5: flags edges referencing unknown blocks and self-edges", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [
        { from: "ghost-source", to: "p" },
        { from: "p", to: "ghost-target" },
        { from: "p", to: "p" },
      ],
    );
    const issues = validateWorkflowGraph(def);
    expect(issues.some((issue) => issue.includes('unknown source block "ghost-source"'))).toBe(true);
    expect(issues.some((issue) => issue.includes('unknown target block "ghost-target"'))).toBe(true);
    expect(issues.some((issue) => issue.includes('Block "p" cannot connect to itself'))).toBe(true);
  });

  it("rule 6: flags an unknown port", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [{ from: "t", to: "p", fromPort: "bogus" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('uses unknown port "bogus" of block type trigger_ticket_ai'),
      ),
    ).toBe(true);
  });

  it("rule 6: flags a branch edge that omits its port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.p.output.ok" }),
        node("x", "open_pr"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Connection from branch "b" must specify a port (true/false)'),
      ),
    ).toBe(true);
  });

  it("rule 6: flags a terminate block with an outgoing edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("term", "terminate", { terminalStatus: "done" }),
        node("p", "planning_agent"),
      ],
      [
        { from: "t", to: "term" },
        { from: "term", to: "p" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Terminal block "term" (terminate) cannot have outgoing connections'),
      ),
    ).toBe(true);
  });

  it("rule 7: forbids a fan-out from a single port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("a", "open_pr"),
        node("b", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "a" },
        { from: "p", to: "b" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Block "p" has multiple connections from port "out"'),
      ),
    ).toBe(true);
  });

  it("rule 7: flags an exact duplicate connection", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("p", "planning_agent")],
      [
        { from: "t", to: "p" },
        { from: "t", to: "p" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Duplicate connection from "t" to "p"'),
      ),
    ).toBe(true);
  });

  it("rule 7: allows a failure-port fan-out alongside the default port", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("ok", "open_pr"),
        node("bad", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "ok" },
        { from: "p", to: "bad", fromPort: "failed" },
      ],
    );
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("rule 8: flags an unreachable node", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("orphan", "send_slack_message"),
      ],
      [{ from: "t", to: "p" }],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Block "orphan" is not reachable from a trigger'),
      ),
    ).toBe(true);
  });

  it("rule 9: flags a half-wired branch", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.p.output.ok" }),
        node("x", "open_pr"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "true" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" must have its "false" port connected'),
      ),
    ).toBe(true);
  });

  it("rule 10: flags a loop whose continue port does not lead back", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("f", "open_pr"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
        { from: "lp", to: "f", fromPort: "continue" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes(`Loop "lp"'s continue port must lead back to it`),
      ),
    ).toBe(true);
  });

  it("rule 10: flags onExhaust continue without an exhausted edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "continue" }),
        node("f", "implementation_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
        { from: "lp", to: "f", fromPort: "continue" },
        { from: "f", to: "lp" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes(
          'Loop "lp" with onExhaust "continue" must have its "exhausted" port connected',
        ),
      ),
    ).toBe(true);
  });

  it("rule 10: flags a loop missing its continue edge", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Loop "lp" must have its "continue" port connected'),
      ),
    ).toBe(true);
  });

  it("rule 11: flags a cycle that passes through no loop", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("a", "planning_agent"),
        node("b", "implementation_agent"),
      ],
      [
        { from: "t", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("form a cycle that does not pass through a Loop block"),
      ),
    ).toBe(true);
  });

  it("rule 11: flags a cycle region containing two loops", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("lp1", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("lp2", "loop", { maxAttempts: 3, onExhaust: "fail" }),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "lp1" },
        { from: "lp1", to: "lp2", fromPort: "continue" },
        { from: "lp2", to: "lp1", fromPort: "continue" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes("form a cycle region with 2 Loop blocks; each cycle region must contain exactly one"),
      ),
    ).toBe(true);
  });

  it("rule 11: rejects Finalize Workspace inside a loop cycle", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("finalize", "finalize_workspace"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
      ],
      [
        { from: "t", to: "finalize" },
        { from: "finalize", to: "lp" },
        { from: "lp", to: "finalize", fromPort: "continue" },
      ],
    );

    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Finalize Workspace block "finalize" cannot execute inside a Loop cycle'),
      ),
    ).toBe(true);
  });

  it("rule 11: rejects a path that can execute two Finalize Workspace blocks", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("first", "finalize_workspace"),
        node("second", "finalize_workspace"),
      ],
      [
        { from: "t", to: "first" },
        { from: "first", to: "second" },
      ],
    );

    expect(validateWorkflowGraph(def)).toContain(
      'Finalize Workspace block "first" can reach Finalize Workspace block "second"; a workflow path may publish at most once.',
    );
  });

  it("rule 11: allows mutually exclusive Finalize Workspace blocks", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("choice", "branch", { condition: "true" }),
        node("left", "finalize_workspace"),
        node("right", "finalize_workspace"),
      ],
      [
        { from: "t", to: "choice" },
        { from: "choice", to: "left", fromPort: "true" },
        { from: "choice", to: "right", fromPort: "false" },
      ],
    );

    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("rule 12: flags an invalid branch condition", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "this is not valid @@@" }),
        node("x", "open_pr"),
        node("y", "send_slack_message"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "true" },
        { from: "b", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" has an invalid condition:'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition referencing a non-ancestor block", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("b", "branch", { condition: "steps.other.output.ok" }),
        node("x", "open_pr"),
        node("other", "send_slack_message"),
        node("y", "implementation_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "b" },
        { from: "b", to: "x", fromPort: "true" },
        { from: "x", to: "other" },
        { from: "b", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" condition references block "other" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition referencing a block on only one branch (not a dominator)", () => {
    // "left" runs on the true arm only, so a run reaching "merge" via the false
    // arm never produces its output. It is an ancestor on one path but does not
    // dominate the merge, so it must be rejected.
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("split", "branch", { condition: "true" }),
        node("left", "planning_agent"),
        node("right", "implementation_agent"),
        node("merge", "branch", { condition: "steps.left.output.ok" }),
        node("x", "open_pr"),
        node("y", "send_slack_message"),
      ],
      [
        { from: "t", to: "split" },
        { from: "split", to: "left", fromPort: "true" },
        { from: "split", to: "right", fromPort: "false" },
        { from: "left", to: "merge" },
        { from: "right", to: "merge" },
        { from: "merge", to: "x", fromPort: "true" },
        { from: "merge", to: "y", fromPort: "false" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "merge" condition references block "left" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: flags a condition referencing a later loop-body block that does not dominate it", () => {
    // The branch runs before "fix" the first time through, so on that path
    // "fix" has no output; being a cycle member does not make it a dominator.
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("checks", "run_pre_pr_checks"),
        node("b", "branch", { condition: "steps.fix.output.ok" }),
        node("open", "open_pr"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("fix", "review_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "checks" },
        { from: "checks", to: "b" },
        { from: "b", to: "open", fromPort: "true" },
        { from: "b", to: "lp", fromPort: "false" },
        { from: "lp", to: "fix", fromPort: "continue" },
        { from: "fix", to: "checks" },
      ],
    );
    expect(
      validateWorkflowGraph(def).some((issue) =>
        issue.includes('Branch "b" condition references block "fix" which does not run before it'),
      ),
    ).toBe(true);
  });

  it("rule 12: allows a condition referencing a dominator reached across a loop back-edge", () => {
    // "checks" is the branch's sole predecessor, so it dominates the branch on
    // every path, including loop iterations (verdict --false--> loop --> fix -->
    // checks). The loop back-edge must not break the dominator computation.
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("p", "planning_agent"),
        node("checks", "run_pre_pr_checks"),
        node("verdict", "branch", { condition: "steps.checks.output.ok" }),
        node("open", "open_pr"),
        node("lp", "loop", { maxAttempts: 3, onExhaust: "fail" }),
        node("fix", "review_agent"),
      ],
      [
        { from: "t", to: "p" },
        { from: "p", to: "checks" },
        { from: "checks", to: "verdict" },
        { from: "verdict", to: "open", fromPort: "true" },
        { from: "verdict", to: "lp", fromPort: "false" },
        { from: "lp", to: "fix", fromPort: "continue" },
        { from: "fix", to: "checks" },
      ],
    );
    expect(validateWorkflowGraph(def)).toEqual([]);
  });

  it("keeps structural draft validation separate from deploy-grade binding validation", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        {
          ...node("approve", "send_plan_approval"),
          inputs: { plan: "steps.ghost.output.plan" },
        },
      ],
      [{ from: "t", to: "approve" }],
    );

    expect(validateWorkflowGraph(def)).toEqual([]);
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
      expect.arrayContaining([expect.stringContaining('references unknown block "ghost"')]),
    );
  });

  it.each([
    ["call_llm", "prompt"],
    ["generic_agent", "prompt"],
    ["post_ticket_comment", "body"],
    ["post_pr_comment", "body"],
  ] as const)(
    "deploys %s with a compatible bound %s and rejects the block when both sources are absent",
    (type, inputName) => {
      const bound = graph(
        [
          node("trigger", "trigger_ticket_ai"),
          node("source", "planning_agent"),
          node("consumer", type, {}, { [inputName]: "steps.source.output.plan" }),
        ],
        [
          { from: "trigger", to: "source" },
          { from: "source", to: "consumer" },
        ],
      );
      const parsed = workflowDefinitionSchema.safeParse(bound);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(validateWorkflowDefinitionForDeployment(parsed.data, registryContext)).toEqual([]);

      const missing = graph(
        [node("trigger", "trigger_ticket_ai"), node("consumer", type)],
        [{ from: "trigger", to: "consumer" }],
      );
      const missingParsed = workflowDefinitionSchema.safeParse(missing);
      expect(missingParsed.success).toBe(true);
      if (!missingParsed.success) return;
      expect(validateWorkflowDefinitionForDeployment(missingParsed.data, registryContext)).toContain(
        `Block "consumer" (${type}) requires either a non-empty "${inputName}" parameter or a compatible "${inputName}" input binding.`,
      );
    },
  );

  describe("workspace capability validation", () => {
    it.each([
      ["trigger", []],
      ["planning agent", [node("before", "planning_agent")]],
      [
        "agent-only Generic Agent",
        [node("before", "generic_agent", { prompt: "plan", workspaceMode: "none" })],
      ],
      [
        "workspace-mode Generic Agent without a producer",
        [node("before", "generic_agent", { prompt: "edit", workspaceMode: "read_write" })],
      ],
    ] as const)("rejects Run Checks after %s", (_label, predecessors) => {
      const nodes = [
        node("trigger", "trigger_ticket_ai"),
        ...predecessors,
        node("checks", "run_checks"),
      ];
      const chain = nodes.slice(0, -1).map((current, index) => ({
        from: current.id,
        to: nodes[index + 1]!.id,
      }));

      expect(validateWorkflowDefinitionForDeployment(graph(nodes, chain), registryContext)).toContain(
        'Block "checks" (run_checks) requires a workspace-producing block to run before it on every path.',
      );
    });

    it.each([
      ["Prepare Workspace", "prepare_workspace"],
      ["Implementation Agent", "implementation_agent"],
      ["Review Agent", "review_agent"],
      ["Fix Agent", "fix_agent"],
    ] as const)("accepts Run Checks after a dominating %s", (_label, producerType) => {
      const def = graph(
        [
          node("trigger", "trigger_ticket_ai"),
          node("producer", producerType),
          node("checks", "run_checks"),
        ],
        [
          { from: "trigger", to: "producer" },
          { from: "producer", to: "checks" },
        ],
      );

      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual([]);
    });

    it("rejects a workspace producer that runs on only one path to Run Checks", () => {
      const def = graph(
        [
          node("trigger", "trigger_ticket_ai"),
          node("branch", "branch", { condition: "true" }),
          node("prepare", "prepare_workspace"),
          node("bypass", "send_slack_message", { message: "skip preparation" }),
          node("checks", "run_checks"),
        ],
        [
          { from: "trigger", to: "branch" },
          { from: "branch", to: "prepare", fromPort: "true" },
          { from: "branch", to: "bypass", fromPort: "false" },
          { from: "prepare", to: "checks" },
          { from: "bypass", to: "checks" },
        ],
      );

      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toContain(
        'Block "checks" (run_checks) requires a workspace-producing block to run before it on every path.',
      );
    });

    it("does not treat a workspace producer's failure path as a guaranteed workspace", () => {
      const def = graph(
        [
          node("trigger", "trigger_ticket_ai"),
          node("implementation", "implementation_agent"),
          node("checks", "run_checks"),
        ],
        [
          { from: "trigger", to: "implementation" },
          { from: "implementation", to: "checks", fromPort: "failed" },
        ],
      );

      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toContain(
        'Block "checks" (run_checks) requires a workspace-producing block to run before it on every path.',
      );
    });

    it.each([
      ["Run Checks", "run_checks", {}],
      ["Pre-PR checks", "run_pre_pr_checks", {}],
      ["Finalize workspace", "finalize_workspace", {}],
      ["workspace-mode Generic Agent", "generic_agent", { prompt: "edit", workspaceMode: "read_write" }],
    ] as const)("rejects %s without a dominating workspace producer", (_label, type, params) => {
      const def = graph(
        [node("trigger", "trigger_ticket_ai"), node("consumer", type, params)],
        [{ from: "trigger", to: "consumer" }],
      );

      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toContain(
        `Block "consumer" (${type}) requires a workspace-producing block to run before it on every path.`,
      );
    });

    it("allows an agent-only Generic Agent without a workspace producer", () => {
      const def = graph(
        [
          node("trigger", "trigger_ticket_ai"),
          node("consumer", "generic_agent", { prompt: "classify", workspaceMode: "none" }),
        ],
        [{ from: "trigger", to: "consumer" }],
      );

      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual([]);
    });
  });

  it("requires an exact check selector only when deploying a failed-check trigger", () => {
    const def = graph(
      [
        node("checks", "trigger_pr_checks_failed", {
          providers: ["github"],
          scope: "workflow_owned",
          checkNames: [],
          githubAppSlugs: ["github-actions"],
          gitlabPipelineSources: ["merge_request_event"],
        }),
      ],
      [],
    );

    expect(validateWorkflowGraph(def)).toEqual([]);
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toContain(
      'Block "checks" (trigger_pr_checks_failed) must configure at least one exact CI check name before deployment.',
    );
  });

  it("rejects environmentally unavailable blocks only at deployment validation", () => {
    const def = graph(
      [node("t", "trigger_ticket_ai"), node("slack", "send_slack_message")],
      [{ from: "t", to: "slack" }],
    );
    const unavailable = { ...registryContext, slackConfigured: false };

    expect(validateWorkflowGraph(def)).toEqual([]);
    expect(validateWorkflowDefinitionForDeployment(def, unavailable)).toEqual(
      expect.arrayContaining([
        'Block "slack" (send_slack_message) is unavailable: Slack messaging is not configured.',
      ]),
    );
  });

  it("rejects unsupported GitLab review states and missing commented-review bot identities", () => {
    const unsupported = graph(
      [
        node("review", "trigger_pr_review", {
          providers: ["gitlab"],
          on: ["changes_requested"],
          scope: "workflow_owned",
        }),
      ],
      [],
    );
    expect(validateWorkflowDefinitionForDeployment(unsupported, registryContext)).toContain(
      'Block "review" (trigger_pr_review) is unavailable: GitLab review triggers must include "commented"; GitLab does not emit a reliable changes-requested review event.',
    );

    const commented = graph(
      [
        node("review", "trigger_pr_review", {
          providers: ["github", "gitlab"],
          on: ["changes_requested", "commented"],
          scope: "workflow_owned",
        }),
      ],
      [],
    );
    expect(
      validateWorkflowDefinitionForDeployment(commented, {
        ...registryContext,
        vcsBotIdentities: ["github"],
      }),
    ).toContain(
      'Block "review" (trigger_pr_review) is unavailable: Commented review triggers require a configured GITLAB_BOT_LOGIN to prevent recursive bot reviews.',
    );
  });

  it("deploys the PR review trigger authored by a GitLab-only registry", () => {
    const gitlabOnlyContext: WorkflowBlockRegistryContext = {
      ...registryContext,
      vcsProviders: ["gitlab"],
      vcsBotIdentities: ["gitlab"],
    };
    const defaults = buildWorkflowBlockRegistry(gitlabOnlyContext).trigger_pr_review.defaults;
    const definition = graph([node("review", "trigger_pr_review", defaults)], []);

    expect(validateWorkflowDefinitionForDeployment(definition, gitlabOnlyContext)).toEqual([]);
  });

  describe("definition repository pin", () => {
    const pinned = (
      repositoryScope: WorkflowDefinitionV1["repositoryScope"],
    ): WorkflowDefinitionV1 => ({
      ...graph([node("trigger", "trigger_ticket_ai")], []),
      ...(repositoryScope ? { repositoryScope } : {}),
    });

    it("deploys a pin whose providers are configured", () => {
      expect(
        validateWorkflowDefinitionForDeployment(
          pinned({
            providers: ["github"],
            repositories: [{ provider: "github", repoPath: "acme/api" }],
          }),
          registryContext,
        ),
      ).toEqual([]);
    });

    it("rejects a pin whose providers are all unconfigured", () => {
      expect(
        validateWorkflowDefinitionForDeployment(pinned({ providers: ["github"] }), {
          ...registryContext,
          vcsProviders: ["gitlab"],
        }),
      ).toContain("Pinned VCS providers are not configured: github.");
    });

    it("rejects a pin contradicting its own provider list, on both schema versions", () => {
      const contradiction = {
        providers: ["github" as const],
        repositories: [{ provider: "gitlab" as const, repoPath: "acme/shared" }],
      };
      const message =
        "Pinned repositories use providers excluded by the pinned provider list: gitlab:acme/shared.";

      expect(
        validateWorkflowDefinitionForDeployment(pinned(contradiction), registryContext),
      ).toContain(message);
      expect(
        validateWorkflowDefinitionForDeployment(
          {
            schemaVersion: 2,
            repositoryScope: contradiction,
            nodes: [
              {
                id: "trigger",
                type: "trigger_ticket_ai",
                x: 0,
                y: 0,
                configuration: {},
                inputs: {},
                additionalInputs: [],
              },
            ],
            edges: [],
          },
          registryContext,
        ),
      ).toContain(message);
    });

    // A stored pinned definition must keep loading when provider configuration
    // changes under it, but a contradiction inside the definition itself always
    // fails closed instead of being dropped silently at runtime.
    it("separates environment availability from the definition-local contradiction", () => {
      const contradiction = pinned({
        providers: ["github"],
        repositories: [{ provider: "gitlab", repoPath: "acme/shared" }],
      });
      const gitlabOnly = { ...registryContext, vcsProviders: ["gitlab" as const] };

      expect(
        validateWorkflowDefinitionForDeployment(pinned({ providers: ["github"] }), gitlabOnly, {
          checkEnvironmentAvailability: false,
        }),
      ).toEqual([]);
      expect(
        validateWorkflowDefinitionForDeployment(contradiction, gitlabOnly, {
          checkEnvironmentAvailability: false,
        }),
      ).toEqual([
        "Pinned repositories use providers excluded by the pinned provider list: gitlab:acme/shared.",
      ]);
    });

    it("reports the pin once, with no node and the scope's own path", () => {
      const issues = validateWorkflowDefinitionIssuesForDeployment(
        pinned({ providers: ["github"] }),
        { ...registryContext, vcsProviders: ["gitlab"] },
      ).filter((issue) => issue.message.startsWith("Pinned VCS providers"));

      expect(issues).toEqual([
        {
          code: "deployment",
          severity: "error",
          nodeId: null,
          path: "/repositoryScope",
          message: "Pinned VCS providers are not configured: github.",
        },
      ]);
    });

    it("leaves a definition without a pin untouched", () => {
      expect(
        validateWorkflowDefinitionForDeployment(pinned(undefined), registryContext),
      ).toEqual([]);
      expect(
        validateWorkflowDefinitionForDeployment(pinned({}), registryContext),
      ).toEqual([]);
    });
  });

  it("allows scope:any only through review-safe, non-mutating blocks", () => {
    const def = graph(
      [
        node("trigger", "trigger_pr_review", {
          providers: ["github"],
          on: ["changes_requested"],
          scope: "any",
        }),
        node("context", "fetch_pr_context"),
        node("prepare", "prepare_workspace"),
        node("reviewer", "review_agent"),
        node("comment", "post_pr_comment", { body: "Review noted" }),
      ],
      [
        { from: "trigger", to: "context" },
        { from: "context", to: "prepare" },
        { from: "prepare", to: "reviewer" },
        { from: "reviewer", to: "comment" },
      ],
    );
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual([]);
  });

  it.each([
    "trigger_pr_created",
    "trigger_pr_checks_failed",
    "trigger_pr_review",
    "trigger_pr_merged",
  ] as const)("rejects a ticketKey binding from scope:any %s", (type) => {
    const params: Record<string, WorkflowParamValue> = {
      providers: ["github"],
      scope: "any",
      ...(type === "trigger_pr_review" ? { on: ["changes_requested"] } : {}),
    };
    const def = graph(
      [
        node("trigger", type, params),
        node("comment", "post_pr_comment", {}, { body: "trigger.ticketKey" }),
      ],
      [{ from: "trigger", to: "comment" }],
    );

    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toContain(
      'Block "comment" input "body" references missing field "trigger.ticketKey" for trigger "trigger".',
    );
  });

  it("classifies every block type and exposes only an exact positive safe allowlist", () => {
    expect(Object.keys(ANY_SCOPE_BLOCK_POLICY).sort()).toEqual(
      Object.keys(BLOCK_TYPE_SPECS)
        .filter((type) => !isV2OnlyBlockType(type as keyof typeof BLOCK_TYPE_SPECS))
        .sort(),
    );
    expect(
      Object.entries(ANY_SCOPE_BLOCK_POLICY)
        .filter(([, policy]) => policy === "safe")
        .map(([type]) => type)
        .sort(),
    ).toEqual(
      [
        "arthur_injection_check",
        "branch",
        "call_llm",
        "fetch_pr_context",
        "loop",
        "post_pr_comment",
        "prepare_workspace",
        "review_agent",
      ].sort(),
    );
  });

  it.each([
    "post_ticket_comment",
    "fix_agent",
    "generic_agent",
    "finalize_workspace",
    "open_pr",
    "run_pre_pr_checks",
    "implementation_agent",
    "leak_review",
  ] as const)("rejects scope:any path reaching %s", (unsafeType) => {
    const params: Record<string, WorkflowParamValue> =
      unsafeType === "post_ticket_comment"
        ? { body: "unsafe" }
        : unsafeType === "generic_agent"
          ? { prompt: "review", workspaceMode: "none" }
          : {};
    const def = graph(
      [
        node("trigger", "trigger_pr_created", { scope: "any" }),
        node("unsafe", unsafeType, params),
      ],
      [{ from: "trigger", to: "unsafe" }],
    );
    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `scope:any trigger "trigger" reaches unsafe block "unsafe" (${unsafeType})`,
        ),
      ]),
    );
  });

  it("rejects scope:any repository checks even after workspace preparation", () => {
    const def = graph(
      [
        node("trigger", "trigger_pr_created", { scope: "any" }),
        node("prepare", "prepare_workspace"),
        node("checks", "run_checks"),
      ],
      [
        { from: "trigger", to: "prepare" },
        { from: "prepare", to: "checks" },
      ],
    );

    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toContain(
      'scope:any trigger "trigger" reaches unsafe block "checks" (run_checks).',
    );
  });

  it("allows only workflow-owned merged triggers to reach ticket transitions", () => {
    const owned = graph(
      [
        node("merged", "trigger_pr_merged", { scope: "workflow_owned" }),
        node("status", "update_ticket_status", { target: "10042" }),
      ],
      [{ from: "merged", to: "status" }],
    );
    const arbitrary = graph(
      [
        node("merged", "trigger_pr_merged", { scope: "any" }),
        node("status", "update_ticket_status", { target: "10042" }),
      ],
      [{ from: "merged", to: "status" }],
    );

    expect(validateWorkflowDefinitionForDeployment(owned, registryContext)).toEqual([]);
    expect(validateWorkflowDefinitionForDeployment(arbitrary, registryContext)).toContain(
      'scope:any trigger "merged" reaches unsafe block "status" (update_ticket_status).',
    );
  });

  it("rejects malformed declared output schemas even when environment checks are skipped", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("generate", "generic_agent", {
          prompt: "generate",
          outputSchema: '{"type":"made-up"}',
        }),
      ],
      [{ from: "t", to: "generate" }],
    );

    expect(
      validateWorkflowDefinitionForDeployment(def, registryContext, {
        checkEnvironmentAvailability: false,
      }),
    ).toEqual(
      expect.arrayContaining([
        'Block "generate" (generic_agent) is unavailable: outputSchema has unsupported type "made-up".',
      ]),
    );
  });

  it("requires closed nested objects for new deployments but loads legacy v1 snapshots", () => {
    const def = graph(
      [
        node("t", "trigger_ticket_ai"),
        node("classify", "call_llm", {
          prompt: "classify",
          outputSchema: JSON.stringify({
            type: "object",
            properties: {
              nested: {
                type: "object",
                properties: { state: { type: "string" } },
              },
            },
            required: ["nested"],
            additionalProperties: false,
          }),
        }),
      ],
      [{ from: "t", to: "classify" }],
    );

    expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual([
      expect.stringContaining(
        "outputSchema.properties.nested must set additionalProperties to false.",
      ),
    ]);
    expect(
      validateWorkflowDefinitionForDeployment(def, registryContext, {
        allowLegacyCompatibility: true,
      }),
    ).toEqual([]);
  });

  it.each(["contains.dot", "has space", "1leading", "__proto__"])(
    "keeps stored block id %j loadable but rejects it for deployment",
    (unsafeId) => {
      const def = graph(
        [node("t", "trigger_ticket_ai"), node(unsafeId, "planning_agent")],
        [{ from: "t", to: unsafeId }],
      );

      expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
      expect(upgradeStoredWorkflowDefinition(def).nodes[1]?.id).toBe(unsafeId);
      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`Block id "${unsafeId}" is not addressable`),
        ]),
      );
    },
  );

  it.each(["release.tag", "release tag", "1release", "__proto__"])(
    "rejects declared output field %j because bindings cannot address it",
    (unsafeField) => {
      const def = graph(
        [
          node("t", "trigger_ticket_ai"),
          node("generate", "generic_agent", {
            prompt: "generate",
            outputSchema: JSON.stringify({
              type: "object",
              properties: { [unsafeField]: { type: "string" } },
              required: [unsafeField],
              additionalProperties: false,
            }),
          }),
        ],
        [{ from: "t", to: "generate" }],
      );

      expect(validateWorkflowDefinitionForDeployment(def, registryContext)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`property "${unsafeField}" is not addressable`),
        ]),
      );
    },
  );

});

describe("workflowDefinitionSchema prompt param and promptRefs", () => {
  // A raw node carrying promptRefs, on a non-agent block, to prove promptRefs
  // lives on the shared base fields rather than any one param schema.
  const withRefs = (promptRefs: unknown) => ({
    id: "n",
    type: "open_pr",
    x: 0,
    y: 0,
    params: {},
    promptRefs,
  });

  it("accepts a legacy node without prompt or promptRefs (agent and non-agent)", () => {
    expect(shapeOk([node("p", "planning_agent")])).toBe(true);
    expect(shapeOk([node("o", "open_pr")])).toBe(true);
  });

  it("accepts a prompt param on every agent block and bounds its length", () => {
    for (const type of ["planning_agent", "implementation_agent", "review_agent"] as const) {
      expect(shapeOk([node("n", type, { prompt: "Follow the house style." })]), type).toBe(true);
      // The cap aligns with the prompt library body max so any library prompt
      // can be inserted as an agent override. 50000 passes post-trim; 50001 fails.
      expect(shapeOk([node("n", type, { prompt: "x".repeat(50000) })]), type).toBe(true);
      expect(shapeOk([node("n", type, { prompt: "x".repeat(50001) })]), type).toBe(false);
    }
  });

  it("keeps agent params strict against unknown keys", () => {
    for (const type of ["planning_agent", "implementation_agent", "review_agent"] as const) {
      expect(shapeOk([node("n", type, { prompt: "p", bogus: 1 })]), type).toBe(false);
    }
  });

  it("accepts promptRefs on any block type, with and without insertedHash", () => {
    expect(shapeOk([withRefs({ prompt: { promptId: 1, version: 2 } })])).toBe(true);
    expect(
      shapeOk([withRefs({ prompt: { promptId: 1, version: 2, insertedHash: "0a1b2c3d" } })]),
    ).toBe(true);
    // Agent block, alongside a prompt param.
    expect(
      shapeOk([
        {
          id: "p",
          type: "planning_agent",
          x: 0,
          y: 0,
          params: { prompt: "p" },
          promptRefs: { prompt: { promptId: 1, version: 2 } },
        },
      ]),
    ).toBe(true);
  });

  it("rejects malformed promptRefs entries", () => {
    // Non-integer, zero, or negative promptId / version.
    expect(shapeOk([withRefs({ prompt: { promptId: 1.5, version: 2 } })])).toBe(false);
    expect(shapeOk([withRefs({ prompt: { promptId: 0, version: 2 } })])).toBe(false);
    expect(shapeOk([withRefs({ prompt: { promptId: -1, version: 2 } })])).toBe(false);
    expect(shapeOk([withRefs({ prompt: { promptId: 1, version: 2.5 } })])).toBe(false);
    expect(shapeOk([withRefs({ prompt: { promptId: 1, version: 0 } })])).toBe(false);
    expect(shapeOk([withRefs({ prompt: { promptId: 1, version: -1 } })])).toBe(false);
    // Extra keys inside a ref are rejected (strict).
    expect(shapeOk([withRefs({ prompt: { promptId: 1, version: 2, extra: 1 } })])).toBe(false);
    // An empty-string record key is rejected.
    expect(shapeOk([withRefs({ "": { promptId: 1, version: 2 } })])).toBe(false);
  });

  it("validateWorkflowGraph is indifferent to the prompt param and promptRefs", () => {
    const def = clone(defaultWorkflowDefinition({ includeReview: true }));
    const planning = def.nodes.find((n: WorkflowDefinitionNode) => n.type === "planning_agent");
    planning.params.prompt = "Follow the house style.";
    planning.promptRefs = { prompt: { promptId: 1, version: 2, insertedHash: "0a1b2c3d" } };
    expect(workflowDefinitionSchema.safeParse(def).success).toBe(true);
    expect(validateWorkflowGraph(def)).toEqual([]);
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
    validateWorkflowDefinitionIssuesForDeployment(
      webhookDefinition(configuration),
      registryContext,
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
      validateWorkflowDefinitionForDeployment(webhookDefinition({}), {
        ...registryContext,
        webhookTriggerConfigured: false,
      }),
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
    validateWorkflowDefinitionIssuesForDeployment(
      scheduleDefinition(configuration),
      registryContext,
    ).filter((issue) => issue.code === "invalid_configuration");

  const deploymentIssues = (configuration: Record<string, JsonValue>) =>
    validateWorkflowDefinitionForDeployment(scheduleDefinition(configuration), registryContext);

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
    validateWorkflowDefinitionIssuesForDeployment(
      scheduleDefinition(configuration),
      registryContext,
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
    validateWorkflowDefinitionIssuesForDeployment(definition, registryContext).filter(
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
      validateWorkflowDefinitionIssuesForDeployment(definition, registryContext).filter(
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
