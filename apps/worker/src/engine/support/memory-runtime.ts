/**
 * Memory, as core reaches it.
 *
 * Core says what a run learned about a subject and asks what is known about
 * it; which provider answers is the deployment's business, resolved here and
 * nowhere else. Nothing in this file names a provider.
 *
 * ONE FACT SETS THIS APART FROM EVERY OTHER CAPABILITY, and the whole shape of
 * this module follows from it: **core can serve memory by itself**. The
 * built-in store lives in core because it needs core's database (ADR-010
 * decision 10), so "no integration serves memory" is not a deployment with
 * nothing connected, it is the default deployment, and it must keep exactly
 * the memory it has. Connecting a memory integration REPLACES the provider; it
 * does not supply the first one. A deployment that never opens the
 * Integrations page therefore behaves as it did before this stage existed.
 *
 * NEVER THROWS, and never returns a broken object. Resolution that fails hands
 * back an `ActiveMemory` whose every call answers the refusal, carrying the
 * sentence a person reads. That is the `vcsWithoutRepository` pattern in
 * `adapters.ts` rather than a getter that explodes: memory is reached from
 * teardown paths, from a poll pass and from the dashboard, and a property that
 * throws on read turns those into a failure far from the call that was wrong.
 * ADR-010 decision 12 states the rule this implements: a run that cannot reach
 * memory continues without it AND SAYS SO.
 *
 * ONE SCOPE IS NEVER THE SELECTED PROVIDER'S: the ticket notebook. It is a
 * document a run writes into the workspace and reads back byte for byte, so
 * the built-in store keeps it on every deployment and a connected engine only
 * ever serves facts and lessons (`withNotebooksInBuiltin`).
 */
import type {
  IntegrationConnectionPin,
  IntegrationUnavailableReason,
} from "@shared/contracts";
import type { IntegrationRedaction } from "../../services/integrations/runtime.js";
import {
  KNOWN_SECRETS_UNREADABLE,
  knownSecretsReader,
  takeOutKnownSecrets,
  unscrubbedWrite,
  type KnownSecretCleaner,
  type KnownSecretsReader,
} from "../../memory/known-secrets.js";
import { recordedPinFor } from "./recorded-pins.js";
import type {
  IntegrationManifest,
  MemoryAdapter,
  MemoryFailure,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryStoreAdapter,
  MemoryStoreListing,
  MemoryObserveRequest,
  MemoryWrite,
} from "@integrations/sdk";

/**
 * How long one `ActiveMemory` may spend waiting on a connected provider,
 * summed over every call made through it. Time between calls (a model call
 * between a distill's reads and its writes) is not counted, because it is not
 * memory's.
 *
 * Why a budget at all: each request is bounded on its own (30 s an attempt, and
 * a read tries three times), so an engine that accepts connections and never
 * answers costs every call its full bound. A distill over six repositories
 * makes 19 calls, which is about ten minutes of a run waiting on a dead
 * dependency before it can finish.
 *
 * Why 60 s: it is two full attempts, so a single slow answer never trips it,
 * and 19 calls to a healthy engine answering in a second or two each fit
 * inside it. And it keeps the worst case of the longest memory step in reach:
 * a distill is at most its model call (capped at 90 s where the run calls it)
 * plus this, well inside the 300 s a plain function is killed at. Past it the
 * run goes on without memory and says so, which is what ADR-010 decision 12
 * asks of every memory failure.
 */
export const MEMORY_CALL_BUDGET_MS = 60_000;

/** Why nothing could answer, in a sentence a person reads in a log and on a screen. */
interface MemoryRefusal {
  readonly code: MemoryFailure;
  readonly detail: string;
  /**
   * The integrations this refusal is about, in registry order: every chosen
   * one for `ambiguous`, the one chosen for `unavailable`, `moved` and
   * `no_provider`, none for `unreadable`. Carried so a page that shows the
   * decision (the Integrations page's capability overview) names who it is
   * about from the resolver's own answer rather than working it out again.
   */
  readonly providers: readonly string[];
}

