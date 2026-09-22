import { describe, expect, it } from "vitest";
import type { RunDetail, RunStep } from "@shared/contracts";
import { MESSAGE_MAX_LENGTH } from "@shared/workflow-graph";

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
  prs: null,
  model: "model",
  createdAt: "2026-07-23T10:00:00.000Z",
  startedAt: "2026-07-23T10:00:00.000Z",
  completedAt: "2026-07-23T10:00:01.000Z",
  durationSec: 1,
  usageRecorded: true,
  error: {
    message:
      "Error: failed for person@example.com with Bearer secret-token-value\n    at run (/srv/private.ts:4:2)",
    stack: "RAW_STACK",
    code: "INTERNAL_PROVIDER_CODE",
  },
  deploymentId: "dpl_1",
};
const STEP_DIAGNOSTIC_ID = "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-review-1";
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
    // A whole well-formed ID, as createWorkflowExecutionErrorState emits:
    // prefix + run id + node id + attempt. The previous "AIW-DIAG-123" fixture
    // was a shorthand no code path can produce, and it no longer passes the
    // shape check that keeps a smuggled token out of `code`.
    message: `${STEP_DIAGNOSTIC_ID} leaked person@example.com`,
    stack: "STEP_STACK",
    code: STEP_DIAGNOSTIC_ID,
  },
};

/** No configured secret in play: these cases are about stacks, IDs and bounds. */
const NO_SECRETS: readonly string[] = [];

