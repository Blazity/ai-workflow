/**
 * Reaching a usable integration's own code, with the context it receives.
 *
 * Every capability runtime reaches its provider through this (the tracker,
 * version control, memory, messaging), and so do the step that creates an
 * integration's per-run state, the sandbox steps that ask every tracing
 * provider what a harness needs, the route behind a contributed page and the
 * webhook route. Each runs server side, which is where a connection may be
 * read at all.
 *
 * It resolves nothing of its own: the state comes from `resolve.ts`, the one
 * place a status is decided, and the context from `context.ts`. A second
 * derivation of either is exactly what ADR-010 says not to build, which is also
 * why this lives here rather than in the engine that calls it.
 */
import {
  type ErasedIntegrationRuntime,
  type IntegrationContext,
  type IntegrationManifest,
  integrationSettingValues,
  NESTED_ADAPTER_MEMBERS,
  type NestedAdapterRole,
} from "@integrations/sdk";
import type { IntegrationFailure, IntegrationState } from "@shared/contracts";
import type { ConnectionValue } from "./connection-values.js";

/** One integration this deployment can actually use right now. */
export interface UsableIntegration {
  readonly manifest: IntegrationManifest;
  /**
   * The integration's runtime as core calls it: every capability adapter a
   * factory here builds (with the adapters inside it), `beginRun`, each page
   * reader and the webhook calls throw with this connection's secrets already
   * taken out (see `redactingRuntime`, which lists what it covers and where
   * the rest is redacted). An adapter's own client (Octokit, a provider SDK, a
   * `fetch` of its own) does not go through `ctx.http`, and nobody calling a
   * port should have to remember that.
   */
  readonly runtime: ErasedIntegrationRuntime;
  /**
   * The context its code receives. Resolved `forWebhook`, it is the webhook's
   * context (`IntegrationWebhookContext` in the SDK): the connection narrowed
   * to what `webhook.requires` names, and `settings` beside it; `settings`
   * is absent otherwise.
   */
  readonly ctx: IntegrationContext<IntegrationManifest> & {
    readonly settings?: Readonly<Record<string, readonly string[]>>;
  };
  /**
   * This connection's secrets taken out of what its adapter hands back, for
   * core and never for the integration. `text` is for what a port RETURNS in
   * the provider's words (a refusal's `detail`), which no boundary sees.
   * `error` is the copy `redactedError` makes (class, name, code and status
   * kept), and it is what `runtime` already applies to everything it throws:
   * a caller of `runtime` never applies it again.
   */
  readonly redaction: IntegrationRedaction;
}

export interface IntegrationRedaction {
  text(text: string): string;
  error(error: unknown): Error;
}

/**
 * How long the contexts a resolution builds live.
 *
 * Absent, which is right for a caller that HOLDS what it resolved and makes
 * calls through it for as long as it holds it (a step, a poll pass, a resume):
 * the contexts never abort on their own, and every request is still bounded by
 * its own per-attempt timer. Pass a signal when the caller has a total deadline
 * for everything it does with them (a webhook request, a page read) or owns a
 * budget it may have to end early (memory). What it must never be is a timer
 * started at resolution by a caller that then holds the result: nothing bounds
 * the resolution with it, and once it fires every request through the context
 * fails at once, looking exactly like the provider timing out.
 */
type ContextLifetime = { readonly lifetime?: AbortSignal };

/**
 * Resolve for the webhook route rather than for the integration's adapters.
 *
 * The route asks a narrower question than "is it Connected": can this
 * deployment serve the integration's webhook. An integration whose manifest
 * says what its webhook reads (`webhook.requires`) is served while it is
 * enabled and those fields have values in the active source, even when the
 * rest of the connection is incomplete or its test failed; its context then
 * carries exactly those fields. One that says nothing needs the whole
 * connection, Connected, as every other caller does. Enabled is still asked
 * of both: disabling is the kill switch.
 *
 * `settings` loads the request's settings snapshot. It is called once, and
 * only when a candidate declares operator settings, whose values become the
 * context's `settings`. A snapshot that cannot be loaded makes the whole
 * answer unreadable, as the connection read does: an allowlist nobody could
 * read must not be served as an empty one.
 */
type WebhookPurpose = {
  readonly forWebhook?: {
    readonly settings: () => Promise<Readonly<Record<string, unknown>>>;
  };
};

