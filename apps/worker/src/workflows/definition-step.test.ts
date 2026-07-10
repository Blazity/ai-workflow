import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowDefinition } from "@shared/contracts";

vi.mock("../../env.js", () => ({ env: { ENABLE_REVIEW_PHASE: false } }));
vi.mock("../db/client.js", () => ({ getDb: vi.fn(() => ({})) }));

const mockGetCurrent = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getCurrentWorkflowDefinition: (...args: unknown[]) => mockGetCurrent(...args),
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

import { loadWorkflowDefinition } from "./definition-step.js";
import { defaultWorkflowDefinition } from "../workflow-definition/default.js";

async function setEnv(partial: Record<string, unknown>) {
  const mod = (await import("../../env.js")) as unknown as { env: Record<string, unknown> };
  mod.env = { ...mod.env, ...partial };
}

function row(definition: WorkflowDefinition, version = 3) {
  return {
    version,
    definition,
    createdAt: new Date(),
    createdById: "u1",
    createdByLabel: "User One",
    restoredFromVersion: null,
  };
}

describe("loadWorkflowDefinition", () => {
  beforeEach(async () => {
    mockGetCurrent.mockReset();
    loggerError.mockReset();
    loggerInfo.mockReset();
    await setEnv({ ENABLE_REVIEW_PHASE: false });
  });

  it("falls back to the default blocks (no review) when there is no row", async () => {
    mockGetCurrent.mockResolvedValue(null);
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.reviewEnabled).toBe(false);
    expect(plan.blocks.map((b) => b.type)).toEqual([
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
    mockGetCurrent.mockResolvedValue(null);
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.reviewEnabled).toBe(true);
    expect(plan.blocks.some((b) => b.type === "review_agent")).toBe(true);
  });

  it("uses the stored definition (ordered) when the row is valid", async () => {
    mockGetCurrent.mockResolvedValue(row(defaultWorkflowDefinition({ includeReview: true }), 7));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBe(7);
    expect(plan.reviewEnabled).toBe(true);
    expect(plan.blocks.map((b) => b.type)).toEqual([
      "planning_agent",
      "implementation_agent",
      "review_agent",
      "run_pre_pr_checks",
      "open_pr",
      "send_slack_message",
      "update_ticket_status",
    ]);
    expect(loggerError).not.toHaveBeenCalled();
  });

  it("reflects reviewEnabled=false for a valid stored definition without a review block", async () => {
    mockGetCurrent.mockResolvedValue(row(defaultWorkflowDefinition({ includeReview: false }), 4));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBe(4);
    expect(plan.reviewEnabled).toBe(false);
  });

  it("falls back to the default and logs an error when the row fails schema validation", async () => {
    mockGetCurrent.mockResolvedValue(
      row({ schemaVersion: 2, nodes: [], edges: [] } as unknown as WorkflowDefinition, 9),
    );
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(plan.blocks.length).toBeGreaterThan(0);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 9 });
  });

  it("falls back to the default and logs an error when the graph is invalid", async () => {
    const triggerOnly: WorkflowDefinition = {
      schemaVersion: 1,
      nodes: [{ id: "t", type: "trigger_ticket_ai", x: 0, y: 0, params: {} }],
      edges: [],
    };
    mockGetCurrent.mockResolvedValue(row(triggerOnly, 12));
    const plan = await loadWorkflowDefinition();
    expect(plan.version).toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0][0]).toMatchObject({ version: 12 });
  });
});
