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
import type { IntegrationConnectionPin, IntegrationUnavailableReason } from "@shared/contracts";
import type {
  MemoryAdapter,
  MemoryFailure,
  MemoryRecall,
  MemoryRecallRequest,
  MemoryStoreAdapter,
  MemoryObserveRequest,
  MemoryWrite,
} from "@integrations/sdk";

/** Comfortably under the 300 s a plain function is killed at. */
const MEMORY_TIMEOUT_MS = 30_000;

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
    const resolved = await resolveUsableIntegrations({
      signal: AbortSignal.timeout(MEMORY_TIMEOUT_MS),
      filter: (manifest) => manifest.capabilities.includes("memory"),
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
    const usable = resolved.usable;
    if (usable.length === 0) {
      // The default, and the common case: nothing is connected, so the
      // built-in store serves. This is not a refusal and never reports one.
      return await builtinActiveMemory();
    }
    if (usable.length > 1) {
      // Never a silent pick of the first. A run that wrote into one of two
      // connected engines because it happened to be first in the registry is
      // the failure an admin cannot explain afterwards, and it is the same
      // refusal `messaging.ts` and `issue-tracker-runtime.ts` answer.
      const names = usable.map((entry) => entry.manifest.name).join(" and ");
      return refusing({
        code: "ambiguous",
        detail: `${names} both provide memory on this deployment and no active provider is selected, so memory was not used`,
      });
    }
    const [only] = usable;
    if (!only) return await builtinActiveMemory();

    if (pins && pins.length > 0) {
      const { checkIntegrationPin } = await import("../../services/integrations/runtime.js");
      const pin = pins.find((candidate) => candidate.integrationId === only.manifest.id);
      const state = resolved.states.get(only.manifest.id);
      const check =
        pin && state
          ? checkIntegrationPin(pin, state)
          : // This run pinned no memory provider and one is connected now, so
            // it was connected after the run started. Serving it would move
            // where a run in flight remembers things, mid-run.
            ({ ok: false, reason: "disconnected" } as const);
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
    return wrap(only.manifest.id, only.manifest.name, adapter);
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
  return wrap(BUILTIN_MEMORY_PROVIDER_ID, BUILTIN_MEMORY_PROVIDER_NAME, builtinMemoryAdapter());
}

/**
 * The port promises `recall` and `observe` will not throw. A provider that does
 * anyway is a bug in that provider, not a reason to fail somebody's run, so it
 * is caught here and answered as `unavailable` with what it said.
 *
 * `store` is handed through UNWRAPPED, and that is deliberate rather than an
 * omission. Its three methods have no failure shape to answer with, so they are
 * allowed to throw and the admin cluster that calls them is where the throw is
 * turned into a sentence: `services/memory/memory-documents.ts` wraps all three
 * (`listMemoryDocumentSummaries`, `readMemoryDocument`, `eraseMemoryDocument`).
 * Catching here as well would produce an empty listing or an absent document,
 * which is the one answer this whole area exists to avoid.
 */
function wrap(id: string, name: string, adapter: MemoryAdapter): ActiveMemory {
  return {
    id,
    name,
    refusal: null,
    store: adapter.store ?? null,
    async recall(request) {
      try {
        return await adapter.recall(request);
      } catch (error) {
        return {
          ok: false,
          code: "unavailable",
          detail: `${name} failed to answer: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async observe(request) {
      try {
        return await adapter.observe(request);
      } catch (error) {
        return {
          ok: false,
          code: "unavailable",
          detail: `${name} failed to store it: ${error instanceof Error ? error.message : String(error)}`,
        };
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
