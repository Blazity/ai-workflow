import type { z } from "zod";
import type { IntegrationCapabilityAccess, ProvidedCapabilityId } from "./capabilities";
import type {
  ConnectionField,
  IntegrationBlockManifest,
  IntegrationManifest,
} from "./manifest";

/**
 * What an integration receives from core. It is the only thing it receives:
 * no database, no process environment, no worker module. Core builds it for
 * every call, so a value here is always current (a rotated secret included).
 *
 * Two shapes:
 * - `IntegrationContext`: what a capability adapter, a connection test and a
 *   health probe receive.
 * - `IntegrationBlockContext`: a block executor adds the run it is part of and
 *   exactly the capabilities and `llm` its manifest `requires`.
 */
export interface IntegrationContext<M extends IntegrationManifest> {
  /**
   * The resolved connection, from whichever source is active. Secrets are
   * included and exist only on the server. A connection test receives the
   * values being tested, which may not be the active ones yet.
   */
  readonly connection: ConnectionValues<M>;
  readonly http: IntegrationHttp;
  readonly log: IntegrationLogger;
  /**
   * Aborts when core gives up on this work: the run was cancelled or ran out
   * of budget, the invocation is near its time ceiling, or a connection test
   * or a webhook request took too long. Every request through `http` and every
   * `llm` call is already bound to it; pass it to anything else that waits.
   *
   * An adapter gets the signal of whatever core is doing when it builds the
   * adapter, so a capability called from a webhook route cannot wait past the
   * route's own deadline.
   *
   * Integration code never has to recognise core's run-control errors (a
   * cancelled run, an exhausted budget). Core records one when it raises it
   * through this context and raises it again after the executor settles, so
   * an executor that catches every error cannot turn a cancellation into a
   * success or an ordinary failure.
   */
  readonly signal: AbortSignal;
}

export type IntegrationBlockContext<
  M extends IntegrationManifest,
  B extends IntegrationBlockManifest,
> = IntegrationContext<M> & {
  readonly run: IntegrationRunIdentity;
  /** Exactly the capabilities `B.requires.capabilities` names, each typed. */
  readonly capabilities: RequiredCapabilities<B>;
} & LlmAccess<B>;

/** Which run and which node of its workflow this execution belongs to. */
export interface IntegrationRunIdentity {
  readonly runId: string;
  /** The node id in the workflow definition. */
  readonly nodeId: string;
  /** 1 on the first attempt; higher when core retries the block. */
  readonly attempt: number;
}

/** `ctx.connection`, typed from the manifest's fields. */
export type ConnectionValues<M extends IntegrationManifest> = {
  readonly [F in M["connection"]["fields"][number] as F["key"]]: ConnectionFieldValue<F>;
};

type FieldValue<F extends ConnectionField> = F extends { readonly format: "integer" }
  ? number
  : string;

type ConnectionFieldValue<F extends ConnectionField> = F extends { readonly optional: true }
  ? F extends { readonly default: string }
    ? FieldValue<F>
    : FieldValue<F> | undefined
  : FieldValue<F>;

type RequiredCapabilityId<B extends IntegrationBlockManifest> = B extends {
  readonly requires: { readonly capabilities: readonly (infer C)[] };
}
  ? C & ProvidedCapabilityId
  : never;

type RequiredCapabilities<B extends IntegrationBlockManifest> = {
  readonly [C in RequiredCapabilityId<B>]: IntegrationCapabilityAccess[C];
};

type LlmAccess<B extends IntegrationBlockManifest> = B extends {
  readonly requires: { readonly llm: true };
}
  ? { readonly llm: IntegrationLlm }
  : unknown;

/**
 * The HTTP client. `fetch` has the standard signature, so it can be handed to
 * a provider SDK that accepts a custom fetch.
 *
 * Core applies a per-attempt timeout and retries a read (GET, HEAD, OPTIONS)
 * after a network error, a 429 or a 5xx, honouring `Retry-After` up to
 * `maxRetryAfterMs`. Nothing else is retried unless `retries` says so: a PUT
 * or a DELETE is a write at these providers (a merge, a rebase, a file
 * commit), and repeating one after an ambiguous 5xx reports a conflict for
 * work that landed. Every connection secret is redacted from whatever core
 * records about a request. A non-2xx response is returned, not thrown.
 */
export interface IntegrationHttp {
  fetch(input: string | URL | Request, init?: IntegrationRequestInit): Promise<Response>;
}

export interface IntegrationRequestInit extends RequestInit {
  /** Per attempt. Defaults to `INTEGRATION_HTTP_DEFAULTS.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Extra attempts. Defaults to `INTEGRATION_HTTP_DEFAULTS.retries` for a read
   * and 0 for everything else. Set it on a write only where the provider makes
   * the request idempotent (an idempotency key, a conditional header).
   */
  retries?: number;
}

export const INTEGRATION_HTTP_DEFAULTS = {
  timeoutMs: 30_000,
  retries: 2,
  /** The methods core retries on its own. */
  retriedMethods: ["GET", "HEAD", "OPTIONS"],
  /** A longer `Retry-After` is treated as a refusal rather than a wait. */
  maxRetryAfterMs: 30_000,
} as const;

/**
 * The logger, with the argument order of pino, which core uses: fields first,
 * then an event name in snake_case. Every connection secret that appears in a
 * field or an event is replaced before the line is written.
 */
export interface IntegrationLogger {
  debug(fields: IntegrationLogFields, event: string): void;
  debug(event: string): void;
  info(fields: IntegrationLogFields, event: string): void;
  info(event: string): void;
  warn(fields: IntegrationLogFields, event: string): void;
  warn(event: string): void;
  error(fields: IntegrationLogFields, event: string): void;
  error(event: string): void;
}

export type IntegrationLogFields = Readonly<Record<string, unknown>>;

/**
 * Structured generation with a model core chooses (the run's default model)
 * and pays for (usage is recorded against the block). Each call is bounded
 * under the function's invocation ceiling and by `signal`, so a block that
 * makes several calls shares one budget and a late call gets less time.
 */
export interface IntegrationLlm {
  /** Resolves with output the schema accepted; rejects when the model's output does not parse. */
  generateObject<S extends z.ZodTypeAny>(request: IntegrationLlmRequest<S>): Promise<z.output<S>>;
}

export interface IntegrationLlmRequest<S extends z.ZodTypeAny> {
  readonly system?: string;
  readonly prompt: string;
  /** Written with the `z` this package exports. */
  readonly schema: S;
  /** An upper bound of your own; core's bound still applies. */
  readonly timeoutMs?: number;
}