/**
 * The provider serving memory on this deployment, already resolved.
 *
 * Resolved ONCE and handed to a caller that then makes many calls, unlike
 * `messagingSender`, which resolves per call. A notification is a handful of
 * calls a run; reading memory is up to `1 + 2N` reads on the critical path
 * before an agent starts, and a connection read per document would put a
 * database round trip in front of each one.
 *
 * The cost of holding it is that a provider disabled in the middle of a step
 * keeps serving until the step ends. That is the smaller of the two, and it is
 * bounded by the step rather than by the life of the process.
 *
 * A connected provider's calls share one budget of waiting time
 * (`MEMORY_CALL_BUDGET_MS`), so resolve one per step and never keep one
 * across steps: once the budget is spent, every call answers `unavailable`
 * without reaching the provider.
 */
export interface ActiveMemory {
  /** `builtin`, or the id of the integration serving `memory` (its facts and
   *  lessons; notebooks are always `builtin`'s). Null when nothing could be resolved. */
  readonly id: string | null;
  /** What to call it in a sentence a person reads. */
  readonly name: string;
  /**
   * Non-null when nothing serves facts and lessons here, in which case every
   * call about them below answers exactly this. A notebook call is the
   * built-in store's either way and answers for itself. Readable without
   * making a call, so a caller that would otherwise do expensive work first
   * (deriving facts out of a checkout) can skip it and report once.
   */
  readonly refusal: MemoryRefusal | null;
  /**
   * The admin half, or null when this provider cannot enumerate what it holds.
   * Null is not an empty store and a screen must not show it as one. Beside a
   * connected engine it carries the built-in store's notebooks too
   * (`withBuiltinNotebooks`).
   */
  readonly store: MemoryStoreAdapter | null;
  recall(request: MemoryRecallRequest): Promise<MemoryRecall>;
  observe(request: MemoryObserveRequest): Promise<MemoryWrite>;
}

/**
 * WHO CATCHES A THROW OUT OF THIS FUNCTION: nobody has to, because it does not
 * throw. Everything inside is wrapped, including the deferred imports, and an
 * unexpected failure becomes the `unreadable` refusal carrying what threw.
 *
 * That is deliberately unlike `resolveActiveIssueTracker`, which lets a throw
 * out so that exactly one caller contains it. The difference is that reaching
 * for a tracker means a caller decided it is working on a ticket, while memory
 * is reached from teardown, from a poll pass and from a prompt build, none of
 * which may fail because an optional optimisation could not be resolved.
 */
export async function activeMemory(
  /**
   * What the run recorded about its integrations when it started.
   *
   * NOTHING PASSES THIS TODAY, and that sentence has to come first because the
   * comparison below reads like a protection that operates. What it would do
   * is hold a run to the memory provider it started with, so that connecting
   * an engine mid-run could not move where a run's notebook is captured.
   *
   * No memory call site threads pins yet, and adding one would change the
   * recorded input shape of a `"use step"` function, which strands every run
   * suspended inside it. So it is wired and unused, exactly as the tracker's
   * pin check is, and the drain note for this stage says so. Nothing about
   * this stage rests on it operating.
   *
   * It is also why the built-in provider is checked FIRST: on the default
   * deployment no integration serves memory, so a run that carries pins naming
   * other integrations never reaches this comparison and never reads as
   * "memory moved".
   */
  pins?: readonly IntegrationConnectionPin[],
): Promise<ActiveMemory> {
  // One reader of the secret set for the whole step, whichever store answers a
  // call: the provider of facts and lessons, or the built-in store beside it.
  const knownSecrets = knownSecretsReader();
  const selected = await selectedProvider(pins, knownSecrets);
  if (selected === BUILTIN_SERVES_ALL) return await builtinActiveMemory(knownSecrets);
  return withNotebooksInBuiltin(selected, knownSecrets);
}

/** `selectedProvider`'s answer when nothing is connected, so the built-in store
 *  serves facts, lessons and notebooks alike and there is nothing to route. */
const BUILTIN_SERVES_ALL: unique symbol = Symbol("the built-in store serves all memory");

/**
 * Who serves facts and lessons on this deployment right now, or the refusal
 * saying why nothing can. Never throws, for the reasons `activeMemory` gives.
 */