describe("sanitizeRunDetailForResponse", () => {
  it("drops raw stacks and redacts legacy run and step errors", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
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
    expect(sanitized.steps[0]?.error?.code).toBe(STEP_DIAGNOSTIC_ID);
  });

  it("does not mutate the collector result", () => {
    sanitizeRunDetailForResponse({ secrets: NO_SECRETS, run, steps: [step] });
    expect(run.error?.stack).toBe("RAW_STACK");
    expect(step.error?.stack).toBe("STEP_STACK");
  });

  it("synthesizes a cause for a failed run that recorded none", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, error: null },
      steps: [],
    });
    expect(sanitized.run.error?.message).toBe(
      "This run failed, but no specific reason was recorded. Check the worker logs for run wrun_1.",
    );
  });

  it("synthesizes a cause for a blocked run that recorded none", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, status: "blocked", error: null },
      steps: [],
    });
    expect(sanitized.run.error?.message).toBe(
      "This run was stopped before it finished, but no specific reason was recorded. Check the worker logs for run wrun_1.",
    );
  });

  it("leaves a non-terminal run without a synthesized error", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, status: "running", error: null },
      steps: [],
    });
    expect(sanitized.run.error).toBeNull();
  });

  it("keeps a recorded reason instead of the fallback", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, error: { message: "Run stopped on budget: cost 5 exceeds limit 3" } },
      steps: [],
    });
    expect(sanitized.run.error?.message).toBe(
      "Run stopped on budget: cost 5 exceeds limit 3",
    );
  });

  it("hands the browser the whole composed failure message, cause included", () => {
    // Exactly what a failed publish stores in run.error today. The boundary
    // re-sanitizes it, and at the detail-snippet bound that second pass cut the
    // message mid-cause; a composed message gets the message bound instead.
    const message =
      "An external service could not complete this block. " +
      "(github:Blazity/ai-workflow-prod: canonical clone failed: Clon [...] " +
      "s://github.com/Blazity/ai-workflow-prod.git/': The requested URL returned error: 403) " +
      "Diagnostic ID: AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1";
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, error: { message } },
      steps: [],
    });

    expect(sanitized.run.error?.message).toContain(
      "The requested URL returned error: 403",
    );
    expect(sanitized.run.error?.message).toContain(
      "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1",
    );
    expect(sanitized.run.error?.code).toBe(
      "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1",
    );
  });

  it("takes the run's own trailing diagnostic ID when the tail quotes an inner one", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: {
        ...run,
        error: {
          message:
            "A block input could not be resolved. (upstream said: failed Diagnostic ID: AIW-DIAG-old-run-node-7) " +
            "Diagnostic ID: AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1",
        },
      },
      steps: [],
    });

    expect(sanitized.run.error?.code).toBe(
      "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1",
    );
  });

  it("never lets a smuggled diagnostic ID carry a secret into code", () => {
    // `code` reaches the browser without passing through redaction, so this is
    // the same bypass as the failure-message exemption, one field over: reading
    // the raw message would hand back through `code` exactly what the sanitizer
    // just stripped from `message`.
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj";
    for (const smuggled of [
      `AIW-DIAG-${secret}`,
      `AIW-DIAG-${secret}-1`,
      `AIW-DIAG-${secret}-notanattempt`,
      `AIW-DIAG-${secret}.9`,
    ]) {
      const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
        run: {
          ...run,
          error: { message: `Publish failed. Diagnostic ID: ${smuggled}` },
        },
        steps: [],
      });
      expect(JSON.stringify(sanitized), smuggled).not.toContain(secret);
      expect(sanitized.run.error?.code, smuggled).toBeUndefined();
    }
  });

  it("never reports a code the sanitized message does not itself contain", () => {
    // Isolates the SOURCE from the shape check. This ID is well-formed, so
    // validation alone would happily admit it; it is only absent from `code`
    // because the extraction reads the sanitized message, where the clamp has
    // elided the middle. Reading normalized.message would still find it.
    const id = "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1";
    // PADDED FROM THE BOUND, NOT FROM A NUMBER THAT USED TO EXCEED IT. This
    // fixture was written as a fixed 60 words of padding, which cleared the
    // bound of the day; raising that bound left the message unclamped, so the
    // id survived, and the test stopped exercising elision at all while still
    // reading as a test about it. Deriving both halves from the constant means
    // the next person to move the bound moves this with it.
    const pad = "pad ".repeat(Math.ceil(MESSAGE_MAX_LENGTH / 4));
    const buried = `Publish failed. ${pad}Diagnostic ID: ${id} ${pad}`;
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, error: { message: buried } },
      steps: [],
    });

    expect(buried).toContain(id);
    // The precondition this test rests on, asserted rather than assumed: the
    // message really was clamped. Without it the two assertions below can both
    // pass on a message nothing ever elided.
    expect(buried.length).toBeGreaterThan(MESSAGE_MAX_LENGTH);
    expect(sanitized.run.error?.message?.length ?? 0).toBeLessThanOrEqual(MESSAGE_MAX_LENGTH);
    expect(sanitized.run.error?.message).not.toContain(id);
    expect(sanitized.run.error?.code).toBeUndefined();
  });

  it("does not let a configured environment secret reach code through the raw message", () => {
    // sanitizeReplayValue redacts configured secrets by exact value, whatever
    // their shape, and it runs only on the path that produces `message`.
    // Extracting from normalized.message skips that layer entirely, so a secret
    // shaped like a diagnostic ID would pass the shape check and be echoed.
    const secretShapedLikeAnId = "AIW-DIAG-wrun_01SECRETRUNIDVALUE000000000-node-1";
    const sanitized = sanitizeRunDetailForResponse({
      run: {
        ...run,
        error: { message: `Publish failed. Diagnostic ID: ${secretShapedLikeAnId}` },
      },
      steps: [],
      secrets: [secretShapedLikeAnId],
    });
    expect(JSON.stringify(sanitized)).not.toContain("01SECRETRUNIDVALUE");
    expect(sanitized.run.error?.code).toBeUndefined();
  });

  it("drops a malformed code rather than echoing or truncating it", () => {
    const sanitized = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: {
        ...run,
        error: { message: "Publish failed.", code: "AIW-DIAG-123" },
      },
      steps: [],
    });
    expect(sanitized.run.error?.code).toBeUndefined();
    expect(sanitized.run.error?.message).toBe("Publish failed.");
  });

  it("still admits a real diagnostic ID from either the code field or the message", () => {
    const id = "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1";
    const fromCode = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, error: { message: "Publish failed.", code: id } },
      steps: [],
    });
    expect(fromCode.run.error?.code).toBe(id);

    const fromMessage = sanitizeRunDetailForResponse({ secrets: NO_SECRETS,
      run: { ...run, error: { message: `Publish failed. Diagnostic ID: ${id}` } },
      steps: [],
    });
    expect(fromMessage.run.error?.code).toBe(id);
  });

  it("redacts even short configured secrets", () => {
    const sanitized = sanitizeRunDetailForResponse({
      run: {
        ...run,
        error: { message: "provider echoed q7! exactly" },
      },
      steps: [],
      secrets: ["q7!"],
    });
    expect(sanitized.run.error?.message).not.toContain("q7!");
  });
});