/**
 * Every connected, enabled integration whose connection values can be read,
 * each with the context its own code receives, or the fact that this
 * deployment's integration settings could not be read at all.
 *
 * THE ONE READER, and it keeps "could not read our own settings" apart from
 * "nothing is usable" for every caller. There used to be a second one that
 * folded the two into an empty list, and each of its callers then said a false
 * thing with confidence: a pull request URL "no provider recognises", a
 * sandbox built with no version control credentials, a page "not connected",
 * a run "with no tracing integration". A database that did not answer for a
 * moment is not an integration that is off, so every caller acts on
 * `readable: false` in its own words (retry, fail, or say it is unknown) and
 * none can forget to, because the type does not let it reach `usable`
 * without looking.
 *
 * `filter` narrows the manifests before any connection is opened, so a
 * deployment with five integrations does not decrypt five connections to find
 * the one that traces.
 *
 * `states` is the resolver's own reading of the integrations (every one this
 * build ships, whenever there was a candidate), handed back rather than
 * re-derived: a caller that
 * has to tell a person WHY an integration it asked for is missing from
 * `usable` (disabled, never connected) would otherwise decide that a second
 * time, which is the one thing `resolve.ts` exists to prevent. It carries no
 * secret and no ciphertext. `connectionFailures` is the same courtesy for the
 * last reason a candidate can be missing: its state is usable and its values
 * could not be read (a secret stored under another key, a value that no
 * longer parses), with the resolver's sentence for it.
 */
export async function resolveUsableIntegrations(input: ContextLifetime & WebhookPurpose & {
  readonly filter?: (manifest: IntegrationManifest) => boolean;
}): Promise<
  | {
      readonly readable: true;
      readonly usable: UsableIntegration[];
      readonly states: ReadonlyMap<string, IntegrationState>;
      readonly connectionFailures: ReadonlyMap<string, IntegrationFailure>;
    }
  | { readonly readable: false; readonly reason: string }
> {
  const { integrationManifests } = await import("@integrations/registry");
  const { integrationRuntime } = await import("@integrations/registry/worker");
  // Imported from where each one is defined rather than through `runtime.ts`,
  // which re-exports this file: the boundaries gate reads that round trip as a
  // cycle, and it would be one.
  const { readIntegrationStatesFrom, secretsKeyMaterial } = await import("./authoring.js");
  const {
    readConnectionValues,
    readWebhookConnection,
    redactIntegrationText,
    secretValuesOf,
  } = await import("./connection-values.js");
  const { environmentReaderFrom } = await import("./resolve.js");
  const { buildIntegrationContext, redactedError } = await import("./context.js");
  const { readConnectedIntegrationConnections } = await import(
    "../../db/repositories/integrations.js"
  );
  const { logger } = await import("../../infra/logger.js");

  const candidates = integrationManifests.filter((manifest) => input.filter?.(manifest) ?? true);
  if (candidates.length === 0) {
    return { readable: true, usable: [], states: new Map(), connectionFailures: new Map() };
  }

  // A database this caller cannot reach is reported as unreadable rather than
  // as "nothing usable", and each caller decides what that means where it is.
  //
  // Read once: the states and the values they gate come from the same rows,
  // so a save landing between two reads cannot pair one version's state with
  // another version's values.
  let states: ReturnType<typeof readIntegrationStatesFrom>;
  let stored: Awaited<ReturnType<typeof readConnectedIntegrationConnections>>;
  try {
    const { readIntegrationTables } = await import("./unreadable.js");
    stored = await readIntegrationTables(readConnectedIntegrationConnections);
    states = readIntegrationStatesFrom(stored);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ err: reason }, "integration_states_unreadable");
    return { readable: false, reason };
  }
  const secretsKey = secretsKeyMaterial();
  const environment = environmentReaderFrom();
  let settingsSnapshot: Readonly<Record<string, unknown>> | undefined;

  const usable: UsableIntegration[] = [];
  const connectionFailures = new Map<string, IntegrationFailure>();
  for (const manifest of candidates) {
    const state = states.get(manifest.id);
    // What this caller needs of the connection: all of it, or for a webhook
    // that declared less, exactly the fields it reads.
    const requires = input.forWebhook ? manifest.webhook?.requires : undefined;
    if (!state?.enabled || (!state.usable && requires === undefined)) continue;
    const runtime = integrationRuntime(manifest.id);
    if (!runtime) continue;
    const reading = {
      source: state.source,
      environment,
      active: stored.get(manifest.id)?.active ?? null,
      secretsKey,
    };
    // The card already says why a connection cannot be read. Logged here once,
    // and handed back so a caller that has to tell a person why the
    // integration is missing can.
    const unreadable = (failure: IntegrationFailure) => {
      logger.warn({ integration: manifest.id, reason: failure.reason }, "integration_connection_unreadable");
      connectionFailures.set(manifest.id, failure);
    };
    let read: IntegrationManifest;
    let values: Record<string, ConnectionValue>;
    if (requires === undefined) {
      const whole = readConnectionValues({ manifest, ...reading });
      if (!whole.ok) {
        unreadable(whole.failure);
        continue;
      }
      read = manifest;
      values = whole.values;
    } else {
      // Served only when the declared part is there (no signing secret means
      // nothing to verify a request with); the card reads the same answer.
      const part = readWebhookConnection({ manifest, requires, ...reading });
      if (!part.served) {
        if (part.failure) unreadable(part.failure);
        continue;
      }
      read = part.manifest;
      values = part.values;
    }
    let settings: Record<string, readonly string[]> | undefined;
    if (input.forWebhook && (manifest.settings?.length ?? 0) > 0) {
      try {
        settingsSnapshot ??= await input.forWebhook.settings();
        settings = integrationSettingValues(manifest, settingsSnapshot);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn({ integration: manifest.id, err: reason }, "integration_settings_unreadable");
        return { readable: false, reason };
      }
    }
    const secrets = secretValuesOf(read, values);
    const redaction: IntegrationRedaction = {
      text: (text) => redactIntegrationText(text, secrets),
      error: (error) => redactedError(error, (text) => redactIntegrationText(text, secrets)),
    };
    const ctx = buildIntegrationContext({
      manifest: read,
      values,
      secrets,
      // One per context rather than one shared never-aborting signal, so
      // whatever a request joins onto it goes away with the context.
      lifetime: input.lifetime ?? new AbortController().signal,
    });
    usable.push({
      manifest,
      runtime: redactingRuntime(runtime, redaction.error),
      ctx: input.forWebhook ? { ...ctx, settings: settings ?? {} } : ctx,
      redaction,
    });
  }
  return { readable: true, usable, states, connectionFailures };
}

