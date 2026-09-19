import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One per-run handle per integration, whatever the run does with it.
 *
 * The provider this was designed from answers a second request for a bucket
 * called `AWT-42` by creating `AWT-42.1`, so "how many times did we ask, and
 * whom" is the whole behaviour. Two halves make it once: the workflow caches
 * the answer for the invocation it is in, and the creation is a step, which
 * the Workflow DevKit replays from its recorded result after a suspend rather
 * than calling the provider again (the step's own test holds its body). This
 * holds the first half, per integration.
 *
 * Three fake integrations: `acmetrace` traces and declares run state,
 * `acmechat` declares run state and does not trace, `acmequiet` declares none.
 */
const createStep = vi.hoisted(() => vi.fn());

vi.mock("../steps/integration-run-state-step.js", () => ({
  createIntegrationRunStateStep: (...args: unknown[]) => createStep(...args),
}));
vi.mock("@integrations/registry", () => {
  const manifests = [
    { id: "acmetrace", runState: true, capabilities: ["agent_tracing"] },
    { id: "acmechat", runState: true, capabilities: ["messaging"] },
    { id: "acmequiet", capabilities: ["agent_tracing"] },
  ];
  return {
    integrationManifest: (id: string) => manifests.find((manifest) => manifest.id === id),
    integrationsProviding: (capability: string) =>
      manifests.filter((manifest) => manifest.capabilities.includes(capability)),
  };
});

const { agentTracingRun, integrationRunState, runSubjectKey } = await import(
  "./integration-run-state.js"
);

function ctx() {
  return {
    runId: "run-9",
    // What core stores, and what an integration must never be handed as the
    // run's name: the ticket key below is.
    entry: { subjectKey: "ticket:jira:AWT-42" },
    ticket: { identifier: "AWT-42" },
    integrationRunStates: null,
  } as unknown as Parameters<typeof integrationRunState>[0];
}

beforeEach(() => {
  createStep.mockReset();
  createStep.mockImplementation(async ({ integrationId }: { integrationId: string }) => ({
    status: "ready",
    state: { bucket: `${integrationId}-1` },
  }));
});

describe("an integration's run state", () => {
  it("is created once for that integration and reused by every later use of it", async () => {
    const run = ctx();

    const first = await integrationRunState(run, "acmetrace");
    const second = await integrationRunState(run, "acmetrace");

    expect(createStep).toHaveBeenCalledTimes(1);
    expect(createStep).toHaveBeenCalledWith({
      integrationId: "acmetrace",
      runId: "run-9",
      subjectKey: "AWT-42",
    });
    expect(first).toEqual({ status: "ready", state: { bucket: "acmetrace-1" } });
    expect(second).toBe(first);
  });

  it("is created for the integration used and for no other, whichever of them declares state", async () => {
    await integrationRunState(ctx(), "acmetrace");

    expect(createStep.mock.calls.map(([input]) => input.integrationId)).toEqual(["acmetrace"]);
  });

  it("costs the run no step for an integration that declares none", async () => {
    expect(await integrationRunState(ctx(), "acmequiet")).toEqual({ status: "none" });
    expect(createStep).not.toHaveBeenCalled();
  });

  it("asks again after settings that could not be read, instead of refusing for the rest of the run", async () => {
    const run = ctx();
    createStep.mockResolvedValueOnce({ status: "unreadable", reason: "connection refused" });

    expect((await integrationRunState(run, "acmetrace")).status).toBe("unreadable");
    expect(await integrationRunState(run, "acmetrace")).toEqual({
      status: "ready",
      state: { bucket: "acmetrace-1" },
    });
    expect(createStep).toHaveBeenCalledTimes(2);
  });

  it("does not ask a provider again after it failed, because asking again is a second bucket", async () => {
    const run = ctx();
    createStep.mockResolvedValueOnce({ status: "failed", reason: "503" });

    await integrationRunState(run, "acmetrace");
    expect(await integrationRunState(run, "acmetrace")).toEqual({ status: "failed", reason: "503" });
    expect(createStep).toHaveBeenCalledTimes(1);
  });

  it("names the run by its ticket key, never the key core stores", () => {
    expect(runSubjectKey(ctx())).toBe("AWT-42");
  });
});

describe("what a sandbox's tracers are told", () => {
  it("carries the state of each tracing provider that declares one, and creates nobody else's", async () => {
    const run = ctx();

    const tracing = await agentTracingRun(run, { nodeId: "implement", attempt: 2 });

    expect(tracing).toEqual({
      runId: "run-9",
      subjectKey: "AWT-42",
      states: { acmetrace: { bucket: "acmetrace-1" } },
      invocation: { nodeId: "implement", attempt: 2 },
    });
    // Tracing is a use of the tracer, not of the chat integration.
    expect(createStep.mock.calls.map(([input]) => input.integrationId)).toEqual(["acmetrace"]);
  });

  it("hands a tracer no state when its provider could not make one", async () => {
    createStep.mockResolvedValue({ status: "failed", reason: "503" });

    const tracing = await agentTracingRun(ctx());

    expect(tracing.states).toEqual({ acmetrace: null });
    expect(tracing).not.toHaveProperty("invocation");
  });
});