async function selectedProvider(
  pins: readonly IntegrationConnectionPin[] | undefined,
  knownSecrets: KnownSecretsReader,
): Promise<ActiveMemory | typeof BUILTIN_SERVES_ALL> {
  try {
    const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");
    // The provider's context lives exactly as long as the budget below lets it:
    // this controller is its lifetime and the budget is what aborts it.
    const lifetime = new AbortController();
    const resolved = await resolveUsableIntegrations({
      lifetime: lifetime.signal,
      filter: servesMemory,
    });
    if (!resolved.readable) {
      // NOT a fall back to the built-in store, and the reason is worth keeping.
      // Falling back would look like the safer choice, and on a deployment
      // running a hosted engine it would silently split that deployment's
      // memory across two stores, with nobody told. It also buys nothing: the
      // integration settings and the built-in store are rows in the SAME
      // database, so a read that could not reach one could not have reached
      // the other.
      return refusing({
        code: "unreadable",
        detail: `this deployment's integration settings could not be read (${resolved.reason}), so memory was not used`,
        providers: [],
      });
    }
    // Who answers memory here is one rule, shared with the palette
    // (`memoryProviderChoice`), read off the resolver's own states and never
    // derived here a second time.
    const { integrationManifests } = await import("@integrations/registry");
    const { memoryNotServedReason, memoryProviderChoice } = await import(
      "../definition/integration-availability.js"
    );
    const choice = memoryProviderChoice(
      integrationManifests.map((manifest) => ({
        id: manifest.id,
        capabilities: manifest.capabilities,
        status: resolved.states.get(manifest.id)?.status ?? "not_connected",
      })),
    );
    if (choice.kind === "builtin") {
      // The default, and the common case: nothing is connected (or what is
      // connected is disabled, which is the admin's choice), so the built-in
      // store serves. This is not a refusal and never reports one.
      return BUILTIN_SERVES_ALL;
    }
    const manifestOf = (id: string) => integrationManifests.find((manifest) => manifest.id === id);
    if (choice.kind === "ambiguous") {
      // Never a silent pick of the first. A run that wrote into one of two
      // connected engines because it happened to be first in the registry is
      // the failure an admin cannot explain afterwards. One rule decides it
      // for memory, the tracker and messaging alike (`oneProviderChoice`): a
      // failing one counts, because picking the one that happens to work today
      // is the same silent pick, and it moves the day the other one recovers.
      return refusing({
        code: "ambiguous",
        detail: memoryNotServedReason(
          { kind: "ambiguous", names: choice.ids.map((id) => manifestOf(id)?.name ?? id) },
          "run",
        ),
        providers: choice.ids,
      });
    }
    const selected = manifestOf(choice.id);
    const only =
      choice.kind === "integration"
        ? resolved.usable.find((entry) => entry.manifest.id === choice.id)
        : undefined;
    if (!selected || !only) {
      // Switched on and not working. NOT a fall back to the built-in store: the
      // admin believes this engine is serving, and writing into ours instead
      // would split this deployment's memory across two stores with nobody
      // told. The run goes on without memory and says why.
      return refusing({
        code: "unavailable",
        detail: memoryNotServedReason(
          {
            kind: "failing",
            name: selected?.name ?? "The memory integration",
            failure: selected ? resolved.states.get(selected.id)?.failure?.message : undefined,
          },
          "run",
        ),
        providers: selected ? [selected.id] : [],
      });
    }

    // An engine the run's pins do not name was connected after the run
    // started, and serving it would move where a run in flight remembers
    // things, mid-run (`recorded-pins.ts` is the rule).
    const recorded = recordedPinFor(pins, only.manifest.id, "one_per_deployment");
    if (recorded.kind !== "not_pinned") {
      const { checkIntegrationPin } = await import("../../services/integrations/runtime.js");
      const state = resolved.states.get(only.manifest.id);
      const check =
        recorded.kind === "pinned" && state
          ? checkIntegrationPin(recorded.pin, state)
          : ({ ok: false, reason: "disconnected" } as const);
      if (!check.ok) {
        return refusing({
          code: "moved",
          detail: movedReason(check.reason, only.manifest.name),
          providers: [only.manifest.id],
        });
      }
    }

    const factory = only.runtime.capabilities.memory;
    if (typeof factory !== "function") {
      return refusing({
        code: "no_provider",
        detail: `${only.manifest.name} declares memory and ships no code for it, so memory was not used`,
        providers: [only.manifest.id],
      });
    }
    const adapter = (factory as (ctx: unknown) => MemoryAdapter)(only.ctx);
    return wrap(only.manifest.id, only.manifest.name, adapter, {
      redaction: only.redaction,
      budget: memoryBudget(only.manifest.name, lifetime, MEMORY_CALL_BUDGET_MS),
      knownSecrets,
    });
  } catch (error) {
    return refusing({
      code: "unreadable",
      detail: `this deployment's memory provider could not be resolved (${
        error instanceof Error ? error.message : String(error)
      }), so memory was not used`,
      providers: [],
    });
  }
}

