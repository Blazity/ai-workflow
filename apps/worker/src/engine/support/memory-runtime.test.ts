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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ErasedIntegrationRuntime,
  IntegrationManifest,
  MemoryAdapter,
} from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";

const resolveUsableIntegrations = vi.fn();
/** Every secret this deployment knows, as the one source answers it. Nothing
 *  by default; a case that is about secrets says which. */
const knownSecretValues = vi.fn<() => Promise<string[]>>();
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  resolveUsableIntegrations,
  knownSecretValues,
  // The comparison itself is the real one: a mocked pin check would prove that
  // this module calls something, not that a moved provider is refused.
  checkIntegrationPin: (
    await importOriginal<typeof import("../../services/integrations/runtime.js")>()
  ).checkIntegrationPin,
}));
/** The real redaction unless a case breaks it on purpose. */
const redaction = vi.hoisted(() => ({ broken: false }));
vi.mock("../../run-observability/sanitizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../run-observability/sanitizer.js")>();
  return {
    ...actual,
    redactConfiguredSecretsInText: (text: string, secrets: readonly string[]) => {
      if (redaction.broken) throw new Error("redaction failed");
      return actual.redactConfiguredSecretsInText(text, secrets);
    },
  };
});

// The memory integrations this build ships. No real one exists yet, so each
// case registers the fakes it is about, the way a generated registry would.
const registered = vi.hoisted(() => [] as IntegrationManifest[]);
vi.mock("@integrations/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@integrations/registry")>()),
  integrationManifests: registered,
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

import { redactedError } from "../../services/integrations/context.js";
import { redactingRuntime } from "../../services/integrations/usable.js";
import { activeMemory, MEMORY_CALL_BUDGET_MS } from "./memory-runtime.js";

const SUBJECT = { key: "repo:github:acme/api", label: "acme/api" };
const RECALL = { subject: SUBJECT, scope: { kind: "facts" } } as const;
const OBSERVE = {
  subject: SUBJECT,
  scope: { kind: "facts" },
  runId: "run_1",
  ticketKey: null,
  observation: { kind: "items", learned: ["a fact"], refuted: [] },
} as const;
const SECRET = "m0-key-8f3a91c2d7";
const withoutKey = (text: string) => text.split(SECRET).join("[redacted]");

/** One memory integration as the registry declares it. */
function manifestOf(name: string): IntegrationManifest {
  return { id: name.toLowerCase(), name, capabilities: ["memory"] } as unknown as IntegrationManifest;
}

/**
 * One usable integration, as `resolveUsableIntegrations` hands it over: its
 * context carries the lifetime the caller asked for, its runtime is behind the
 * real redaction boundary, and core's redactor takes this connection's key out
 * of what it says.
 */
function provider(name: string, adapter: Partial<MemoryAdapter> | null) {
  const redactError = (error: unknown) => redactedError(error, withoutKey);
  return (lifetime: AbortSignal | undefined) => ({
    manifest: manifestOf(name),
    runtime: redactingRuntime(
      {
        capabilities: adapter === null ? {} : { memory: () => adapter },
      } as unknown as ErasedIntegrationRuntime,
      redactError,
    ),
    ctx: { signal: lifetime },
    redaction: { text: withoutKey, error: redactError },
  });
}

type Provider = ReturnType<typeof provider>;

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

/** The provider context's lifetime from the last resolution. */
function lastLifetime(): AbortSignal {
  const input = resolveUsableIntegrations.mock.calls.at(-1)?.[0] as { lifetime?: AbortSignal };
  if (!input?.lifetime) throw new Error("activeMemory resolved without a lifetime");
  return input.lifetime;
}

/**
 * A deployment where each of these is connected and switched on, and each of
 * `others` is registered with the state given (disabled, failing, never
 * connected) and therefore not usable.
 */
function readable(...usable: Provider[]): void {
  deployment(usable, []);
}

function deployment(
  usable: Provider[],
  others: Array<{ name: string; state: Partial<IntegrationState> }>,
): void {
  const connected = usable.map((build) => build(undefined).manifest);
  registered.splice(0, registered.length, ...connected, ...others.map((other) => manifestOf(other.name)));
  resolveUsableIntegrations.mockImplementation(async (input: { lifetime?: AbortSignal }) => ({
    readable: true,
    usable: usable.map((build) => build(input.lifetime)),
    states: new Map([
      ...connected.map((manifest) => [manifest.id, state(manifest.id)] as const),
      ...others.map(
        (other) => [other.name.toLowerCase(), state(other.name.toLowerCase(), other.state)] as const,
      ),
    ]),
  }));
}

