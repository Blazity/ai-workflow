import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The body of the one step that creates an integration's per-run state.
 *
 * The step is what makes "once per run" survive a suspend, so what it returns
 * is recorded with the run and never recomputed. That makes every decision in
 * its body permanent for the run: whom it asks, with what, and what it records
 * when the answer is not a state. Two fake integrations stand in for real ones:
 * `acmetrace` declares run state, `acmechat` does not.
 */
const resolved = vi.hoisted(() => ({ value: undefined as unknown }));
const beginTrace = vi.hoisted(() => vi.fn());
const beginChat = vi.hoisted(() => vi.fn());

vi.mock("../../services/integrations/runtime.js", () => ({
  resolveUsableIntegrations: async (input: { filter?: (manifest: { id: string }) => boolean }) => {
    const answer = resolved.value as
      | { readable: true; usable: Array<{ manifest: { id: string } }> }
      | { readable: false; reason: string };
    if (!answer.readable) return answer;
    return {
      readable: true,
      usable: answer.usable.filter((entry) => input.filter?.(entry.manifest as never) ?? true),
    };
  },
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// What counts as run control is the helper's decision; the step's job is to
// let whatever it recognises through.
vi.mock("../helpers/run-control-error.js", () => ({
  isRunControlError: (error: unknown) => error instanceof Error && error.name === "RunCancelled",
}));

const { createIntegrationRunStateStep } = await import("./integration-run-state-step.js");

function integrations() {
  return {
    readable: true,
    usable: [
      {
        manifest: { id: "acmetrace", runState: true },
        runtime: { beginRun: beginTrace },
        ctx: { connection: {} },
      },
      {
        manifest: { id: "acmechat" },
        runtime: { beginRun: beginChat },
        ctx: { connection: {} },
      },
    ],
  };
}

const START = { runId: "run-9", subjectKey: "AWT-42" };

beforeEach(() => {
  beginTrace.mockReset();
  beginChat.mockReset();
  resolved.value = integrations();
});

describe("creating one integration's run state", () => {
  it("asks that integration, with the run id and the name of what the run is about", async () => {
    beginTrace.mockResolvedValue({ taskId: "task-7" });

    const outcome = await createIntegrationRunStateStep({ integrationId: "acmetrace", ...START });

    expect(outcome).toEqual({ status: "ready", state: { taskId: "task-7" } });
    expect(beginTrace).toHaveBeenCalledTimes(1);
    expect(beginTrace.mock.calls[0]?.[0]).toEqual({ runId: "run-9", subjectKey: "AWT-42" });
    // Using one integration never creates another's state.
    expect(beginChat).not.toHaveBeenCalled();
  });

  it("never asks an integration that does not declare run state", async () => {
    const outcome = await createIntegrationRunStateStep({ integrationId: "acmechat", ...START });

    expect(outcome).toEqual({ status: "none" });
    expect(beginChat).not.toHaveBeenCalled();
  });

  it("records an integration that is not usable here as having none, without asking", async () => {
    resolved.value = { readable: true, usable: [] };

    expect(await createIntegrationRunStateStep({ integrationId: "acmetrace", ...START })).toEqual({
      status: "none",
    });
    expect(beginTrace).not.toHaveBeenCalled();
  });

  it("records a provider that threw as failed, with its reason, rather than as a state", async () => {
    beginTrace.mockRejectedValue(new Error("engine said 503"));

    const outcome = await createIntegrationRunStateStep({ integrationId: "acmetrace", ...START });

    expect(outcome).toEqual({ status: "failed", reason: "engine said 503" });
  });

  it("keeps one integration's failure from touching another's state", async () => {
    // Each integration is its own step call now, so a throw in one is only
    // ever recorded against that one.
    resolved.value = {
      readable: true,
      usable: [
        ...integrations().usable,
        {
          manifest: { id: "acmeother", runState: true },
          runtime: { beginRun: async () => ({ bucket: "b-1" }) },
          ctx: { connection: {} },
        },
      ],
    };
    beginTrace.mockRejectedValue(new Error("engine said 503"));

    const traced = await createIntegrationRunStateStep({ integrationId: "acmetrace", ...START });
    const other = await createIntegrationRunStateStep({ integrationId: "acmeother", ...START });

    expect(traced.status).toBe("failed");
    expect(other).toEqual({ status: "ready", state: { bucket: "b-1" } });
  });

  it("records settings it could not read as unreadable, and asks no provider", async () => {
    resolved.value = { readable: false, reason: "connection refused" };

    const outcome = await createIntegrationRunStateStep({ integrationId: "acmetrace", ...START });

    expect(outcome).toEqual({ status: "unreadable", reason: "connection refused" });
    expect(beginTrace).not.toHaveBeenCalled();
  });

  it("lets a run-control error through instead of recording it as a provider failure", async () => {
    // A cancelled run must stop, not be recorded as "the provider failed" and
    // carry on to the next block.
    const control = Object.assign(new Error("cancelled"), { name: "RunCancelled" });
    beginTrace.mockRejectedValue(control);

    await expect(
      createIntegrationRunStateStep({ integrationId: "acmetrace", ...START }),
    ).rejects.toBe(control);
  });

  it("is never retried: a retry after an ambiguous failure is a second bucket", () => {
    expect(createIntegrationRunStateStep.maxRetries).toBe(0);
  });
});