/**
 * The built-in store, or the refusal saying it could not be loaded. Never
 * throws.
 *
 * `besideEngine` when it keeps only the notebooks, next to an engine serving
 * facts and lessons. Its own refusals and throws then say which store they
 * came from, because on that deployment a bare database message reads as the
 * engine failing. What core refuses around it (the secret set it could not
 * read) already names its cause, and is left as it is.
 */
async function builtinActiveMemory(
  knownSecrets: KnownSecretsReader,
  besideEngine = false,
): Promise<ActiveMemory> {
  try {
    const { builtinMemoryAdapter, BUILTIN_MEMORY_PROVIDER_ID, BUILTIN_MEMORY_PROVIDER_NAME } =
      await import("../../memory/builtin/adapter.js");
    const adapter = builtinMemoryAdapter(knownSecrets);
    // No budget and nothing to redact: the built-in store is core's own
    // database, bounded where every other query is, and holds no connection.
    // One reader of the secret set for the wrapper and the store together, so
    // cleaning what the store holds costs the step no second read.
    return wrap(
      BUILTIN_MEMORY_PROVIDER_ID,
      BUILTIN_MEMORY_PROVIDER_NAME,
      besideEngine ? namingTheNotebookStore(adapter) : adapter,
      { redaction: NOTHING_TO_REDACT, budget: UNBOUNDED, knownSecrets },
    );
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return refusing({
      code: "unreadable",
      detail: besideEngine
        ? `the built-in store, which keeps notebooks, could not be loaded (${said})`
        : `the built-in store could not be loaded (${said}), so memory was not used`,
      providers: [],
    });
  }
}

/** The built-in adapter, every answer and throw of its own saying it is the
 *  store that keeps notebooks (see `besideEngine` above). */
function namingTheNotebookStore(adapter: MemoryAdapter): MemoryAdapter {
  const named = (detail: string) =>
    `notebooks are kept in the built-in store, which could not answer: ${detail}`;
  const rethrown = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw new Error(named(error instanceof Error ? error.message : String(error)), {
        cause: error,
      });
    }
  };
  const { store } = adapter;
  const namedStore: MemoryStoreAdapter | undefined = store && {
    list: (options) => rethrown(() => store.list(options)),
    read: (ref) => rethrown(() => store.read(ref)),
    forget: (ref) => rethrown(() => store.forget(ref)),
  };
  return {
    async recall(request) {
      const answer = await adapter.recall(request);
      return answer.ok ? answer : { ...answer, detail: named(answer.detail) };
    },
    async observe(request) {
      const answer = await adapter.observe(request);
      return answer.ok ? answer : { ...answer, detail: named(answer.detail) };
    },
    ...(namedStore ? { store: namedStore } : {}),
  };
}