/** The same, plus what the deployment currently says about that connection. */
function readableWithState(name: string, fingerprint: string, adapter: unknown): void {
  const id = name.toLowerCase();
  registered.splice(0, registered.length, manifestOf(name));
  resolveUsableIntegrations.mockImplementation(async (input: { lifetime?: AbortSignal }) => ({
    readable: true,
    usable: [provider(name, adapter as never)(input.lifetime)],
    states: new Map([[id, state(id, { pin: { integrationId: id, configFingerprint: fingerprint } })]]),
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  registered.splice(0);
  redaction.broken = false;
  knownSecretValues.mockResolvedValue([]);
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
        "Recall Engine and Second Engine both provide memory on this deployment and no active provider is selected, so memory was not used. Disable all but one of them on the Integrations page",
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

describe("a connected engine that stops answering", () => {
  const SPENT = expect.stringContaining(
    "did not answer in time (memory calls in this step used their 60 s), so memory was skipped for the rest of this step",
  );

  /** Resolves `answer` after `ms` of fake time, or with a refusal when `signal` aborts first. */
  function answersAfter<T>(ms: number, answer: T, signal: () => AbortSignal) {
    return () =>
      new Promise<T | { ok: false; code: "unavailable"; detail: string }>((resolve) => {
        const timer = setTimeout(() => resolve(answer), ms);
        signal().addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ ok: false, code: "unavailable", detail: "the request was aborted" });
        });
      });
  }

  it("costs a step at most the budget however many calls it makes, and every later call refuses at once", async () => {
    // A distill over six repositories makes 19 calls. Against an engine that
    // takes connections and never answers, each call waited out its own
    // timeouts, which is ten minutes of a run's teardown. This provider does
    // not even honour its signal, which is the worst case the budget has to
    // bound on its own.
    vi.useFakeTimers();
    const recall = vi.fn(() => new Promise<never>(() => {}));
    const observe = vi.fn(() => new Promise<never>(() => {}));
    readable(provider("Recall Engine", { recall, observe }));
    const memory = await activeMemory();

    let first: unknown = "pending";
    void memory.recall(RECALL).then((answer) => (first = answer));
    await vi.advanceTimersByTimeAsync(MEMORY_CALL_BUDGET_MS - 1);
    expect(first).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toEqual({ ok: false, code: "unavailable", detail: SPENT });

    // No clock moves from here on: an answer that needed time would hang.
    const later = await Promise.all([
      memory.recall(RECALL),
      memory.observe(OBSERVE),
      memory.recall(RECALL),
    ]);
    for (const answer of later) {
      expect(answer).toEqual({ ok: false, code: "unavailable", detail: SPENT });
    }
    expect(recall).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
    // And the provider's own requests were told to stop.
    expect(lastLifetime().aborted).toBe(true);
  });

  it("charges only the time spent waiting on memory, not the model call between reads and writes", async () => {
    vi.useFakeTimers();
    const ok = { ok: true, held: true, entries: [], rendering: "" } as const;
    const recall = vi.fn(answersAfter(25_000, ok, lastLifetime));
    readable(provider("Recall Engine", { recall }));
    const memory = await activeMemory();

    const first = memory.recall(RECALL);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await first).toEqual(ok);

    // The distill's model call: ten minutes in which memory is not waited on.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lastLifetime().aborted).toBe(false);

    const second = memory.recall(RECALL);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await second).toEqual(ok);

    // 50 s spent; the third call is cut when the remaining 10 s run out, not
    // when the provider would have answered, and its request is stopped.
    let third: unknown = "pending";
    void memory.recall(RECALL).then((answer) => (third = answer));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(third).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(third).toEqual({ ok: false, code: "unavailable", detail: SPENT });
    expect(lastLifetime().aborted).toBe(true);
  });

  it("charges calls made side by side once", async () => {
    vi.useFakeTimers();
    const ok = { ok: true, held: false, entries: [], rendering: "" } as const;
    readable(provider("Recall Engine", { recall: vi.fn(answersAfter(25_000, ok, lastLifetime)) }));
    const memory = await activeMemory();

    const together = Promise.all([memory.recall(RECALL), memory.recall(RECALL), memory.recall(RECALL)]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await together).toEqual([ok, ok, ok]);

    // 25 s of waiting, not 75: a fourth call still has most of the budget.
    const fourth = memory.recall(RECALL);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await fourth).toEqual(ok);
  });

  it("leaves the built-in store exactly as it was: no budget, however slow the database", async () => {
    vi.useFakeTimers();
    readable();
    builtinRecall.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ ok: true, held: true, entries: [], rendering: "" }), 5 * 60_000),
        ),
    );
    const memory = await activeMemory();

    // Ten minutes of waiting in one step, far past a connected provider's
    // budget, and both answers are the store's own.
    for (let call = 0; call < 2; call += 1) {
      const slow = memory.recall(RECALL);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await slow).toMatchObject({ ok: true, held: true });
    }
    expect(builtinRecall).toHaveBeenCalledTimes(2);
  });
});

