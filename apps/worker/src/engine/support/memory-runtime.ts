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
 */
import type {
  IntegrationConnectionPin,
  IntegrationState,
  IntegrationUnavailableReason,
} from "@shared/contracts";
import type { IntegrationRedaction } from "../../services/integrations/runtime.js";
import { recordedPinFor } from "./recorded-pins.js";
import type {
  IntegrationManifest,
  MemoryAdapter,
  MemoryFailure,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryStoreAdapter,
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
  /** `builtin`, or the id of the integration serving `memory`. Null when nothing could be resolved. */
  readonly id: string | null;
  /** What to call it in a sentence a person reads. */
  readonly name: string;
  /**
   * Non-null when nothing serves memory here, in which case every call below
   * answers exactly this. Readable without making a call, so a caller that
   * would otherwise do expensive work first (deriving facts out of a checkout)
   * can skip it and report once.
   */
  readonly refusal: MemoryRefusal | null;
  /**
   * The admin half, or null when this provider cannot enumerate what it holds.
   * Null is not an empty store and a screen must not show it as one.
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
      });
    }
    // Every memory integration an admin has switched on and configured,
    // whether or not it works right now. Read off the resolver's own states,
    // never derived here a second time.
    const { integrationManifests } = await import("@integrations/registry");
    const chosen = integrationManifests.filter(
      (manifest) => servesMemory(manifest) && isChosen(resolved.states.get(manifest.id)),
    );
    if (chosen.length === 0) {
      // The default, and the common case: nothing is connected (or what is
      // connected is disabled, which is the admin's choice), so the built-in
      // store serves. This is not a refusal and never reports one.
      return await builtinActiveMemory();
    }
    if (chosen.length > 1) {
      // Never a silent pick of the first. A run that wrote into one of two
      // connected engines because it happened to be first in the registry is
      // the failure an admin cannot explain afterwards, and it is the same
      // refusal `messaging.ts` and `issue-tracker-runtime.ts` answer. A failing
      // one counts: picking the one that happens to work today is the same
      // silent pick, and it moves the day the other one recovers.
      return refusing({ code: "ambiguous", detail: ambiguousReason(chosen) });
    }
    const [selected] = chosen;
    const only = resolved.usable.find((entry) => entry.manifest.id === selected?.id);
    if (!selected || !only) {
      // Switched on and not working. NOT a fall back to the built-in store: the
      // admin believes this engine is serving, and writing into ours instead
      // would split this deployment's memory across two stores with nobody
      // told. The run goes on without memory and says why.
      return refusing({
        code: "unavailable",
        detail: failingReason(selected, selected && resolved.states.get(selected.id)),
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
        });
      }
    }

    const factory = only.runtime.capabilities.memory;
    if (typeof factory !== "function") {
      return refusing({
        code: "no_provider",
        detail: `${only.manifest.name} declares memory and ships no code for it, so memory was not used`,
      });
    }
    const adapter = (factory as (ctx: unknown) => MemoryAdapter)(only.ctx);
    return wrap(only.manifest.id, only.manifest.name, adapter, {
      redaction: only.redaction,
      budget: memoryBudget(only.manifest.name, lifetime, MEMORY_CALL_BUDGET_MS),
    });
  } catch (error) {
    return refusing({
      code: "unreadable",
      detail: `this deployment's memory provider could not be resolved (${
        error instanceof Error ? error.message : String(error)
      }), so memory was not used`,
    });
  }
}

async function builtinActiveMemory(): Promise<ActiveMemory> {
  const { builtinMemoryAdapter, BUILTIN_MEMORY_PROVIDER_ID, BUILTIN_MEMORY_PROVIDER_NAME } =
    await import("../../memory/builtin/adapter.js");
  // No budget and nothing to redact: the built-in store is core's own
  // database, bounded where every other query is, and holds no connection.
  return wrap(BUILTIN_MEMORY_PROVIDER_ID, BUILTIN_MEMORY_PROVIDER_NAME, builtinMemoryAdapter(), {
    redaction: NOTHING_TO_REDACT,
    budget: UNBOUNDED,
  });
}

function servesMemory(manifest: IntegrationManifest): boolean {
  return manifest.capabilities.includes("memory");
}

/** Enabled, and configured: connected, or configured and failing. Not a
 *  disabled one and not one nobody ever connected. */
function isChosen(state: IntegrationState | undefined): boolean {
  return state?.status === "connected" || state?.status === "failing";
}

function failingReason(
  manifest: IntegrationManifest | undefined,
  state: IntegrationState | undefined,
): string {
  const failure = state?.failure ? ` (${state.failure.message})` : "";
  return `${manifest?.name ?? "The memory integration"} is switched on for memory and its connection is failing${failure}, so memory was not used. Fix it on the Integrations page, or disable it there to use the built-in memory`;
}

function ambiguousReason(chosen: readonly IntegrationManifest[]): string {
  const names = chosen.map((manifest) => manifest.name);
  const listed =
    names.length === 2
      ? `${names[0]} and ${names[1]} both provide`
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} all provide`;
  return `${listed} memory on this deployment and no active provider is selected, so memory was not used. Disable all but one of them on the Integrations page`;
}

/**
 * What core puts around a provider: the redaction for the words a refusal
 * RETURNS, and the budget its calls spend. What a provider throws needs no
 * redaction here: it comes from the runtime `usable.ts` built, which already
 * took the connection's secrets out of every error its adapters (and the
 * `store` inside them) throw.
 */
interface ProviderGuard {
  readonly redaction: Pick<IntegrationRedaction, "text">;
  readonly budget: MemoryBudget;
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
  { redaction, budget }: ProviderGuard,
): ActiveMemory {
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const spent = () => ({ ok: false, code: "unavailable", detail: budget.spentReason }) as const;
  return {
    id,
    name,
    refusal: null,
    store: adapter.store ? guardedStore(adapter.store, budget) : null,
    async recall(request) {
      try {
        const answer = await budget.spend(() => adapter.recall(request));
        if (answer === SPENT) return spent();
        return answer.ok ? answer : { ...answer, detail: redaction.text(answer.detail) };
      } catch (error) {
        return {
          ok: false,
          code: "unavailable",
          detail: `${name} failed to answer: ${said(error)}`,
        };
      }
    },
    async observe(request) {
      try {
        const answer = await budget.spend(() => adapter.observe(request));
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

function guardedStore(store: MemoryStoreAdapter, budget: MemoryBudget): MemoryStoreAdapter {
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    const answer = await budget.spend(call);
    if (answer === SPENT) throw new Error(budget.spentReason);
    return answer;
  };
  return {
    list: (options) => guarded(() => store.list(options)),
    read: (ref) => guarded(() => store.read(ref)),
    forget: (ref) => guarded(() => store.forget(ref)),
  };
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