/**
 * The selected provider, with every notebook call answered by the built-in
 * store instead.
 *
 * A notebook is a document a run hydrates into the workspace and stores back
 * byte for byte: the plan, the human decisions from clarification rounds, the
 * notes for the next run on the ticket. An engine that extracts and
 * consolidates what it is given (Mem0 does both) may rewrite or merge it, and
 * the next run would start from the engine's version of what a person
 * decided. So the built-in store keeps notebooks on every deployment, and no
 * notebook call reaches an engine: not the hydration, not the capture, not
 * the distill reading what the run wrote down.
 *
 * Everything else is the selected provider's, refusal included: `id` and
 * `name` still describe it, and `store` is its admin half with the built-in
 * store's notebooks in it (`withBuiltinNotebooks`). An engine that is failing,
 * or two switched on at once, refuse facts and lessons and leave notebooks
 * working, because the built-in store never depended on them. It is loaded on
 * the first notebook call, so a step that makes none pays nothing for it.
 */
function withNotebooksInBuiltin(
  selected: ActiveMemory,
  knownSecrets: KnownSecretsReader,
): ActiveMemory {
  let builtin: Promise<ActiveMemory> | undefined;
  const notebooks = () => (builtin ??= builtinActiveMemory(knownSecrets, true));
  return {
    ...selected,
    store: selected.store && withBuiltinNotebooks(selected.store, notebooks),
    async recall(request) {
      if (request.scope.kind !== "notebook") return selected.recall(request);
      return (await notebooks()).recall(request);
    },
    async observe(request) {
      if (request.scope.kind !== "notebook") return selected.observe(request);
      return (await notebooks()).observe(request);
    },
  };
}

/**
 * Where the built-in store files a notebook: the directory runs write to and
 * the one older runs wrote to. Spelled again here because the admin half is
 * addressed by these strings alone; `memory/builtin/adapter.ts` owns them and
 * neither may ever be renamed. The route suite writes and reads a notebook
 * through the real store, so the two drifting apart is a red test.
 * An engine's own notebook addresses (Mem0's are `notebook/<KEY>`) stay its.
 */
const BUILTIN_NOTEBOOK_DIRECTORIES = ["ai-workflow/memory/", "blazebot/memory/"] as const;

function isBuiltinNotebook(docPath: string): boolean {
  return BUILTIN_NOTEBOOK_DIRECTORIES.some((directory) => docPath.startsWith(directory));
}

/**
 * An engine's admin half, with the notebooks the built-in store keeps beside
 * it: listed with the engine's documents, and read and erased where they are.
 * Without it the memory screen and the MCP tools show a complete listing that
 * leaves the notebooks out, find no document at a notebook's address and
 * answer an erasure request for one with "nothing there", while it still
 * holds what people answered, by name.
 *
 * Only the built-in store's notebooks: what else it holds (facts and lessons
 * from before the engine was connected) nothing serves while the engine does,
 * and the screen shows what runs use. The listing is complete only when both
 * are, so an engine that stopped early, a built-in listing cut at its cap, or
 * one that could not be read says "this may not be everything". The engine's
 * failure still fails the listing, as it always has.
 */
function withBuiltinNotebooks(
  engine: MemoryStoreAdapter,
  builtin: () => Promise<ActiveMemory>,
): MemoryStoreAdapter {
  const builtinStore = async (): Promise<MemoryStoreAdapter> => {
    const loaded = await builtin();
    if (!loaded.store) throw new Error(loaded.refusal?.detail ?? "the built-in store keeps no admin half");
    return loaded.store;
  };
  return {
    async list(options) {
      const [held, notebooks] = await Promise.all([
        engine.list(options),
        builtinNotebookListing(builtinStore, options),
      ]);
      // Newest first across both, as the port asks of one listing. A stable
      // sort, so documents written in the same instant keep each store's order.
      const documents = [...held.documents, ...notebooks.documents].sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      );
      const kept = options.limit === undefined ? documents : documents.slice(0, options.limit);
      return {
        documents: kept,
        complete: held.complete && notebooks.complete && kept.length === documents.length,
      };
    },
    read: async (ref) =>
      isBuiltinNotebook(ref.docPath) ? (await builtinStore()).read(ref) : engine.read(ref),
    forget: async (ref) =>
      isBuiltinNotebook(ref.docPath) ? (await builtinStore()).forget(ref) : engine.forget(ref),
  };
}

/**
 * The built-in store's notebooks for this listing, or none and incomplete when
 * it could not answer: the engine's documents are still worth showing, and the
 * screen says the list may be partial. The reason goes to the log.
 */
