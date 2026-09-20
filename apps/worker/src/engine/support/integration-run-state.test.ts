import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One per-run handle per integration, whatever the run does with it, and the
 * same number of step calls whatever the build ships.
 *
 * The provider this was designed from answers a second request for a bucket
 * called `AWT-42` by creating `AWT-42.1`, so "how many times did we ask, and
 * whom" is the whole behaviour. Two halves make it once: the workflow caches
 * the answer for the invocation it is in, and the creation is a step, which
 * the Workflow DevKit replays from its recorded result after a suspend rather
 * than calling the provider again (the step's own test holds its body). This
 * holds the first half, per integration.
 *
 * The other thing held here is the count. The Workflow DevKit replays a run by
 * the sequence of its step calls, so a sequence that depended on which
 * integrations were compiled in would make shipping an integration a drain
 * event: every run suspended past a sandbox would replay a different sequence
 * and die. A use makes exactly one call, with as many ids as it needs.
 *
 * The fixture manifests are per test, because the count under a build with two
 * tracing providers and under one with none is the thing being measured.
 */
const createStep = vi.hoisted(() => vi.fn());
const manifests = vi.hoisted(() => ({
  value: [] as Array<{ id: string; runState?: boolean; capabilities: string[] }>,
}));

vi.mock("../steps/integration-run-state-step.js", () => ({
  createIntegrationRunStatesStep: (...args: unknown[]) => createStep(...args),
}));
vi.mock("@integrations/registry", () => ({
  integrationManifest: (id: string) => manifests.value.find((manifest) => manifest.id === id),
  integrationsProviding: (capability: string) =>
    manifests.value.filter((manifest) => manifest.capabilities.includes(capability)),
}));

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

/** Every id asked for, one entry per step call. */
function asked(): string[][] {
  return createStep.mock.calls.map(([input]) => [...input.integrationIds]);
}

beforeEach(() => {
  manifests.value = [
    { id: "acmetrace", runState: true, capabilities: ["agent_tracing"] },
    { id: "acmechat", runState: true, capabilities: ["messaging"] },
    { id: "acmequiet", capabilities: ["agent_tracing"] },
  ];
  createStep.mockReset();
  // Stands in for the step's body, which answers `none` for an integration
  // whose manifest declares no run state and asks the others.
  createStep.mockImplementation(
    async ({ integrationIds }: { integrationIds: string[] }) =>
      Object.fromEntries(
        integrationIds.map((id) => [
          id,
          manifests.value.find((manifest) => manifest.id === id)?.runState === true
            ? { status: "ready", state: { bucket: `${id}-1` } }
            : { status: "none" },
        ]),
      ),
  );
});

describe("an integration's run state", () => {
  it("is created once for that integration and reused by every later use of it", async () => {
    const run = ctx();

    const first = await integrationRunState(run, "acmetrace");
    const second = await integrationRunState(run, "acmetrace");

    expect(asked()).toEqual([["acmetrace"]]);
    expect(createStep).toHaveBeenCalledWith({
      integrationIds: ["acmetrace"],
      runId: "run-9",
      subjectKey: "AWT-42",
    });
    expect(first).toEqual({ status: "ready", state: { bucket: "acmetrace-1" } });
    expect(second).toEqual(first);
  });

  it("is created for the integration used and for no other, whichever of them declares state", async () => {
    await integrationRunState(ctx(), "acmetrace");

    expect(asked()).toEqual([["acmetrace"]]);
  });

  it("asks once when two blocks reach the same integration in the same tick", async () => {
    // The cache holds the promise, not the settled answer. Written after the
    // await instead, both of these would miss it, and the provider would hand
    // the run two buckets.
    const run = ctx();

    const [first, second] = await Promise.all([
      integrationRunState(run, "acmetrace"),
      integrationRunState(run, "acmetrace"),
    ]);

    expect(asked()).toEqual([["acmetrace"]]);
    expect(second).toEqual(first);
  });

  it("asks again after settings that could not be read, instead of refusing for the rest of the run", async () => {
    const run = ctx();
    createStep.mockResolvedValueOnce({
      acmetrace: { status: "unreadable", reason: "connection refused" },
    });

    expect((await integrationRunState(run, "acmetrace")).status).toBe("unreadable");
    expect(await integrationRunState(run, "acmetrace")).toEqual({
      status: "ready",
      state: { bucket: "acmetrace-1" },
    });
    expect(asked()).toHaveLength(2);
  });

  it("asks again after the integration was found switched off, because an admin can switch it back", async () => {
    // "Not usable right now" is about the moment, not about the run. Cached,
    // it would make every later use of a reconnected integration report a
    // connection that is fine.
    const run = ctx();
    createStep.mockResolvedValueOnce({
      acmetrace: {
        status: "unavailable",
        reason: "disabled",
        message: "Acme Trace is disabled on this deployment.",
      },
    });

    expect((await integrationRunState(run, "acmetrace")).status).toBe("unavailable");
    expect((await integrationRunState(run, "acmetrace")).status).toBe("ready");
    expect(asked()).toHaveLength(2);
  });

  it("does not ask a provider again after it failed, because asking again is a second bucket", async () => {
    const run = ctx();
    createStep.mockResolvedValueOnce({ acmetrace: { status: "failed", reason: "503" } });

    await integrationRunState(run, "acmetrace");
    expect(await integrationRunState(run, "acmetrace")).toEqual({ status: "failed", reason: "503" });
    expect(asked()).toHaveLength(1);
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
      // `acmequiet` traces and declares no state: the step answers `none` for
      // it rather than the workflow deciding not to ask.
      states: { acmetrace: { bucket: "acmetrace-1" }, acmequiet: null },
      invocation: { nodeId: "implement", attempt: 2 },
    });
    // Tracing is a use of the tracers, not of the chat integration.
    expect(asked()).toEqual([["acmetrace", "acmequiet"]]);
  });

  it("hands a tracer no state when its provider could not make one", async () => {
    createStep.mockResolvedValue({
      acmetrace: { status: "failed", reason: "503" },
      acmequiet: { status: "none" },
    });

    const tracing = await agentTracingRun(ctx());

    expect(tracing.states).toEqual({ acmetrace: null, acmequiet: null });
    expect(tracing).not.toHaveProperty("invocation");
  });

  it("makes exactly one step call per sandbox whatever the build traces with", async () => {
    // THE DRAIN RULE. A call per declaring integration would put a different
    // number of steps before every sandbox the day a second tracer shipped,
    // and every run suspended past one would replay into the wrong step.
    manifests.value = [
      { id: "acmetrace", runState: true, capabilities: ["agent_tracing"] },
      { id: "otherwatch", runState: true, capabilities: ["agent_tracing"] },
    ];
    await agentTracingRun(ctx());
    const withTwo = asked().length;

    createStep.mockClear();
    manifests.value = [{ id: "acmechat", runState: true, capabilities: ["messaging"] }];
    await agentTracingRun(ctx());
    const withNone = asked().length;

    expect(withTwo).toBe(1);
    expect(withNone).toBe(1);
    expect(createStep).toHaveBeenCalledWith({
      integrationIds: [],
      runId: "run-9",
      subjectKey: "AWT-42",
    });
  });

  it("lets a block reuse the task the sandbox's tracer already created", async () => {
    const run = ctx();

    await agentTracingRun(run);
    const forBlock = await integrationRunState(run, "acmetrace");

    expect(asked()).toEqual([["acmetrace", "acmequiet"]]);
    expect(forBlock).toEqual({ status: "ready", state: { bucket: "acmetrace-1" } });
  });
});