/** Defined beside the one retry rule; exported here too for its callers. */
export { IntegrationSettingsUnreadableError } from "./unreadable.js";

/**
 * Where what an integration throws is redacted on its way into core.
 *
 * `ctx.http` redacts the errors of the requests that go through it, and that
 * covers only those: Octokit, GitLab's own `fetch` and anything else an
 * adapter builds reach core with whatever the provider or Node put in the
 * message (a token quoted in an invalid header, an echoing error body). Every
 * caller of a port catching and redacting on its own is the pattern that was
 * already forgotten once, so the runtime core's callers hold does it for them.
 *
 * THIS BOUNDARY COVERS what `resolveUsableIntegrations` hands out: each
 * capability factory and the adapter it returns (every method, sync or async,
 * and every adapter reached through a member `NESTED_ADAPTER_MEMBERS` names,
 * such as `vcs.skillSource()` and `memory.store`), `beginRun`, each page
 * reader, and `webhook.receive` and `webhook.deliver`. The integration's code
 * runs against the original objects, so nothing it does to itself changes.
 *
 * THE OTHER ENTRY POINTS redact where they are called, each with the same
 * redactor (`redactIntegrationText` over the connection's secrets):
 *
 * - the connection test: `authoring.ts` redacts the refusal it returns and the
 *   sentence for what it throws;
 * - health probes: `services/system/integration-health.ts` redacts the probe's
 *   message and what it throws;
 * - blocks: `engine/steps/integration-block-step.ts` redacts the outcome and
 *   what the block throws.
 *
 * The webhook route (`routes/webhooks/[id].post.ts`) calls `webhook` on this
 * runtime, so it is covered here rather than there.
 */