async function builtinNotebookListing(
  builtinStore: () => Promise<MemoryStoreAdapter>,
  options: Parameters<MemoryStoreAdapter["list"]>[0],
): Promise<MemoryStoreListing> {
  try {
    const listing = await (await builtinStore()).list(options);
    return {
      documents: listing.documents.filter((document) => isBuiltinNotebook(document.docPath)),
      complete: listing.complete,
    };
  } catch (error) {
    try {
      const { logger } = await import("../../infra/logger.js");
      logger.warn(
        { store: "builtin", detail: error instanceof Error ? error.message : String(error) },
        "memory_list_notebooks_unavailable",
      );
    } catch {
      // The listing is still answered, and says it is partial; only the log is lost.
    }
    return { documents: [], complete: false };
  }
}

function servesMemory(manifest: IntegrationManifest): boolean {
  return manifest.capabilities.includes("memory");
}

/**
 * What core puts around a provider: the redaction for the words a refusal
 * RETURNS, and the budget its calls spend. (The secrets core takes out of the
 * text it sends and of the rendering it gets back are the same for every
 * provider and need no guard of their own: `withoutKnownSecrets` on every
 * observation, `recallWithoutKnownSecrets` on every recall.) What a provider throws needs no
 * redaction here: it comes from the runtime `usable.ts` built, which already
 * took the connection's secrets out of every error its adapters (and the
 * `store` inside them) throw.
 */
interface ProviderGuard {
  readonly redaction: Pick<IntegrationRedaction, "text">;
  readonly budget: MemoryBudget;
  /** The step's one reader of the secret set (`knownSecretsReader`). */
  readonly knownSecrets: KnownSecretsReader;
}

/** The built-in store's: it holds no connection, so it has no secret. */
const NOTHING_TO_REDACT: ProviderGuard["redaction"] = { text: (text) => text };

/**
 * The port promises `recall` and `observe` will not throw. A provider that does
 * anyway is a bug in that provider, not a reason to fail somebody's run, so it
 * is caught here and answered as `unavailable` with what it said.
 *
 * What it said arrives redacted already (the runtime's boundary copies every
 * error an adapter throws without the connection's secrets); a refusal's own
 * `detail` is RETURNED, which no boundary sees, so it is redacted here. Both
 * are logged by every caller and shown on the run, and a provider quoting the
 * header it was sent is ordinary.
 *
 * `store` is handed through without CATCHING, and that is deliberate rather
 * than an omission. Its three methods have no failure shape to answer with, so
 * they are allowed to throw and the admin cluster that calls them is where the
 * throw is turned into a sentence: `services/memory/memory-documents.ts` wraps
 * all three (`listMemoryDocumentSummaries`, `readMemoryDocument`,
 * `eraseMemoryDocument`). Catching here as well would produce an empty listing
 * or an absent document, which is the one answer this whole area exists to
 * avoid. It spends the same budget as the other two, and what it throws was
 * redacted at the same boundary.
 */
function wrap(
  id: string,
  name: string,
  adapter: MemoryAdapter,
  { redaction, budget, knownSecrets }: ProviderGuard,
): ActiveMemory {
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const spent = () => ({ ok: false, code: "unavailable", detail: budget.spentReason }) as const;
  return {
    id,
    name,
    refusal: null,
    store: adapter.store ? guardedStore(id, adapter.store, budget) : null,
    async recall(request) {
      try {
        const answer = await budget.spend(() => adapter.recall(request));
        if (answer === SPENT) return spent();
        if (!answer.ok) return { ...answer, detail: redaction.text(answer.detail) };
        return await recallWithoutKnownSecrets(answer, knownSecrets());
      } catch (error) {
        return {
          ok: false,
          code: "unavailable",
          detail: `${name} failed to answer: ${said(error)}`,
        };
      }
    },
    async observe(request) {
      const cleaned = await withoutKnownSecrets(request, knownSecrets());
      if (!cleaned.ok) return cleaned.refusal;
      try {
        const answer = await budget.spend(() => adapter.observe(cleaned.request));
        if (answer === SPENT) return spent();
        return answer.ok ? answer : { ...answer, detail: redaction.text(answer.detail) };
      } catch (error) {
        return {
          ok: false,
          code: "unavailable",
          detail: `${name} failed to store it: ${said(error)}`,
        };
      }
    },
  };
}

