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
/** The built-in store's admin half: empty and complete unless a case says otherwise. */
const builtinStore = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  forget: vi.fn(),
}));
/** Makes building the built-in store throw, which nothing should let escape. */
const builtinLoad = vi.hoisted(() => ({ broken: false }));
vi.mock("../../memory/builtin/adapter.js", () => ({
  BUILTIN_MEMORY_PROVIDER_ID: "builtin",
  BUILTIN_MEMORY_PROVIDER_NAME: "Built-in memory",
  builtinMemoryAdapter: () => {
    if (builtinLoad.broken) throw new Error("the built-in adapter failed to load");
    return {
      recall: builtinRecall,
      observe: builtinObserve,
      store: builtinStore,
    };
  },
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
const NOTEBOOK_SUBJECT = { key: "ticket:jira:AIW-1", label: "AIW-1" };
const NOTEBOOK_RECALL = { subject: NOTEBOOK_SUBJECT, scope: { kind: "notebook", name: "AIW-1" } } as const;
const NOTEBOOK_OBSERVE = {
  ...NOTEBOOK_RECALL,
  runId: "run_1",
  ticketKey: "AIW-1",
  observation: { kind: "document", text: "# AIW-1\n- the plan" },
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
  builtinLoad.broken = false;
  knownSecretValues.mockResolvedValue([]);
  builtinRecall.mockResolvedValue({ ok: true, held: false, entries: [], rendering: "" });
  builtinObserve.mockResolvedValue({
    ok: true,
    stored: true,
    removed: 0,
    dropped: 0,
    remaining: 1,
  });
  builtinStore.list.mockResolvedValue({ documents: [], complete: true });
  builtinStore.read.mockResolvedValue(null);
  builtinStore.forget.mockResolvedValue(false);
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

  it("keeps every notebook in the built-in store, and the engine never sees one", async () => {
    // A notebook is a document a run reads back byte for byte, and an engine
    // that extracts and merges what it is given may rewrite it. Mistake that
    // turns this red: resolving a notebook's store like facts and lessons.
    const recall = vi.fn<MemoryAdapter["recall"]>(async () => ({
      ok: true,
      held: false,
      entries: [],
      rendering: "",
    }));
    const observe = vi.fn<MemoryAdapter["observe"]>(async () => ({
      ok: true,
      stored: true,
      removed: 0,
      dropped: 0,
      remaining: 1,
    }));
    readable(provider("Recall Engine", { recall, observe }));
    builtinRecall.mockResolvedValue({
      ok: true,
      held: true,
      entries: [{ text: "# AIW-1" }],
      rendering: "# AIW-1",
    });

    const memory = await activeMemory();

    expect(memory.id).toBe("recall engine");
    expect(await memory.recall(NOTEBOOK_RECALL)).toEqual({
      ok: true,
      held: true,
      entries: [{ text: "# AIW-1" }],
      rendering: "# AIW-1",
    });
    expect(await memory.observe(NOTEBOOK_OBSERVE)).toMatchObject({ ok: true, stored: true });
    await memory.recall(RECALL);
    await memory.observe(OBSERVE);

    expect(builtinRecall.mock.calls).toEqual([[NOTEBOOK_RECALL]]);
    expect(builtinObserve.mock.calls).toEqual([[NOTEBOOK_OBSERVE]]);
    // Facts and lessons are still the engine's, and only they.
    expect(recall.mock.calls).toEqual([[RECALL]]);
    expect(observe.mock.calls).toEqual([[OBSERVE]]);
  });

  it("names the built-in store when it cannot answer for a notebook", async () => {
    // The run shows this sentence on a deployment an engine serves; a bare
    // driver message there reads as the engine failing.
    readable(provider("Recall Engine", { recall: vi.fn(), observe: vi.fn() }));
    builtinRecall.mockResolvedValue({ ok: false, code: "unavailable", detail: "connection terminated" });

    expect(await (await activeMemory()).recall(NOTEBOOK_RECALL)).toEqual({
      ok: false,
      code: "unavailable",
      detail: "notebooks are kept in the built-in store, which could not answer: connection terminated",
    });
  });

  it("answers a refusal rather than throwing when the built-in store cannot be built for a notebook", async () => {
    readable(provider("Recall Engine", { recall: vi.fn(), observe: vi.fn() }));
    builtinLoad.broken = true;
    const memory = await activeMemory();

    // Named once: the store that could not be loaded, and why.
    const refusal = {
      ok: false,
      code: "unreadable",
      detail: "the built-in store, which keeps notebooks, could not be loaded (the built-in adapter failed to load)",
    };
    expect(await memory.recall(NOTEBOOK_RECALL)).toEqual(refusal);
    expect(await memory.observe(NOTEBOOK_OBSERVE)).toEqual(refusal);
  });

  it("does not blame the built-in store for a notebook when this deployment's secrets could not be read", async () => {
    // The store was never asked: core refused before reaching it, and its
    // sentence already names the cause.
    readable(provider("Recall Engine", { recall: vi.fn(), observe: vi.fn() }));
    knownSecretValues.mockRejectedValue(new Error("settings unreadable"));
    const memory = await activeMemory();

    expect(await memory.recall(NOTEBOOK_RECALL)).toEqual({
      ok: false,
      code: "unavailable",
      detail: "this deployment's secrets could not be read, so memory was not read",
    });
    expect(await memory.observe(NOTEBOOK_OBSERVE)).toEqual({
      ok: false,
      code: "unavailable",
      detail: "this deployment's secrets could not be read, so nothing was written to memory",
    });
    expect(builtinObserve).not.toHaveBeenCalled();
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

  it("asks an engine that answers unavailable once, and hands the refusal on", async () => {
    // A write that timed out may have landed. Asking again could store it
    // twice, so core never repeats an observe: the next run's write is the retry.
    const refusal = { ok: false, code: "unavailable", detail: "the engine answered 503" } as const;
    const observe = vi.fn<MemoryAdapter["observe"]>(async () => refusal);
    readable(provider("Recall Engine", { recall: vi.fn(), observe }));

    const write = await (await activeMemory()).observe(OBSERVE);

    expect(write).toEqual(refusal);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("offers no admin half when the engine ships none", async () => {
    // An engine that cannot enumerate what it holds is fully usable for runs.
    // `store: null` is what stops a screen showing its silence as an empty
    // store.
    readable(provider("Recall Engine", { recall: vi.fn(), observe: vi.fn() }));

    expect((await activeMemory()).store).toBeNull();
  });

  it("holds a listing asked for one subject to that subject, and says an engine that ignored it is incomplete", async () => {
    // A port-contract check core applies to every provider: an engine that
    // ignores `subjectKey` answers the newest page of everything, so the
    // asked subject's older documents are simply missing from it. Passing
    // that on as complete would show a repository as having no memory.
    const summary = (subjectKey: string, docPath: string) => ({
      subjectKey,
      docPath,
      ticketKey: null,
      bytes: 1,
      sourceRunId: "",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const list = vi.fn(async () => ({
      documents: [summary("ticket:jira:AIW-1", "notebook"), summary(SUBJECT.key, "facts")],
      complete: true,
    }));
    readable(
      provider("Recall Engine", {
        recall: vi.fn(),
        observe: vi.fn(),
        store: { list, read: vi.fn(), forget: vi.fn() },
      }),
    );
    const store = (await activeMemory()).store;

    expect(await store?.list({ subjectKey: SUBJECT.key })).toEqual({
      documents: [summary(SUBJECT.key, "facts")],
      complete: false,
    });
    expect(list).toHaveBeenCalledWith({ subjectKey: SUBJECT.key });
    // Without a subject filter the same answer is the provider's to give.
    expect(await store?.list({})).toMatchObject({ complete: true });
  });

  it("passes on a listing that honoured the subject filter as the engine gave it", async () => {
    const listing = {
      documents: [
        {
          subjectKey: SUBJECT.key,
          docPath: "facts",
          ticketKey: null,
          bytes: 1,
          sourceRunId: "",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      complete: true,
    };
    readable(
      provider("Recall Engine", {
        recall: vi.fn(),
        observe: vi.fn(),
        store: { list: async () => listing, read: vi.fn(), forget: vi.fn() },
      }),
    );

    expect(await (await activeMemory()).store?.list({ subjectKey: SUBJECT.key })).toEqual(listing);
  });

  it("refuses when the engine declares memory and ships no code for it", async () => {
    readable(provider("Recall Engine", null));

    const memory = await activeMemory();

    expect(memory.refusal).toEqual({
      code: "no_provider",
      detail: expect.stringContaining("ships no code"),
      providers: ["recall engine"],
    });
    // NOT the built-in store. An admin who connected an engine and got our own
    // store instead would have their memory written somewhere they did not
    // choose and cannot see.
    expect(builtinRecall).not.toHaveBeenCalled();
  });
});

/**
 * The memory screen and the MCP tools on a deployment an engine serves. The
 * engine's admin half answers for facts and lessons; the ticket notebooks are
 * the built-in store's, so they are listed, read and erased there, or the
 * screen shows a complete listing without them and an erasure answers
 * "nothing there" for a notebook that is stored.
 */
describe("the admin half beside a connected engine", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 10, minute));
  const summary = (subjectKey: string, docPath: string, minute: number) => ({
    subjectKey,
    docPath,
    ticketKey: null,
    bytes: 1,
    sourceRunId: "",
    createdAt: at(minute),
    updatedAt: at(minute),
  });
  const engineStore = (documents: ReturnType<typeof summary>[], complete = true) => ({
    list: vi.fn(async () => ({ documents, complete })),
    read: vi.fn(async () => null),
    forget: vi.fn(async () => true),
  });
  const engineWith = (store: ReturnType<typeof engineStore>) =>
    readable(provider("Recall Engine", { recall: vi.fn(), observe: vi.fn(), store }));

  it("lists the built-in store's notebooks beside the engine's documents, newest first, and none of its facts or lessons", async () => {
    engineWith(engineStore([summary(SUBJECT.key, "facts", 20), summary(NOTEBOOK_SUBJECT.key, "notebook/AIW-1", 5)]));
    builtinStore.list.mockResolvedValue({
      documents: [
        summary("ticket:jira:AIW-2", "blazebot/memory/AIW-2.md", 40),
        summary(SUBJECT.key, "facts", 30),
        summary(NOTEBOOK_SUBJECT.key, "ai-workflow/memory/AIW-1.md", 10),
        summary(SUBJECT.key, "lessons", 1),
      ],
      complete: true,
    });

    expect(await (await activeMemory()).store?.list({ ticketKey: "AIW-1" })).toEqual({
      documents: [
        summary("ticket:jira:AIW-2", "blazebot/memory/AIW-2.md", 40),
        summary(SUBJECT.key, "facts", 20),
        summary(NOTEBOOK_SUBJECT.key, "ai-workflow/memory/AIW-1.md", 10),
        summary(NOTEBOOK_SUBJECT.key, "notebook/AIW-1", 5),
      ],
      complete: true,
    });
    // Both asked the same question.
    expect(builtinStore.list).toHaveBeenCalledWith({ ticketKey: "AIW-1" });
  });

  it("says the listing may be partial when the built-in store's is, or when it cannot answer, and still lists the engine's", async () => {
    const engine = engineStore([summary(SUBJECT.key, "facts", 20)]);
    engineWith(engine);
    builtinStore.list.mockResolvedValue({
      documents: [summary(NOTEBOOK_SUBJECT.key, "ai-workflow/memory/AIW-1.md", 10)],
      complete: false,
    });
    expect(await (await activeMemory()).store?.list({})).toMatchObject({ complete: false });

    builtinStore.list.mockRejectedValue(new Error("connection terminated"));
    expect(await (await activeMemory()).store?.list({})).toEqual({
      documents: [summary(SUBJECT.key, "facts", 20)],
      complete: false,
    });
  });

  it("cuts a listing asked for a limit to that many, newest first, and says it is partial", async () => {
    engineWith(engineStore([summary(SUBJECT.key, "facts", 20), summary(SUBJECT.key, "lessons", 5)]));
    builtinStore.list.mockResolvedValue({
      documents: [summary(NOTEBOOK_SUBJECT.key, "ai-workflow/memory/AIW-1.md", 10)],
      complete: true,
    });

    expect(await (await activeMemory()).store?.list({ limit: 2 })).toEqual({
      documents: [
        summary(SUBJECT.key, "facts", 20),
        summary(NOTEBOOK_SUBJECT.key, "ai-workflow/memory/AIW-1.md", 10),
      ],
      complete: false,
    });
  });

  it("sends a read and an erasure of a built-in notebook to the built-in store, and every other address to the engine", async () => {
    const engine = engineStore([]);
    engineWith(engine);
    builtinStore.read.mockResolvedValue({ content: "# AIW-1", bytes: 7, updatedAt: at(1), sourceRunId: "run_1" });
    builtinStore.forget.mockResolvedValue(true);
    const store = (await activeMemory()).store;
    const current = { subjectKey: NOTEBOOK_SUBJECT.key, docPath: "ai-workflow/memory/AIW-1.md" };
    const legacy = { subjectKey: NOTEBOOK_SUBJECT.key, docPath: "blazebot/memory/AIW-1.md" };
    const engines = [
      { subjectKey: NOTEBOOK_SUBJECT.key, docPath: "notebook/AIW-1" },
      { subjectKey: SUBJECT.key, docPath: "facts" },
    ];

    expect(await store?.read(current)).toMatchObject({ content: "# AIW-1" });
    expect(await store?.forget(legacy)).toBe(true);
    for (const ref of engines) {
      await store?.read(ref);
      await store?.forget(ref);
    }

    expect(builtinStore.read.mock.calls).toEqual([[current]]);
    expect(builtinStore.forget.mock.calls).toEqual([[legacy]]);
    expect(engine.read.mock.calls).toEqual(engines.map((ref) => [ref]));
    expect(engine.forget.mock.calls).toEqual(engines.map((ref) => [ref]));
  });

  it("names the built-in store when it fails to read or erase a notebook", async () => {
    // On this deployment the screen puts the engine's name in front of what a
    // store threw; a bare driver message there reads as the engine failing.
    engineWith(engineStore([]));
    builtinStore.forget.mockRejectedValue(new Error("connection terminated"));

    await expect(
      (await activeMemory()).store?.forget({
        subjectKey: NOTEBOOK_SUBJECT.key,
        docPath: "ai-workflow/memory/AIW-1.md",
      }),
    ).rejects.toThrow("notebooks are kept in the built-in store, which could not answer: connection terminated");
  });

  it("offers no admin half while the engine refuses, rather than a listing of notebooks alone", async () => {
    // A listing of the notebooks by themselves would read as the whole of this
    // deployment's memory; the refusal says why nothing can be listed.
    deployment([], [
      { name: "Recall Engine", state: { status: "failing", connection: "failing", usable: false } },
    ]);

    const memory = await activeMemory();
    expect(memory.refusal).toMatchObject({ code: "unavailable" });
    expect(memory.store).toBeNull();
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
      providers: ["recall engine", "second engine"],
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
      providers: [],
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
      providers: [],
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
      providers: ["recall engine"],
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
      providers: ["recall engine"],
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
      providers: ["recall engine"],
    });
    expect(await memory.observe(OBSERVE)).toMatchObject({ ok: false, code: "unavailable" });
    expect(builtinObserve).not.toHaveBeenCalled();
  });

  it("still keeps notebooks, which the built-in store serves whatever state the engine is in", async () => {
    // The refusal is about facts and lessons. Refusing the notebook too would
    // start the agent without its plan and the human decisions, for an engine
    // the notebook never depended on.
    deployment([], [
      {
        name: "Recall Engine",
        state: { status: "failing", connection: "failing", usable: false },
      },
    ]);

    const memory = await activeMemory();

    expect(memory.refusal).toMatchObject({ code: "unavailable" });
    expect(await memory.observe(NOTEBOOK_OBSERVE)).toMatchObject({ ok: true, stored: true });
    expect(builtinObserve.mock.calls).toEqual([[NOTEBOOK_OBSERVE]]);
    expect(await memory.observe(OBSERVE)).toMatchObject({ ok: false, code: "unavailable" });
    expect(builtinObserve).toHaveBeenCalledTimes(1);
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
      // The failing one is named too: it is the one an admin may mean to
      // switch off, and a page that listed only the working one hid it.
      providers: ["recall engine", "second engine"],
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

describe("the secrets memory text carries in and out of this deployment", () => {
  // A token an admin pasted into the dashboard is decrypted from the database
  // and never reaches the environment, so an engine's own code cannot know it.
  // Core takes it out before the engine sees the text, for every provider.
  const STORED_TOKEN = "stored-dashboard-token-5e1f0c";
  const written = { ok: true, stored: true, removed: 0, dropped: 0, remaining: 1 } as const;

  it("hands a connected engine, and the built-in store keeping notebooks beside it, every text with this deployment's secrets taken out", async () => {
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
    ]);
    expect(builtinObserve.mock.calls.map(([request]) => request.observation)).toEqual([
      {
        kind: "document",
        text: 'curl -H "x-key: [REDACTED:configured_secret]"',
        sourceTruncated: true,
      },
    ]);
  });

  it("leaves core's addresses as they were sent, even when a secret is spelled in them", async () => {
    // Addresses are core's, compared exactly: rewriting one would orphan what
    // is stored under it. A known value inside one is the case that tells
    // "left alone" from "happened not to match". A notebook's address reaches
    // the built-in store whichever engine is connected.
    knownSecretValues.mockResolvedValue([STORED_TOKEN]);
    const observe = vi.fn<MemoryAdapter["observe"]>(async () => written);
    readable(provider("Recall Engine", { recall: vi.fn(), observe }));
    const addressed = {
      subject: { key: `ticket:jira:${STORED_TOKEN}`, label: STORED_TOKEN },
      scope: { kind: "notebook", name: STORED_TOKEN },
      runId: `run_${STORED_TOKEN}`,
      ticketKey: STORED_TOKEN,
    } as const;

    await (await activeMemory()).observe({
      ...addressed,
      observation: { kind: "document", text: `uses ${STORED_TOKEN}` },
    });

    expect(builtinObserve.mock.calls[0]?.[0]).toEqual({
      ...addressed,
      observation: { kind: "document", text: "uses [REDACTED:configured_secret]" },
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("takes a secret out of everything a recall hands back, rendering and entries", async () => {
    // An engine can hold a value it stored before that value was a known
    // secret. The rendering reaches a prompt and a workspace, the entries reach
    // the model that distils; a retraction still works, because the quote is
    // cleaned again on its way back.
    knownSecretValues.mockResolvedValue([STORED_TOKEN]);
    const recall = vi.fn<MemoryAdapter["recall"]>(async () => ({
      ok: true,
      held: true,
      entries: [{ text: `Deploy with ${STORED_TOKEN} in the header` }],
      rendering: `- Deploy with ${STORED_TOKEN} in the header`,
    }));
    readable(provider("Recall Engine", { recall, observe: vi.fn() }));

    const recalled = await (await activeMemory()).recall(RECALL);

    expect(JSON.stringify(recalled)).not.toContain(STORED_TOKEN);
    expect(recalled).toEqual({
      ok: true,
      held: true,
      entries: [{ text: "Deploy with [REDACTED:configured_secret] in the header" }],
      rendering: "- Deploy with [REDACTED:configured_secret] in the header",
    });
  });

  it("uses nothing it recalled when the secrets to take out cannot be read", async () => {
    const { IntegrationSettingsUnreadableError } = await import(
      "../../services/integrations/secret-values.js"
    );
    knownSecretValues.mockRejectedValue(new IntegrationSettingsUnreadableError("so the secrets they hold could not be redacted", new Error("db down")));
    readable(
      provider("Recall Engine", {
        recall: async () => ({ ok: true, held: true, entries: [], rendering: "- a fact" }),
        observe: vi.fn(),
      }),
    );

    expect(await (await activeMemory()).recall(RECALL)).toEqual({
      ok: false,
      code: "unavailable",
      detail: "this deployment's secrets could not be read, so memory was not read",
    });
  });

  it("reads the secret set once for every call a step makes", async () => {
    // One resolution serves one step. Reading the connection tables per
    // document would cost a prompt with eight repositories seventeen reads.
    knownSecretValues.mockResolvedValue([STORED_TOKEN]);
    readable(
      provider("Recall Engine", {
        recall: async () => ({ ok: true, held: true, entries: [], rendering: "- a fact" }),
        observe: async () => written,
      }),
    );
    const memory = await activeMemory();

    await memory.recall(RECALL);
    await memory.recall(RECALL);
    await memory.observe(OBSERVE);
    // A notebook goes to the built-in store, and still costs no second read.
    await memory.observe(NOTEBOOK_OBSERVE);

    expect(builtinObserve).toHaveBeenCalledTimes(1);
    expect(knownSecretValues).toHaveBeenCalledTimes(1);
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
    const { IntegrationSettingsUnreadableError } = await import(
      "../../services/integrations/secret-values.js"
    );
    knownSecretValues.mockRejectedValue(new IntegrationSettingsUnreadableError("so the secrets they hold could not be redacted", new Error("db down")));
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
