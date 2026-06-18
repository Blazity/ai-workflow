import { describe, it, expect, vi } from "vitest";
import {
  collectRunDetail,
  captureRunStepsBestEffort,
  type RunDetailSource,
  type WorkflowRunRecord,
  type WorkflowStepRecord,
} from "./collect-run-detail.js";

const RUN_START = new Date("2026-06-02T11:00:00.000Z");
const AGENT = "workflow//./src/workflows/agent//agentWorkflow";
const STEP = (fn: string) => `step//./src/workflows/agent//${fn}`;

function makeSource(
  run: Partial<WorkflowRunRecord>,
  steps: WorkflowStepRecord[],
): RunDetailSource {
  return {
    runs: {
      get: vi.fn().mockResolvedValue({
        runId: "run_a",
        status: "completed",
        workflowName: AGENT,
        createdAt: RUN_START,
        ...run,
      } satisfies WorkflowRunRecord),
    },
    steps: { list: vi.fn().mockResolvedValue({ data: steps }) },
  };
}

function step(over: Partial<WorkflowStepRecord>): WorkflowStepRecord {
  return {
    stepId: "s",
    stepName: STEP("doThing"),
    status: "completed",
    attempt: 1,
    createdAt: RUN_START,
    ...over,
  };
}

describe("collectRunDetail", () => {
  it("maps the run header and orders steps as a waterfall with offsets/durations", async () => {
    const source = makeSource(
      {
        runId: "run_a",
        status: "completed",
        startedAt: RUN_START,
        completedAt: new Date("2026-06-02T11:05:00.000Z"), // 300s
      },
      [
        // Intentionally out of order — collector sorts by start offset.
        step({
          stepId: "s2",
          stepName: STEP("provisionSandbox"),
          startedAt: new Date("2026-06-02T11:00:10.000Z"), // +10s
          completedAt: new Date("2026-06-02T11:00:25.000Z"), // 15s
        }),
        step({
          stepId: "s1",
          stepName: STEP("fetchAndValidateTicket"),
          startedAt: new Date("2026-06-02T11:00:01.000Z"), // +1s
          completedAt: new Date("2026-06-02T11:00:02.000Z"), // 1s
        }),
      ],
    );

    const { run, steps } = await collectRunDetail({
      world: source,
      model: "claude-opus-4-8",
      runId: "run_a",
    });

    expect(run.status).toBe("success");
    expect(run.workflowName).toBe("Agent");
    expect(run.durationSec).toBe(300);

    expect(steps.map((s) => s.stepId)).toEqual(["s1", "s2"]);
    expect(steps[0]).toMatchObject({
      name: "fetchAndValidateTicket",
      startOffsetMs: 1000,
      durationMs: 1000,
    });
    expect(steps[1]).toMatchObject({
      name: "provisionSandbox",
      startOffsetMs: 10000,
      durationMs: 15000,
    });
  });

  it("leaves duration null for a still-running step and maps its status", async () => {
    const source = makeSource(
      { runId: "run_b", status: "running", startedAt: RUN_START },
      [step({ stepId: "s1", status: "running", startedAt: RUN_START })],
    );

    const { run, steps } = await collectRunDetail({
      world: source,
      model: "m",
      runId: "run_b",
    });

    expect(run.status).toBe("running");
    expect(run.durationSec).toBeNull();
    expect(steps[0].status).toBe("running");
    expect(steps[0].durationMs).toBeNull();
  });

  it("normalizes a string run error and leaves the ticket empty for the route to enrich", async () => {
    const source = makeSource(
      { runId: "run_c", status: "failed", error: "boom" },
      [],
    );

    const { run } = await collectRunDetail({
      world: source,
      model: "m",
      runId: "run_c",
    });

    expect(run.status).toBe("failed");
    expect(run.error).toEqual({ message: "boom" });
    // The world has no ticket (encrypted input); the route backfills it from
    // the durable workflow_runs row.
    expect(run.ticket).toBe("");
    expect(run.ticketTitle).toBe("");
    expect(run.ticketUrl).toBe("");
  });
});

describe("captureRunStepsBestEffort", () => {
  it("returns the mapped step waterfall", async () => {
    const source = makeSource({ runId: "run_a", startedAt: RUN_START }, [
      step({
        stepId: "s1",
        stepName: STEP("provisionSandbox"),
        startedAt: RUN_START,
        completedAt: new Date("2026-06-02T11:00:15.000Z"),
      }),
    ]);
    const steps = await captureRunStepsBestEffort(source, "run_a");
    expect(steps?.map((s) => s.name)).toEqual(["provisionSandbox"]);
  });

  it("returns null when the world throws", async () => {
    const source: RunDetailSource = {
      runs: { get: vi.fn().mockRejectedValue(new Error("expired")) },
      steps: { list: vi.fn().mockResolvedValue({ data: [] }) },
    };
    expect(await captureRunStepsBestEffort(source, "run_a")).toBeNull();
  });
});