/**
 * The observation with every secret this deployment knows taken out of its
 * text, before any provider sees it: every observation, every provider, the
 * built-in store included. The rule, its secret source and its refusals live
 * in `memory/known-secrets.ts`, which says why a provider cannot do this
 * itself.
 *
 * Only the text is cleaned: `learned`, `refuted` and a document's `text`.
 * `refuted` is cleaned too because it is matched against what was stored, and
 * what was stored went through here. The subject key, the notebook name, the
 * run id and the ticket key are core's addresses, compared exactly; rewriting
 * one would orphan everything stored under it.
 *
 * Nothing is sent when the secrets cannot be read or the text cannot be
 * cleaned: the refusal is the answer.
 */
async function withoutKnownSecrets(
  request: MemoryObserveRequest,
  cleaner: Promise<KnownSecretCleaner>,
): Promise<
  | { readonly ok: true; readonly request: MemoryObserveRequest }
  | { readonly ok: false; readonly refusal: MemoryWrite }
> {
  const cleaned = await takeOutKnownSecrets(
    (clean): MemoryObserveRequest => {
      const { observation } = request;
      return {
        ...request,
        observation:
          observation.kind === "items"
            ? {
                ...observation,
                learned: observation.learned.map(clean),
                refuted: observation.refuted.map(clean),
              }
            : { ...observation, text: clean(observation.text) },
      };
    },
    cleaner,
  );
  return cleaned.ok
    ? { ok: true, request: cleaned.value }
    : { ok: false, refusal: unscrubbedWrite(cleaned.why) };
}

/**
 * What a recall hands back, `rendering` and every entry's `text`, with every
 * secret this deployment knows taken out before it reaches a prompt, a
 * workspace or the model that distils. A provider can hold a value it stored
 * before that value became a known secret, and a hosted engine's stored text
 * is out of core's reach, so this is the last place it can be stopped.
 *
 * Entries are cleaned as well, and that costs a retraction nothing: a run
 * quotes the cleaned entry back, core cleans the quote again on its way to
 * the provider (`withoutKnownSecrets`), and the built-in store matches it
 * against its own items cleaned the same way. An engine that matches a quote
 * against raw stored text misses it whether the quote was cleaned here or on
 * the way back.
 *
 * FAILS CLOSED: a set that cannot be read, or text the redaction cannot
 * process, is `unavailable`, which every caller of `recall` already answers by
 * going on without that memory.
 */
async function recallWithoutKnownSecrets(
  answer: Extract<MemoryRecall, { ok: true }>,
  cleaner: Promise<KnownSecretCleaner>,
): Promise<MemoryRecall> {
  const cleaned = await takeOutKnownSecrets(
    (clean) => ({
      rendering: clean(answer.rendering),
      entries: answer.entries.map((entry) => ({ ...entry, text: clean(entry.text) })),
    }),
    cleaner,
  );
  if (!cleaned.ok) {
    return {
      ok: false,
      code: "unavailable",
      detail:
        cleaned.why === "unreadable"
          ? `${KNOWN_SECRETS_UNREADABLE}, so memory was not read`
          : "the recalled text could not be scrubbed of this deployment's secrets, so it was not used",
    };
  }
  return { ...answer, ...cleaned.value };
}

function guardedStore(
  id: string,
  store: MemoryStoreAdapter,
  budget: MemoryBudget,
): MemoryStoreAdapter {
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    const answer = await budget.spend(call);
    if (answer === SPENT) throw new Error(budget.spentReason);
    return answer;
  };
  return {
    async list(options) {
      const listing = await guarded(() => store.list(options));
      return options.subjectKey === undefined
        ? listing
        : withinSubject(id, options.subjectKey, listing);
    },
    read: (ref) => guarded(() => store.read(ref)),
    forget: (ref) => guarded(() => store.forget(ref)),
  };
}

