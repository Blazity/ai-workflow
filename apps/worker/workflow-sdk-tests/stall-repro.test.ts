import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getHookByToken, resumeHook, start } from "workflow/api";
import { WorkflowRunFailedError } from "workflow/errors";
import { parseStepName } from "workflow/observability";
import { getWorld } from "workflow/runtime";
import {
  probeHookResumeBindingStall,
  probeResumeBindingStall,
  probeUnserializableStepErrorStall,
} from "../workflow-test-fixtures/stall-repro/workflow.js";

async function waitForHook(token: string): Promise<{ runId: string }> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await getHookByToken(token);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw lastError ?? new Error(`hook ${token} was not registered`);
}

async function expectDiagnosticFailure(
  run: { returnValue: Promise<unknown>; runId: string },
  expectedDetail: string,
): Promise<void> {
  let failure: unknown;
  try {
    await run.returnValue;
  } catch (error) {
    failure = error;
  }

  expect(WorkflowRunFailedError.is(failure)).toBe(true);
  if (!WorkflowRunFailedError.is(failure)) throw failure;
  expect(failure.cause.message).toContain("Diagnostic ID: AIW-DIAG-");
  expect(failure.cause.message).toContain(expectedDetail);

  const steps = await getWorld().steps.list({
    runId: run.runId,
    resolveData: "none",
  });
  const shortNames = steps.data.map(
    (step) => parseStepName(step.stepName)?.shortName,
  );
  // The interpreter's recordExecutionError must have run its onExecutionError
  // step and the failureExit steps: their absence is the production stall.
  expect(shortNames).toContain("logProbeExecutionErrorStep");
  expect(shortNames).toContain("markProbeRunFailedStep");
  expect(shortNames).toContain("notifyProbeFailureStep");
}

describe("workflow error paths must terminate instead of stalling", () => {
  it("fails the run when a resumed checkpoint hits an unresolvable binding", async () => {
    const run = await start(probeResumeBindingStall, [`stall-${randomUUID()}`]);
    await expectDiagnosticFailure(run, "A block input could not be resolved.");
  });

  it("fails the run when a hook-resumed run hits an unresolvable binding", async () => {
    const token = `clarification:${randomUUID()}`;
    const run = await start(probeHookResumeBindingStall, [token]);

    const hook = await waitForHook(token);
    expect(hook.runId).toBe(run.runId);

    await resumeHook(token, {
      answer: "Use this exact greeting: Hi hi",
      answeredById: "user-1",
      answeredByLabel: "Filip Maszota",
      answeredAt: new Date().toISOString(),
    });

    await expectDiagnosticFailure(run, "A block input could not be resolved.");
  });

  it("fails the run when a step throws an unserializable DOMException", async () => {
    const run = await start(probeUnserializableStepErrorStall, [
      `stall-${randomUUID()}`,
    ]);
    await expectDiagnosticFailure(run, "The block could not be completed.");
  });
});