describe("a memory integration that is switched on and failing", () => {
  it("refuses, naming it and why, instead of quietly writing into the built-in store", async () => {
    // The operator believes the engine is serving. Falling back would put this
    // run's memory in a store they are not looking at and split the
    // deployment's memory in two.
    deployment([], [
      {
        name: "Recall Engine",
        state: {
          status: "failing",
          connection: "failing",
          usable: false,
          failure: { reason: "credential_rejected", message: "The engine refused the API key" },
        },
      },
    ]);

    const memory = await activeMemory();

    expect(memory.refusal).toEqual({
      code: "unavailable",
      detail:
        "Recall Engine is switched on for memory and its connection is failing (The engine refused the API key), so memory was not used. Fix it on the Integrations page, or disable it there to use the built-in memory",
    });
    expect(await memory.observe(OBSERVE)).toMatchObject({ ok: false, code: "unavailable" });
    expect(builtinObserve).not.toHaveBeenCalled();
  });

  it("serves the built-in store once an admin switches it off", async () => {
    deployment([], [
      {
        name: "Recall Engine",
        state: { status: "disabled", enabled: false, connection: "failing", usable: false },
      },
    ]);

    const memory = await activeMemory();

    expect(memory.refusal).toBeNull();
    expect(memory.id).toBe("builtin");
  });

  it("serves the built-in store when the engine was never connected", async () => {
    deployment([], [
      { name: "Recall Engine", state: { status: "not_connected", connection: "not_connected", usable: false } },
    ]);

    expect((await activeMemory()).id).toBe("builtin");
  });

  it("counts toward two providers being switched on, rather than handing memory to the other", async () => {
    deployment(
      [provider("Recall Engine", { recall: vi.fn() })],
      [
        {
          name: "Second Engine",
          state: { status: "failing", connection: "failing", usable: false },
        },
      ],
    );

    expect((await activeMemory()).refusal).toMatchObject({
      code: "ambiguous",
      detail: expect.stringContaining("Disable all but one of them on the Integrations page"),
    });
  });
});

describe("what memory copies out of a provider", () => {
  it("takes the connection's key out of a thrown message and out of a refusal", async () => {
    // Every caller logs `detail` and a run shows it. A provider that quotes
    // the header it was sent is ordinary.
    readable(
      provider("Recall Engine", {
        observe: async () => {
          throw new Error(`401: Authorization "Token ${SECRET}" rejected`);
        },
        recall: async () => ({ ok: false, code: "rejected", detail: `key ${SECRET} is not allowed` }),
      }),
    );
    const memory = await activeMemory();

    const write = await memory.observe(OBSERVE);
    const read = await memory.recall(RECALL);

    expect(write).toEqual({
      ok: false,
      code: "unavailable",
      detail: 'Recall Engine failed to store it: 401: Authorization "Token [redacted]" rejected',
    });
    expect(read).toEqual({ ok: false, code: "rejected", detail: "key [redacted] is not allowed" });
  });

  it("takes it out of what the admin half throws, and still lets it throw", async () => {
    readable(
      provider("Recall Engine", {
        recall: vi.fn(),
        observe: vi.fn(),
        store: {
          list: async () => {
            throw new Error(`listing refused for ${SECRET}`);
          },
          read: vi.fn(),
          forget: vi.fn(),
        },
      }),
    );

    await expect((await activeMemory()).store?.list({})).rejects.toThrow(
      "listing refused for [redacted]",
    );
  });
});

