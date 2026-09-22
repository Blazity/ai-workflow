/**
 * Which provider serves memory on a deployment, and what core does when none
 * can.
 *
 * The cases here come from the operators, not from the code: somebody who has
 * connected nothing (the default and the overwhelmingly common deployment),
 * somebody who has connected one engine, somebody who has connected two and
 * chosen neither, somebody whose database was briefly away, and a run that
 * started before an engine was connected.
 *
 * The second provider is a fake that lives only here, and that is the point: a
 * port with exactly one implementation is a hypothetical seam. Everything the
 * fake does, it does through the published `MemoryAdapter` type.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryAdapter } from "@integrations/sdk";

const resolveUsableIntegrations = vi.fn();
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  resolveUsableIntegrations,
  // The comparison itself is the real one: a mocked pin check would prove that
  // this module calls something, not that a moved provider is refused.
  checkIntegrationPin: (
    await importOriginal<typeof import("../../services/integrations/runtime.js")>()
  ).checkIntegrationPin,
}));

const builtinRecall = vi.fn();
const builtinObserve = vi.fn();
vi.mock("../../memory/builtin/adapter.js", () => ({
  BUILTIN_MEMORY_PROVIDER_ID: "builtin",
  BUILTIN_MEMORY_PROVIDER_NAME: "Built-in memory",
  builtinMemoryAdapter: () => ({
    recall: builtinRecall,
    observe: builtinObserve,
    store: { list: vi.fn(), read: vi.fn(), forget: vi.fn() },
  }),
}));

import { activeMemory } from "./memory-runtime.js";

const SUBJECT = { key: "repo:github:acme/api", label: "acme/api" };
const RECALL = { subject: SUBJECT, scope: { kind: "facts" } } as const;

/** One usable integration, as `resolveUsableIntegrations` hands it over. */
function provider(name: string, adapter: Partial<MemoryAdapter> | null): unknown {
  return {
    manifest: { id: name.toLowerCase(), name, capabilities: ["memory"] },
    runtime: { capabilities: adapter === null ? {} : { memory: () => adapter } },
    ctx: {},
  };
}

function readable(...usable: unknown[]): void {
  resolveUsableIntegrations.mockResolvedValue({ readable: true, usable, states: new Map() });
}

