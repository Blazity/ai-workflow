import { describe, it, expect, vi } from "vitest";
import type { RunDetail, RunStatus, RunStep } from "@shared/contracts";
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
  prs: null,
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
const parts = (
  hasRealSteps: boolean,
  status: RunStatus = "success",
): RunDetailParts => ({
  run: { ...RUN("db"), status },
  steps: STEPS("db"),
  hasRealSteps,
});
const runningWorld = async () => ({
  run: { ...RUN("world"), status: "running" as const },
  steps: STEPS("world"),
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

  it("reports awaiting when the durable row is parked and the world says running", async () => {
    const res = await resolveRunDetail({
      dbDetail: parts(false, "awaiting"),
      loadWorld: runningWorld,
    });
    expect(res?.run.status).toBe("awaiting");
    expect(res?.run.id).toBe("world");
    expect(res?.steps[0].name).toBe("world");
  });

  it.each(["success", "failed", "blocked"] as const)(
    "keeps the settled world status %s even when the durable row is awaiting",
    async (status) => {
      const res = await resolveRunDetail({
        dbDetail: parts(false, "awaiting"),
        loadWorld: async () => ({
          run: { ...RUN("world"), status },
          steps: STEPS("world"),
        }),
      });
      expect(res?.run.status).toBe(status);
      expect(res?.steps[0].name).toBe("world");
    },
  );

  it.each(["running", "success", "failed"] as const)(
    "keeps the world status when the durable row is %s",
    async (status) => {
      const res = await resolveRunDetail({
        dbDetail: parts(false, status),
        loadWorld: runningWorld,
      });
      expect(res?.run.status).toBe("running");
      expect(res?.steps[0].name).toBe("world");
    },
  );

  it("keeps the world status when there is no durable row", async () => {
    const res = await resolveRunDetail({
      dbDetail: null,
      loadWorld: runningWorld,
    });
    expect(res?.run.status).toBe("running");
    expect(res?.steps[0].name).toBe("world");
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