/**
 * A listing asked for one subject, held to it. A provider that ignored the
 * filter answered some other slice of what it holds (typically the newest
 * page of everything), so the documents of the asked subject it left out are
 * unknown: what is kept is cut to that subject and reported incomplete, and
 * the provider is named in the log, because the screen can only say "this may
 * not be everything" and the fix is in the adapter.
 */
async function withinSubject(
  id: string,
  subjectKey: string,
  listing: MemoryStoreListing,
): Promise<MemoryStoreListing> {
  const kept = listing.documents.filter((document) => document.subjectKey === subjectKey);
  if (kept.length === listing.documents.length) return listing;
  try {
    const { logger } = await import("../../infra/logger.js");
    logger.warn(
      { provider: id, subjectKey, returned: listing.documents.length, kept: kept.length },
      "memory_list_subject_filter_ignored",
    );
  } catch {
    // The listing is still answered; the log is the only thing lost.
  }
  return { documents: kept, complete: false };
}

/** What a call answers instead when the budget ran out before it did. */
const SPENT: unique symbol = Symbol("memory budget spent");

interface MemoryBudget {
  /** The sentence every call answers once the budget is gone. */
  readonly spentReason: string;
  /** Runs one call inside the budget; `SPENT` when the budget ran out first. */
  spend<T>(call: () => Promise<T>): Promise<T | typeof SPENT>;
}

/** The built-in store's: it never runs out. */
const UNBOUNDED: MemoryBudget = { spentReason: "", spend: (call) => call() };

/**
 * A budget of time spent INSIDE memory calls, not wall time: a clock runs only
 * while at least one call is in flight, so the model call a distill makes
 * between its reads and its writes costs memory nothing, and calls made side by
 * side are charged once.
 *
 * It owns the provider context's lifetime. When the remaining budget runs out
 * mid call, it aborts that lifetime, which stops the provider's request in
 * flight, and the call answers at once rather than waiting for the provider to
 * notice: an adapter that ignores its signal is bounded exactly as well as one
 * that honours it. Every later call answers the same sentence without reaching
 * the provider. The budget belongs to one `ActiveMemory`, which each step
 * resolves for itself, so it is gone for the rest of that step and the next
 * step tries the provider again.
 */
function memoryBudget(name: string, lifetime: AbortController, totalMs: number): MemoryBudget {
  const spentReason = `${name} did not answer in time (memory calls in this step used their ${Math.round(
    totalMs / 1000,
  )} s), so memory was skipped for the rest of this step`;
  const exhausted = new Promise<typeof SPENT>((resolve) => {
    if (lifetime.signal.aborted) resolve(SPENT);
    else lifetime.signal.addEventListener("abort", () => resolve(SPENT), { once: true });
  });
  const exhaust = () => lifetime.abort(new DOMException(spentReason, "TimeoutError"));
  let spentMs = 0;
  let inFlight = 0;
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    spentReason,
    async spend(call) {
      if (!lifetime.signal.aborted && spentMs >= totalMs) exhaust();
      if (lifetime.signal.aborted) return SPENT;
      if (inFlight === 0) {
        since = performance.now();
        timer = setTimeout(exhaust, totalMs - spentMs);
      }
      inFlight += 1;
      try {
        return await Promise.race([call(), exhausted]);
      } finally {
        inFlight -= 1;
        if (inFlight === 0) {
          clearTimeout(timer);
          spentMs += performance.now() - since;
        }
      }
    },
  };
}

/** Every call answers the refusal, so no caller can take a "it worked" path. */
function refusing(refusal: MemoryRefusal): ActiveMemory {
  return {
    id: null,
    name: "memory",
    refusal,
    store: null,
    recall: async () => ({ ok: false, code: refusal.code, detail: refusal.detail }),
    observe: async () => ({ ok: false, code: refusal.code, detail: refusal.detail }),
  };
}

/** Why the provider this run started with is not the one serving it now. */
function movedReason(reason: IntegrationUnavailableReason, name: string): string {
  if (reason === "disabled") return `${name} was disabled after this run started, so memory was not used`;
  if (reason === "disconnected") {
    return `${name} became this deployment's memory after this run started, so this run did not use it`;
  }
  return `${name}'s configuration changed after this run started, so memory was not used`;
}
