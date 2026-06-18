import { describe, it, expect, vi } from "vitest";
import type { RunDetail, RunStep } from "@shared/contracts";
import { resolveRunDetail, type RunDetailParts } from "./resolve-run-detail.js";

const RUN = (id: string): RunDetail => ({
  id,
  workflow: "wf_agent",
  workflowName: "Agent",
  status: "success",
  ticket: "",
  ticketTitle: "",
  ticketUrl: "",
  prNumber: null,
  prUrl: null,
  model: "m",
  createdAt: "2026-06-16T10:00:00Z",
  startedAt: "2026-06-16T10:00:00Z",
  completedAt: "2026-06-16T10:05:00Z",
  durationSec: 300,
  error: null,
  deploymentId: null,
});
const STEPS = (name: string): RunStep[] => [
  {
    stepId: name,
    name,
    rawName: name,
    status: "completed",
    attempt: 1,
    createdAt: "2026-06-16T10:00:00Z",
    startedAt: "2026-06-16T10:00:00Z",
    completedAt: "2026-06-16T10:00:01Z",
    startOffsetMs: 0,
    durationMs: 1000,
    error: null,
  },
];
const parts = (hasRealSteps: boolean): RunDetailParts => ({
  run: RUN("db"),
  steps: STEPS("db"),
  hasRealSteps,
});

describe("resolveRunDetail", () => {
  it("returns persisted steps and never touches the world when hasRealSteps", async () => {
    const loadWorld = vi.fn();
    const res = await resolveRunDetail({ dbDetail: parts(true), loadWorld });
    expect(loadWorld).not.toHaveBeenCalled();
    expect(res?.steps[0].name).toBe("db");
  });

  it("loads the world when there are no real persisted steps", async () => {
    const res = await resolveRunDetail({
      dbDetail: parts(false),
      loadWorld: async () => ({ run: RUN("world"), steps: STEPS("world") }),
    });
    expect(res?.steps[0].name).toBe("world");
  });

  it("falls back to coarse db detail when the world load throws", async () => {
    const res = await resolveRunDetail({
      dbDetail: parts(false),
      loadWorld: async () => {
        throw new Error("expired");
      },
    });
    expect(res?.steps[0].name).toBe("db");
  });

  it("returns null when the world throws and there is no db detail", async () => {
    const res = await resolveRunDetail({
      dbDetail: null,
      loadWorld: async () => {
        throw new Error("expired");
      },
    });
    expect(res).toBeNull();
  });
});
