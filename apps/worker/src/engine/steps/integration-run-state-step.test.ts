import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The body of the one step that creates per-run integration state.
 *
 * The step is what makes "once per run" survive a suspend, so what it returns
 * is recorded with the run and never recomputed. That makes every decision in
 * its body permanent for the run: whom it asks, with what, and what it records
 * when the answer is not a state. It takes a list because the number of step
 * calls a run makes must depend on its graph and not on the build, so
 * everything one use needs arrives in this one call and is answered
 * separately. Two fake integrations stand in for real ones: `acmetrace`
 * declares run state, `acmechat` does not.
 */
const resolved = vi.hoisted(() => ({ value: undefined as unknown, calls: 0 }));
const beginTrace = vi.hoisted(() => vi.fn());
const beginChat = vi.hoisted(() => vi.fn());
const manifests = vi.hoisted(() => ({
  value: [] as Array<{ id: string; name: string; runState?: boolean }>,
}));

vi.mock("@integrations/registry", () => ({
  integrationManifest: (id: string) => manifests.value.find((manifest) => manifest.id === id),
}));
vi.mock("../../services/integrations/runtime.js", () => ({
  resolveUsableIntegrations: async (input: { filter?: (manifest: { id: string }) => boolean }) => {
    resolved.calls += 1;
    const answer = resolved.value as
      | {
          readable: true;
          usable: Array<{ manifest: { id: string } }>;
          states?: Map<string, { enabled: boolean }>;
        }
      | { readable: false; reason: string };
    if (!answer.readable) return answer;
    return {
      readable: true,
      usable: answer.usable.filter((entry) => input.filter?.(entry.manifest as never) ?? true),
      states: answer.states ?? new Map(),
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

const { createIntegrationRunStatesStep } = await import("./integration-run-state-step.js");

function integrations() {
  return {
    readable: true as const,
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
    states: new Map([
      ["acmetrace", { enabled: true }],
      ["acmechat", { enabled: true }],
    ]),
  };
}

const START = { runId: "run-9", subjectKey: "AWT-42" };

beforeEach(() => {
  manifests.value = [
    { id: "acmetrace", name: "Acme Trace", runState: true },
    { id: "acmechat", name: "Acme Chat" },
    { id: "acmeother", name: "Acme Other", runState: true },
  ];
  beginTrace.mockReset();
  beginChat.mockReset();
  resolved.calls = 0;
  resolved.value = integrations();
});

describe("creating per-run integration state", () => {
  it("asks that integration, with the run id and the name of what the run is about", async () => {
    beginTrace.mockResolvedValue({ taskId: "task-7" });

    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmetrace"],
      ...START,
    });

    expect(outcomes).toEqual({ acmetrace: { status: "ready", state: { taskId: "task-7" } } });
    expect(beginTrace).toHaveBeenCalledTimes(1);
    expect(beginTrace.mock.calls[0]?.[0]).toEqual({ runId: "run-9", subjectKey: "AWT-42" });
    // Asking for one integration never creates another's state.
    expect(beginChat).not.toHaveBeenCalled();
  });

  it("answers an empty list with an empty map, reading no connection at all", async () => {
    // What a deployment with no tracing integration asks before every sandbox.
    // It is a step call rather than no call so that gaining the first tracing
    // integration does not renumber the steps of a suspended run, and it must
    // stay free: one shared connection read hoisted to the top of the body
    // would put a database round trip before every sandbox on every
    // deployment, traced or not.
    expect(await createIntegrationRunStatesStep({ integrationIds: [], ...START })).toEqual({});
    expect(resolved.calls).toBe(0);
    expect(beginTrace).not.toHaveBeenCalled();
  });

  it("never asks an integration that does not declare run state", async () => {
    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmechat"],
      ...START,
    });

    expect(outcomes).toEqual({ acmechat: { status: "none" } });
    expect(beginChat).not.toHaveBeenCalled();
  });

  it("says which connection stopped it, rather than reporting that nothing was created", async () => {
    // `none` is a fact about the build and an admin can do nothing with it.
    // Disabled is a fact about this afternoon, with somebody to tell.
    resolved.value = {
      readable: true,
      usable: [],
      states: new Map([["acmetrace", { enabled: false }]]),
    };

    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmetrace"],
      ...START,
    });

    expect(outcomes).toEqual({
      acmetrace: {
        status: "unavailable",
        reason: "disabled",
        message: "Acme Trace is disabled on this deployment.",
      },
    });
    expect(beginTrace).not.toHaveBeenCalled();
  });

  it("reads an integration nobody connected as disconnected, not as disabled", async () => {
    resolved.value = { readable: true, usable: [], states: new Map() };

    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmetrace"],
      ...START,
    });

    expect(outcomes.acmetrace).toMatchObject({ status: "unavailable", reason: "disconnected" });
  });

  it("records a provider that threw as failed, with its reason, rather than as a state", async () => {
    beginTrace.mockRejectedValue(new Error("engine said 503"));

    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmetrace"],
      ...START,
    });

    expect(outcomes).toEqual({ acmetrace: { status: "failed", reason: "engine said 503" } });
  });

  it("keeps one integration's failure from touching another's state in the same call", async () => {
    // One call, separate answers: a provider that throws is recorded against
    // itself alone, which is what lets a use ask for several at once.
    resolved.value = {
      ...integrations(),
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

    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmetrace", "acmeother"],
      ...START,
    });

    expect(outcomes.acmetrace?.status).toBe("failed");
    expect(outcomes.acmeother).toEqual({ status: "ready", state: { bucket: "b-1" } });
    // One resolution each, which is what gives each id its own time bound: a
    // single shared read would hand them one minute between them.
    expect(resolved.calls).toBe(2);
  });

  it("records settings it could not read as unreadable, and asks no provider", async () => {
    resolved.value = { readable: false, reason: "connection refused" };

    const outcomes = await createIntegrationRunStatesStep({
      integrationIds: ["acmetrace"],
      ...START,
    });

    expect(outcomes).toEqual({
      acmetrace: { status: "unreadable", reason: "connection refused" },
    });
    expect(beginTrace).not.toHaveBeenCalled();
  });

  it("lets a run-control error through instead of recording it as a provider failure", async () => {
    // A cancelled run must stop, not be recorded as "the provider failed" and
    // carry on to the next block.
    const control = Object.assign(new Error("cancelled"), { name: "RunCancelled" });
    beginTrace.mockRejectedValue(control);

    await expect(
      createIntegrationRunStatesStep({ integrationIds: ["acmetrace"], ...START }),
    ).rejects.toBe(control);
  });

  it("is never retried: a retry after an ambiguous failure is a second bucket", () => {
    expect(createIntegrationRunStatesStep.maxRetries).toBe(0);
  });
});
