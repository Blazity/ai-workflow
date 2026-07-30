import { describe, expect, it } from "vitest";
import type { RunDetail, RunStep } from "@shared/contracts";

import { sanitizeRunDetailForResponse } from "./sanitize-run-detail.js";

const run: RunDetail = {
  id: "wrun_1",
  workflow: "wf",
  workflowName: "Workflow",
  status: "failed",
  ticket: "AIW-134",
  ticketTitle: "Replay",
  ticketUrl: "",
  prNumber: null,
  prUrl: null,
  model: "model",
  createdAt: "2026-07-23T10:00:00.000Z",
  startedAt: "2026-07-23T10:00:00.000Z",
  completedAt: "2026-07-23T10:00:01.000Z",
  durationSec: 1,
  error: {
    message:
      "Error: failed for person@example.com with Bearer secret-token-value\n    at run (/srv/private.ts:4:2)",
    stack: "RAW_STACK",
    code: "INTERNAL_PROVIDER_CODE",
  },
  deploymentId: "dpl_1",
};
const step: RunStep = {
  stepId: "step_1",
  name: "Review",
  rawName: "reviewStep",
  status: "failed",
  attempt: 1,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  startOffsetMs: 0,
  durationMs: 1000,
  error: {
    message: "AIW-DIAG-123 leaked person@example.com",
    stack: "STEP_STACK",
    code: "AIW-DIAG-123",
  },
};

describe("sanitizeRunDetailForResponse", () => {
  it("drops raw stacks and redacts legacy run and step errors", () => {
    const sanitized = sanitizeRunDetailForResponse({
      run,
      steps: [step],
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("RAW_STACK");
    expect(serialized).not.toContain("STEP_STACK");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("/srv/private.ts");
    expect(sanitized.run.error?.code).toBeUndefined();
    expect(sanitized.steps[0]?.error?.code).toBe("AIW-DIAG-123");
  });

  it("does not mutate the collector result", () => {
    sanitizeRunDetailForResponse({ run, steps: [step] });
    expect(run.error?.stack).toBe("RAW_STACK");
    expect(step.error?.stack).toBe("STEP_STACK");
  });

  it("synthesizes a cause for a failed run that recorded none", () => {
    const sanitized = sanitizeRunDetailForResponse({
      run: { ...run, error: null },
      steps: [],
    });
    expect(sanitized.run.error?.message).toBe(
      "This run failed, but no specific reason was recorded. Check the worker logs for run wrun_1.",
    );
  });

  it("synthesizes a cause for a blocked run that recorded none", () => {
    const sanitized = sanitizeRunDetailForResponse({
      run: { ...run, status: "blocked", error: null },
      steps: [],
    });
    expect(sanitized.run.error?.message).toBe(
      "This run was stopped before it finished, but no specific reason was recorded. Check the worker logs for run wrun_1.",
    );
  });

  it("leaves a non-terminal run without a synthesized error", () => {
    const sanitized = sanitizeRunDetailForResponse({
      run: { ...run, status: "running", error: null },
      steps: [],
    });
    expect(sanitized.run.error).toBeNull();
  });

  it("keeps a recorded reason instead of the fallback", () => {
    const sanitized = sanitizeRunDetailForResponse({
      run: { ...run, error: { message: "Run stopped on budget: cost 5 exceeds limit 3" } },
      steps: [],
    });
    expect(sanitized.run.error?.message).toBe(
      "Run stopped on budget: cost 5 exceeds limit 3",
    );
  });

  it("redacts even short configured environment secrets", () => {
    const prior = process.env.AIW_TEST_REPLAY_SECRET;
    process.env.AIW_TEST_REPLAY_SECRET = "q7!";
    try {
      const sanitized = sanitizeRunDetailForResponse({
        run: {
          ...run,
          error: { message: "provider echoed q7! exactly" },
        },
        steps: [],
      });
      expect(sanitized.run.error?.message).not.toContain("q7!");
    } finally {
      if (prior === undefined) {
        delete process.env.AIW_TEST_REPLAY_SECRET;
      } else {
        process.env.AIW_TEST_REPLAY_SECRET = prior;
      }
    }
  });
});