export function redactingRuntime(
  runtime: ErasedIntegrationRuntime,
  redactError: (error: unknown) => Error,
): ErasedIntegrationRuntime {
  const views = new WeakMap<object, object>();
  const guard = <A extends unknown[], R>(fn: (...args: A) => R, self: unknown) =>
    guarded(fn, self, redactError, (result: unknown) => result);

  return {
    ...runtime,
    capabilities: Object.fromEntries(
      Object.entries(runtime.capabilities).map(([id, factory]) => [
        id,
        guarded(factory, undefined, redactError, (adapter) =>
          viewOf(adapter, nestedMembersOf(id)),
        ),
      ]),
    ),
    ...(runtime.beginRun ? { beginRun: guard(runtime.beginRun, runtime) } : {}),
    ...(runtime.api
      ? {
          api: Object.fromEntries(
            Object.entries(runtime.api).map(([page, reader]) => [page, guard(reader, runtime.api)]),
          ),
        }
      : {}),
    ...(runtime.webhook
      ? {
          webhook: {
            receive: guard(runtime.webhook.receive, runtime.webhook),
            ...(runtime.webhook.deliver
              ? { deliver: guard(runtime.webhook.deliver, runtime.webhook) }
              : {}),
          },
        }
      : {}),
  };

  /**
   * A view of one adapter whose methods throw redacted, and nothing else
   * changed. Built on a shadow target rather than on the adapter, so the
   * adapter may be frozen or hold non-configurable members: a proxy must
   * report those exactly as its target has them, and the target here is an
   * empty object with the adapter's prototype (which keeps `instanceof`), while
   * every read, write and key listing goes to the adapter itself.
   *
   * Methods are wrapped per function rather than per name, so a method
   * reassigned on the adapter is the one called. A method runs with the
   * adapter as `this`, which private fields need. Only the members `nested`
   * names lead to another view; any other value (a `Map`, a `Uint8Array`, a
   * record of data) is handed over as it is.
   */
  function viewOf<T>(adapter: T, nested: NestedMembers): T {
    if (typeof adapter !== "object" || adapter === null) return adapter;
    const known = views.get(adapter);
    if (known) return known as T;
    const target: object = adapter;
    const methods = new WeakMap<object, unknown>();
    const view = new Proxy(Object.create(Object.getPrototypeOf(target)) as object, {
      get(_shadow, property) {
        let value: unknown;
        try {
          value = Reflect.get(target, property, target);
        } catch (error) {
          throw redactError(error);
        }
        const role = typeof property === "string" ? nested[property] : undefined;
        if (typeof value === "function" && property !== "constructor") {
          const wrapped = methods.get(value);
          if (wrapped) return wrapped;
          const method = guarded(
            value as (...args: unknown[]) => unknown,
            target,
            redactError,
            role === "returns" ? (result) => viewOf(result, NO_NESTED_MEMBERS) : (result) => result,
          );
          methods.set(value, method);
          return method;
        }
        return role === "holds" ? viewOf(value, NO_NESTED_MEMBERS) : value;
      },
      set: (_shadow, property, value) => Reflect.set(target, property, value, target),
      has: (_shadow, property) => Reflect.has(target, property),
      ownKeys: () => Reflect.ownKeys(target),
      getOwnPropertyDescriptor(_shadow, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        // Reported configurable: the shadow does not have the property, and a
        // proxy may not call a property non-configurable that its target lacks.
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
      defineProperty: (_shadow, property, descriptor) =>
        Reflect.defineProperty(target, property, descriptor),
      deleteProperty: (_shadow, property) => Reflect.deleteProperty(target, property),
      getPrototypeOf: () => Reflect.getPrototypeOf(target),
    }) as T;
    views.set(adapter, view as object);
    return view;
  }
}

type NestedMembers = Readonly<Record<string, NestedAdapterRole | undefined>>;

/** An adapter reached through another has no adapters of its own today; one
 *  that grows some is a port change, and gets its own table entry then. */
const NO_NESTED_MEMBERS: NestedMembers = {};

function nestedMembersOf(capability: string): NestedMembers {
  return capability in NESTED_ADAPTER_MEMBERS
    ? (NESTED_ADAPTER_MEMBERS[capability as keyof typeof NESTED_ADAPTER_MEMBERS] as NestedMembers)
    : NO_NESTED_MEMBERS;
}

/**
 * `fn` called on `self`, with what it throws (or its promise rejects with)
 * passed through `redactError`, and what it returns (or resolves to) passed
 * through `onResult`.
 */
function guarded<A extends unknown[], R>(
  fn: (...args: A) => R,
  self: unknown,
  redactError: (error: unknown) => Error,
  onResult: (result: unknown) => unknown,
): (...args: A) => R {
  return (...args: A): R => {
    let result: R;
    try {
      result = fn.apply(self, args);
    } catch (error) {
      throw redactError(error);
    }
    if (isThenable(result)) {
      return Promise.resolve(result).then(onResult, (error: unknown) => {
        throw redactError(error);
      }) as R;
    }
    return onResult(result) as R;
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
