import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";

vi.mock("../../env.js", () => ({ env: { ENABLE_REVIEW_PHASE: false } }));
vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetCurrentVersion = vi.fn();
const mockGetVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: unknown[]) => mockGetCurrentVersion(...args),
  getWorkflowDefinitionVersion: (...args: unknown[]) => mockGetVersion(...args),
  getEnabledWorkflowDefinitionForTrigger: (...args: unknown[]) => mockGetEnabled(...args),
}));

const loggerError = vi.fn();
const loggerInfo = vi.fn();
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfo(...a),
    warn: vi.fn(),
    error: (...a: unknown[]) => loggerError(...a),
  },
}));

import {
  loadWorkflowDefinition,
  loadWorkflowDefinitionFor,
  normalizeDefinitionForExecution,
} from "./definition-step.js";
import { defaultWorkflowDefinition } from "../workflow-definition/default.js";
import type { WorkflowDefinitionEdge, WorkflowDefinitionNode } from "@shared/contracts";

async function setEnv(partial: Record<string, unknown>) {
  const mod = (await import("../../env.js")) as unknown as { env: Record<string, unknown> };
  mod.env = { ...mod.env, ...partial };
}

function row(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return {
    definitionId,
    version,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  };
}

/** Wraps a version row as the enabled-definition lookup result. */
function enabled(definition: WorkflowDefinition, version = 3, definitionId = 1) {
  return { definition: { id: definitionId }, current: row(definition, version, definitionId) };
}

describe("loadWorkflowDefinition", () => {
  beforeEach(async () => {
    mockGetCurrentVersion.mockReset();
    mockGetVersion.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    await setEnv({ ENABLE_REVIEW_PHASE: false });
  });

  it("falls back to the default nodes (no review) when there is no enabled definition", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.definitionId).toBeNull();
    expect(plan.reviewEnabled).toBe(false);
    expect(plan.nodes.map((n) => n.type)).toEqual([
      "trigger_ticket_ai",
      "prepare_workspace",
      "planning_agent",
      "implementation_agent",
      "run_pre_pr_checks",
      "open_pr",
      "send_slack_message",
      "update_ticket_status",
    ]);
  });

  it("includes the review block in the default when ENABLE_REVIEW_PHASE is on", async () => {
    await setEnv({ ENABLE_REVIEW_PHASE: true });
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.definitionId).toBeNull();
    expect(plan.reviewEnabled).toBe(true);
    expect(plan.nodes.some((n) => n.type === "review_agent")).toBe(true);
  });

  it("uses the enabled definition matched by trigger type when the row is valid", async () => {
    mockGetEnabled.mockResolvedValue(enabled(defaultWorkflowDefinition({ includeReview: true }), 7, 3));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBe(7);
    expect(plan.definitionId).toBe(3);
    expect(plan.reviewEnabled).toBe(true);
    expect(plan.nodes.map((n) => n.type)).toEqual([
      "trigger_ticket_ai",
      "prepare_workspace",
      "planning_agent",
      "implementation_agent",
      "review_agent",
      "run_pre_pr_checks",
      "open_pr",
      "send_slack_message",
      "update_ticket_status",
    ]);
    expect(mockGetEnabled).toHaveBeenCalledWith(expect.anything(), "trigger_ticket_ai");
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("reflects reviewEnabled=false for a valid stored definition without a review block", async () => {
    mockGetEnabled.mockResolvedValue(enabled(defaultWorkflowDefinition({ includeReview: false }), 4, 2));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBe(4);
    expect(plan.definitionId).toBe(2);
    expect(plan.reviewEnabled).toBe(false);
  });

  it("falls back to the default and logs an error when the row fails schema validation", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinition, 9, 5),
    );
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.definitionId).toBeNull();
    expect(plan.nodes.length).toBeGreaterThan(0);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 9, definitionId: 5 });
  });

  it("falls back to the default and logs an error when the graph is invalid", async () => {
    const invalidGraph: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [
        { id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {} },
        { id: "p", type: "planning_agent", x: 0, y: 0, params: {} },
      ],
      edges: [],
    };
    mockGetEnabled.mockResolvedValue(enabled(invalidGraph, 12, 6));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.definitionId).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 12, definitionId: 6 });
  });
});