/** The same, plus what the deployment currently says about that connection. */
function readableWithState(name: string, fingerprint: string, adapter: unknown): void {
  const id = name.toLowerCase();
  resolveUsableIntegrations.mockResolvedValue({
    readable: true,
    usable: [provider(name, adapter as never)],
    states: new Map([
      [
        id,
        {
          integrationId: id,
          status: "connected",
          connection: "connected",
          enabled: true,
          usable: true,
          failure: null,
          pin: { integrationId: id, configFingerprint: fingerprint },
        },
      ],
    ]),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  builtinRecall.mockResolvedValue({ ok: true, held: false, entries: [], rendering: "" });
  builtinObserve.mockResolvedValue({
    ok: true,
    stored: true,
    removed: 0,
    dropped: 0,
    remaining: 1,
  });
});

describe("a deployment that has connected nothing", () => {
  it("serves memory from the built-in store rather than refusing", async () => {
    // THE DEFAULT DEPLOYMENT. Every other capability answers "nothing is
    // connected" here and stops. Memory may not: the built-in store is what
    // this product has always used, and a deployment that never opens the
    // Integrations page must keep exactly the memory it has.
    readable();

    const memory = await activeMemory();

    expect(memory.refusal).toBeNull();
    expect(memory.id).toBe("builtin");
    expect(memory.name).toBe("Built-in memory");
    expect(await memory.recall(RECALL)).toEqual({
      ok: true,
      held: false,
      entries: [],
      rendering: "",
    });
    expect(builtinRecall).toHaveBeenCalledTimes(1);
  });

  it("does not read a run's pins as the provider having moved", async () => {
    // A run carries pins for whatever it DID use, so a run on this deployment
    // names other integrations and never memory. Comparing those pins against
    // a memory provider that does not exist would refuse memory on every run
    // of every default deployment, silently, from the moment this shipped.
    readable();

    const memory = await activeMemory([
      { integrationId: "jira", configFingerprint: "abc" },
    ]);

    expect(memory.refusal).toBeNull();
    expect(memory.id).toBe("builtin");
  });

});

describe("a deployment that connected one engine", () => {
  it("serves memory from it and never from the built-in store", async () => {
    const recall = vi.fn<MemoryAdapter["recall"]>(async () => ({
      ok: true,
      held: true,
      entries: [{ text: "Run tests with: pnpm test" }],
      rendering: "- Run tests with: pnpm test",
    }));
    readable(provider("Recall Engine", { recall }));

    const memory = await activeMemory();

    expect(memory.id).toBe("recall engine");
    expect(await memory.recall(RECALL)).toMatchObject({ held: true });
    expect(recall).toHaveBeenCalledWith(RECALL);
    // Connecting an engine REPLACES the provider. A deployment writing into
    // both would split its memory in two with nobody told.
    expect(builtinRecall).not.toHaveBeenCalled();
  });

  it("answers rather than throwing when the engine throws", async () => {
    // The port promises not to throw. A provider that does anyway is a bug in
    // that provider, not a reason to fail somebody's run.
    readable(
      provider("Recall Engine", {
        observe: async () => {
          throw new Error("socket hang up");
        },
      }),
    );

    const write = await (
      await activeMemory()
    ).observe({
      subject: SUBJECT,
      scope: { kind: "facts" },
      runId: "run_1",
      ticketKey: null,
      observation: { kind: "items", learned: ["a fact"], refuted: [] },
    });

    expect(write).toEqual({
      ok: false,
      code: "unavailable",
      detail: expect.stringContaining("socket hang up"),
    });
  });

  it("offers no admin half when the engine ships none", async () => {
    // An engine that cannot enumerate what it holds is fully usable for runs.
    // `store: null` is what stops a screen showing its silence as an empty
    // store.
    readable(provider("Recall Engine", { recall: vi.fn(), observe: vi.fn() }));

    expect((await activeMemory()).store).toBeNull();
  });

  it("refuses when the engine declares memory and ships no code for it", async () => {
    readable(provider("Recall Engine", null));

    const memory = await activeMemory();

    expect(memory.refusal).toEqual({
      code: "no_provider",
      detail: expect.stringContaining("ships no code"),
    });
    // NOT the built-in store. An admin who connected an engine and got our own
    // store instead would have their memory written somewhere they did not
    // choose and cannot see.
    expect(builtinRecall).not.toHaveBeenCalled();
  });
});

describe("a deployment that connected two engines", () => {
  it("refuses by name rather than picking the first", async () => {
    readable(provider("Recall Engine", {}), provider("Second Engine", {}));

    const memory = await activeMemory();

    expect(memory.refusal).toEqual({
      code: "ambiguous",
      detail:
        "Recall Engine and Second Engine both provide memory on this deployment and no active provider is selected, so memory was not used",
    });
    expect(await memory.recall(RECALL)).toMatchObject({ ok: false, code: "ambiguous" });
    expect(builtinRecall).not.toHaveBeenCalled();
  });
});

describe("a deployment whose settings could not be read", () => {
  it("refuses instead of falling back to the built-in store", async () => {
    // Falling back would look safer and is not: on a deployment running an
    // engine it would split that deployment's memory across two stores with
    // nobody told. It also buys nothing, because the integration settings and
    // the built-in store are rows in the same database.
    resolveUsableIntegrations.mockResolvedValue({ readable: false, reason: "db down" });

    const memory = await activeMemory();

    expect(memory.refusal).toEqual({
      code: "unreadable",
      detail: expect.stringContaining("db down"),
    });
    expect(builtinRecall).not.toHaveBeenCalled();
  });

  it("refuses rather than throwing when the resolution itself fails", async () => {
    // Memory is reached from teardown, from a poll pass and from a prompt
    // build. None of them may die because an optional optimisation could not
    // be resolved.
    resolveUsableIntegrations.mockRejectedValue(new Error("module missing"));

    const memory = await activeMemory();

    expect(memory.refusal).toEqual({
      code: "unreadable",
      detail: expect.stringContaining("module missing"),
    });
  });
});

describe("a run that started before the engine was connected", () => {
  it("refuses rather than remembering into a provider it never used", async () => {
    readableWithState("Recall Engine", "fingerprint-1", { recall: vi.fn() });

    const memory = await activeMemory([
      { integrationId: "jira", configFingerprint: "abc" },
    ]);

    expect(memory.refusal).toEqual({
      code: "moved",
      detail:
        "Recall Engine became this deployment's memory after this run started, so this run did not use it",
    });
  });

  it("serves the engine the run pinned", async () => {
    const recall = vi.fn<MemoryAdapter["recall"]>(async () => ({
      ok: true,
      held: false,
      entries: [],
      rendering: "",
    }));
    readableWithState("Recall Engine", "fingerprint-1", { recall });

    const memory = await activeMemory([
      { integrationId: "recall engine", configFingerprint: "fingerprint-1" },
    ]);

    expect(memory.refusal).toBeNull();
    await memory.recall(RECALL);
    expect(recall).toHaveBeenCalledTimes(1);
  });

  it("refuses when the engine was reconfigured under the run", async () => {
    readableWithState("Recall Engine", "fingerprint-2", { recall: vi.fn() });

    const memory = await activeMemory([
      { integrationId: "recall engine", configFingerprint: "fingerprint-1" },
    ]);

    expect(memory.refusal).toEqual({
      code: "moved",
      detail: "Recall Engine's configuration changed after this run started, so memory was not used",
    });
  });
});
