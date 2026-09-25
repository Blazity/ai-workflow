/**
 * CHARACTERIZATION: which provider a memory step talks to, as it is decided
 * today. Stage 6a pins a run to the store it started with; until then every
 * step asks the deployment's rows afresh, and nothing about the run holds it.
 * These tests describe that on purpose, so 6a rewrites them deliberately.
 *
 * The seams are the ones `memory-runtime.test.ts` uses: the integration rows
 * answer through `resolveUsableIntegrations`, the registry holds the fakes a
 * case connects, and the built-in store is a recorder.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErasedIntegrationRuntime, IntegrationManifest, MemoryAdapter } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";

const { resolveUsableIntegrations, builtinRecall, builtinObserve } = vi.hoisted(() => ({
  resolveUsableIntegrations: vi.fn(),
  builtinRecall: vi.fn(),
  builtinObserve: vi.fn(),
}));
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  resolveUsableIntegrations,
  knownSecretValues: async () => [],
  checkIntegrationPin: (
    await importOriginal<typeof import("../../services/integrations/runtime.js")>()
  ).checkIntegrationPin,
}));

const registered = vi.hoisted(() => [] as IntegrationManifest[]);
vi.mock("@integrations/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@integrations/registry")>()),
  integrationManifests: registered,
}));

vi.mock("../../memory/builtin/adapter.js", () => ({
  BUILTIN_MEMORY_PROVIDER_ID: "builtin",
  BUILTIN_MEMORY_PROVIDER_NAME: "Built-in memory",
  builtinMemoryAdapter: () => ({ recall: builtinRecall, observe: builtinObserve, store: null }),
}));

import { activeMemory } from "./memory-runtime.js";

const RECALL = {
  subject: { key: "repo:github:acme/api", label: "acme/api" },
  scope: { kind: "facts" },
} as const;
const OBSERVE = {
  ...RECALL,
  runId: "run_1",
  ticketKey: null,
  observation: { kind: "items", learned: ["Uses pnpm"], refuted: [] },
} as const;

function engineAdapter(): MemoryAdapter {
  return {
    recall: vi.fn(async () => ({ ok: true as const, held: false, entries: [], rendering: "" })),
    observe: vi.fn(async () => ({ ok: true as const, stored: true, removed: 0, dropped: 0, remaining: 1 })),
  };
}

function state(id: string, overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: id,
    status: "connected",
    connection: "connected",
    enabled: true,
    usable: true,
    failure: null,
    pin: { integrationId: id, configFingerprint: "fingerprint-1" },
    ...overrides,
  } as IntegrationState;
}

/** The deployment as its rows say right now: `engine` connected and switched
 *  on when given, otherwise registered and in `engineState`. */
function deploymentIs(options: { engine?: MemoryAdapter; engineState?: Partial<IntegrationState> }): void {
  const manifest = { id: "engine", name: "Engine", capabilities: ["memory"] } as unknown as IntegrationManifest;
  registered.splice(0, registered.length, manifest);
  resolveUsableIntegrations.mockImplementation(async (input: { lifetime?: AbortSignal }) => ({
    readable: true,
    usable: options.engine
      ? [
          {
            manifest,
            runtime: { capabilities: { memory: () => options.engine } } as unknown as ErasedIntegrationRuntime,
            ctx: { signal: input.lifetime },
            redaction: { text: (text: string) => text, error: (error: unknown) => error },
          },
        ]
      : [],
    states: new Map([["engine", state("engine", options.engine ? {} : options.engineState)]]),
  }));
}

// The real runtime module reads every registered manifest when it loads, so it
// is loaded once here, while the registry holds only what the build ships, and
// before a case registers a bare fake.
beforeAll(async () => {
  await import("../../services/integrations/runtime.js");
});

beforeEach(() => {
  vi.clearAllMocks();
  registered.splice(0);
  builtinRecall.mockResolvedValue({ ok: true, held: false, entries: [], rendering: "" });
  builtinObserve.mockResolvedValue({ ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 });
});

describe("changes in 6a: every step resolves its provider from the deployment's rows as they are now", () => {
  it("a later step of one run follows an engine an admin connected between two steps", async () => {
    // Mistake that turns this red: caching the provider across steps, or
    // holding a run to the store it started with. 6a does the second on
    // purpose; until then two steps of one run can write to two stores.
    deploymentIs({ engineState: { status: "not_connected", connection: "not_connected", usable: false } });
    const firstStep = await activeMemory();

    const engine = engineAdapter();
    deploymentIs({ engine });
    const secondStep = await activeMemory();

    expect(firstStep.id).toBe("builtin");
    expect(secondStep.id).toBe("engine");
    await secondStep.observe(OBSERVE);
    expect(engine.observe).toHaveBeenCalledTimes(1);
    expect(builtinObserve).not.toHaveBeenCalled();
    expect(resolveUsableIntegrations).toHaveBeenCalledTimes(2);
  });

  it("a later step writes into the built-in store once the engine is switched off", async () => {
    deploymentIs({ engine: engineAdapter() });
    const firstStep = await activeMemory();

    deploymentIs({ engineState: { status: "disabled", enabled: false, usable: false } });
    const secondStep = await activeMemory();

    expect(firstStep.id).toBe("engine");
    expect(secondStep.id).toBe("builtin");
    await secondStep.observe(OBSERVE);
    expect(builtinObserve).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the provider a step resolved, whatever the rows say after it", async () => {
    // Resolved once per step, not per call: a switch made while a step runs
    // reaches the next step, never the rest of this one.
    const engine = engineAdapter();
    deploymentIs({ engine });
    const step = await activeMemory();

    deploymentIs({ engineState: { status: "disabled", enabled: false, usable: false } });
    await step.recall(RECALL);

    expect(engine.recall).toHaveBeenCalledTimes(1);
    expect(builtinRecall).not.toHaveBeenCalled();
  });

  it("answers the built-in store before any pin is compared, so a run that pinned a switched-off engine is not told memory moved", async () => {
    // With pins passed (no caller passes any today), a run whose engine was
    // disabled after it started still gets the built-in store rather than a
    // `moved` refusal, because the built-in answer returns first.
    deploymentIs({ engineState: { status: "disabled", enabled: false, usable: false } });

    const memory = await activeMemory([{ integrationId: "engine", configFingerprint: "fingerprint-1" }]);

    expect(memory.refusal).toBeNull();
    expect(memory.id).toBe("builtin");
  });
});