describe("loadWorkflowDefinitionFor", () => {
  beforeEach(async () => {
    mockGetCurrentVersion.mockReset();
    mockGetVersion.mockReset();
    mockGetEnabled.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    await setEnv({ ENABLE_REVIEW_PHASE: true });
  });

  it("loads a pinned definition by id", async () => {
    mockGetCurrentVersion.mockResolvedValue(row(defaultWorkflowDefinition({ includeReview: true }), 3, 55));
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai", 55);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(3);
    expect(plan!.definitionId).toBe(55);
    expect(mockGetCurrentVersion).toHaveBeenCalledWith(expect.anything(), 55);
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("loads the pinned version when an explicit version is given", async () => {
    mockGetVersion.mockResolvedValue(row(defaultWorkflowDefinition({ includeReview: true }), 4, 55));
    const plan = await loadWorkflowDefinitionFor("trigger_plan_approved", 55, 4);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBe(4);
    expect(plan!.definitionId).toBe(55);
    expect(mockGetVersion).toHaveBeenCalledWith(expect.anything(), 55, 4);
    expect(mockGetCurrentVersion).not.toHaveBeenCalled();
  });

  it("returns null when the pinned version is missing for a non-ticket trigger", async () => {
    mockGetVersion.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("trigger_plan_approved", 55, 99);
    expect(plan).toBeNull();
    expect(mockGetVersion).toHaveBeenCalledWith(expect.anything(), 55, 99);
  });

  it("returns null for a non-ticket trigger with no enabled definition", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("planning_agent");
    expect(plan).toBeNull();
  });

  it("falls back to the built-in default for the ticket trigger when the pinned id is missing", async () => {
    mockGetCurrentVersion.mockResolvedValue(null);
    const plan = await loadWorkflowDefinitionFor("trigger_ticket_ai", 999);
    expect(plan).not.toBeNull();
    expect(plan!.version).toBeNull();
    expect(plan!.definitionId).toBeNull();
    expect(plan!.reviewEnabled).toBe(true);
  });
});

describe("normalizeDefinitionForExecution", () => {
  function node(
    id: string,
    type: WorkflowDefinitionNode["type"],
    params: WorkflowDefinitionNode["params"] = {},
  ): WorkflowDefinitionNode {
    return { id, type, x: 0, y: 0, params };
  }

  it("injects a virtual prepare_workspace between the trigger and its successor", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    const edges: WorkflowDefinitionEdge[] = [{ from: "t", to: "p" }];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes.map((n) => n.id)).toEqual(["t", "__prepare", "p"]);
    expect(normalized.nodes[1].type).toBe("prepare_workspace");
    expect(normalized.nodes[1].params).toEqual({});
    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare" },
      { from: "__prepare", to: "p" },
    ]);
    expect(nodes).toHaveLength(2);
    expect(edges).toEqual([{ from: "t", to: "p" }]);
  });

  it("keeps a graph whose explicit prepare_workspace precedes the sandbox block untouched", () => {
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("n1", "prepare_workspace"),
      node("n2", "generic_agent", { prompt: "do it" }),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "n1" },
      { from: "n1", to: "n2" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes).toBe(nodes);
    expect(normalized.edges).toBe(edges);
  });

  it("injects when an explicit prepare_workspace sits AFTER the sandbox block", () => {
    // trigger -> generic_agent -> prepare_workspace: the agent would run with no
    // workspace, so a virtual prepare must still be spliced in before it. A
    // global "any prepare_workspace exists" check would (wrongly) leave this
    // graph untouched.
    const nodes = [
      node("t", "trigger_ticket_ai"),
      node("n2", "generic_agent", { prompt: "do it" }),
      node("n1", "prepare_workspace"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t", to: "n2" },
      { from: "n2", to: "n1" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes.map((n) => n.id)).toEqual(["t", "__prepare", "n2", "n1"]);
    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare" },
      { from: "__prepare", to: "n2" },
      { from: "n2", to: "n1" },
    ]);
  });

  it("auto-prepares a trigger whose chain lacks prepare_workspace even when another trigger's chain has one", () => {
    // Chain A already prepares before its agent; chain B has a sandbox block with
    // no prepare. Only B may be auto-prepared; A must be left untouched.
    const nodes = [
      node("ta", "trigger_ticket_ai"),
      node("pa", "prepare_workspace"),
      node("ga", "generic_agent", { prompt: "do it" }),
      node("tb", "trigger_plan_approved"),
      node("impl", "implementation_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "ta", to: "pa" },
      { from: "pa", to: "ga" },
      { from: "tb", to: "impl" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    const prepares = normalized.nodes.filter((n) => n.type === "prepare_workspace");
    expect(prepares.map((n) => n.id).sort()).toEqual(["__prepare", "pa"]);
    // Chain B gets the virtual prepare spliced between tb and impl.
    expect(normalized.edges).toContainEqual({ from: "tb", to: "__prepare" });
    expect(normalized.edges).toContainEqual({ from: "__prepare", to: "impl" });
    // Chain A's edges are unchanged.
    expect(normalized.edges).toContainEqual({ from: "ta", to: "pa" });
    expect(normalized.edges).toContainEqual({ from: "pa", to: "ga" });
    // No virtual prepare was added to chain A.
    expect(normalized.edges).not.toContainEqual({ from: "ta", to: "__prepare" });
  });

  it("suffixes the virtual id when __prepare is already taken", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("__prepare", "planning_agent")];
    const edges: WorkflowDefinitionEdge[] = [{ from: "t", to: "__prepare" }];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes.map((n) => n.id)).toEqual(["t", "__prepare_", "__prepare"]);
    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare_" },
      { from: "__prepare_", to: "__prepare" },
    ]);
  });

  it("preserves an explicit fromPort on the rewired trigger edge", () => {
    const nodes = [node("t", "trigger_ticket_ai"), node("p", "planning_agent")];
    const edges: WorkflowDefinitionEdge[] = [{ from: "t", to: "p", fromPort: "out" }];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.edges).toEqual([
      { from: "t", to: "__prepare", fromPort: "out" },
      { from: "__prepare", to: "p" },
    ]);
  });

  it("leaves a trigger without a successor alone", () => {
    const nodes = [node("t", "trigger_ticket_ai")];
    const normalized = normalizeDefinitionForExecution(nodes, []);
    expect(normalized.nodes.map((n) => n.id)).toEqual(["t"]);
    expect(normalized.edges).toEqual([]);
  });

  it("injects one virtual node per trigger", () => {
    const nodes = [
      node("t1", "trigger_ticket_ai"),
      node("t2", "trigger_pr_created"),
      node("a", "planning_agent"),
      node("b", "fix_agent"),
    ];
    const edges: WorkflowDefinitionEdge[] = [
      { from: "t1", to: "a" },
      { from: "t2", to: "b" },
    ];

    const normalized = normalizeDefinitionForExecution(nodes, edges);

    expect(normalized.nodes.map((n) => n.id)).toEqual(["t1", "__prepare", "t2", "__prepare_", "a", "b"]);
    expect(normalized.edges).toEqual([
      { from: "t1", to: "__prepare" },
      { from: "__prepare", to: "a" },
      { from: "t2", to: "__prepare_" },
      { from: "__prepare_", to: "b" },
    ]);
  });
});
