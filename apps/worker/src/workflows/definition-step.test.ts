import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";

vi.mock("../../env.js", () => ({ env: { ENABLE_REVIEW_PHASE: false } }));
vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetCurrentVersion = vi.fn();
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getCurrentWorkflowDefinitionVersion: (...args: unknown[]) => mockGetCurrentVersion(...args),
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

import { loadWorkflowDefinition, loadWorkflowDefinitionFor } from "./definition-step.js";
import { defaultWorkflowDefinition } from "../workflow-definition/default.js";

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
