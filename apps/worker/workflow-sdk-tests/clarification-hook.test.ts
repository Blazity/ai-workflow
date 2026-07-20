import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getHookByToken, resumeHook, start } from "workflow/api";
import { probeClarificationHook } from "../workflow-test-fixtures/clarification-hook/workflow.js";

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

describe("installed Workflow clarification hook boundary", () => {
  it("suspends with local state and resumes the same run once", async () => {
    const token = `clarification:${randomUUID()}`;
    const state = {
      completedBlocks: ["plan", "prepare"],
      definitionVersion: 7,
    };
    const run = await start(probeClarificationHook, [token, state]);

    const hook = await waitForHook(token);
    expect(hook.runId).toBe(run.runId);

    const resumed = await resumeHook(token, { answer: "Use the API repository." });
    expect(resumed.runId).toBe(run.runId);
    await expect(run.returnValue).resolves.toEqual({
      status: "resumed",
      answer: "Use the API repository.",
      state,
    });

    await expect(resumeHook(token, { answer: "duplicate" })).rejects.toThrow();
  });

  it("reports the active owner when a deterministic token conflicts", async () => {
    const token = `clarification:${randomUUID()}`;
    const state = { completedBlocks: ["plan"], definitionVersion: 3 };
    const owner = await start(probeClarificationHook, [token, state]);

    await waitForHook(token);
    const contender = await start(probeClarificationHook, [token, state]);

    await expect(contender.returnValue).resolves.toEqual({
      status: "conflict",
      conflictingRunId: owner.runId,
    });

    await resumeHook(token, { answer: "continue" });
    await expect(owner.returnValue).resolves.toMatchObject({
      status: "resumed",
      answer: "continue",
    });
  });
});