describe("what an observation carries out of this deployment", () => {
  // A token an admin pasted into the dashboard is decrypted from the database
  // and never reaches the environment, so an engine's own code cannot know it.
  // Core takes it out before the engine sees the text, for every provider.
  const STORED_TOKEN = "stored-dashboard-token-5e1f0c";
  const written = { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 } as const;

  it("hands a connected engine every text with this deployment's secrets taken out", async () => {
    knownSecretValues.mockResolvedValue([STORED_TOKEN]);
    const observe = vi.fn<MemoryAdapter["observe"]>(async () => written);
    readable(provider("Recall Engine", { recall: vi.fn(), observe }));
    const memory = await activeMemory();

    await memory.observe({
      ...OBSERVE,
      observation: {
        kind: "items",
        learned: [`Deploy with ${STORED_TOKEN} in the header`],
        refuted: [`The token ${STORED_TOKEN} is read from .env`],
        derived: true,
      },
    });
    await memory.observe({
      ...OBSERVE,
      scope: { kind: "notebook", name: "AIW-1" },
      observation: { kind: "document", text: `curl -H "x-key: ${STORED_TOKEN}"`, sourceTruncated: true },
    });

    expect(JSON.stringify(observe.mock.calls)).not.toContain(STORED_TOKEN);
    expect(observe.mock.calls.map(([request]) => request.observation)).toEqual([
      {
        kind: "items",
        learned: ["Deploy with [REDACTED:configured_secret] in the header"],
        refuted: ["The token [REDACTED:configured_secret] is read from .env"],
        derived: true,
      },
      {
        kind: "document",
        text: 'curl -H "x-key: [REDACTED:configured_secret]"',
        sourceTruncated: true,
      },
    ]);
    // Addresses are core's, compared exactly: rewriting one would orphan what
    // is stored under it, so they arrive as they were sent.
    expect(observe.mock.calls[1]?.[0]).toMatchObject({
      subject: SUBJECT,
      scope: { kind: "notebook", name: "AIW-1" },
      runId: "run_1",
    });
  });

  it("cleans what the built-in store is given in the same place", async () => {
    // One home for the rule: the built-in store no longer scrubs for itself.
    knownSecretValues.mockResolvedValue([STORED_TOKEN]);
    readable();

    await (await activeMemory()).observe({
      ...OBSERVE,
      observation: { kind: "items", learned: [`uses ${STORED_TOKEN}`], refuted: [] },
    });

    expect(builtinObserve).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: { kind: "items", learned: ["uses [REDACTED:configured_secret]"], refuted: [] },
      }),
    );
  });

  it("sends nothing when the secrets to take out cannot be read", async () => {
    // Fail closed. A smaller set here is a stored secret sent to a third party
    // in the clear, and nobody would ever see that it happened.
    const { IntegrationSecretsUnreadableError } = await import(
      "../../services/integrations/secret-values.js"
    );
    knownSecretValues.mockRejectedValue(new IntegrationSecretsUnreadableError(new Error("db down")));
    const observe = vi.fn<MemoryAdapter["observe"]>(async () => written);
    readable(provider("Recall Engine", { recall: vi.fn(), observe }));

    const write = await (await activeMemory()).observe(OBSERVE);

    expect(write).toEqual({
      ok: false,
      code: "unavailable",
      detail: expect.stringContaining("could not be read"),
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("sends nothing it could not clean", async () => {
    knownSecretValues.mockResolvedValue([STORED_TOKEN]);
    redaction.broken = true;
    const observe = vi.fn<MemoryAdapter["observe"]>(async () => written);
    readable(provider("Recall Engine", { recall: vi.fn(), observe }));

    const write = await (await activeMemory()).observe(OBSERVE);

    expect(write).toEqual({
      ok: false,
      code: "rejected",
      detail: expect.stringContaining("could not be scrubbed"),
    });
    expect(observe).not.toHaveBeenCalled();
  });
});
