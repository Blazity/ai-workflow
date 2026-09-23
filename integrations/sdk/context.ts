import type { z } from "zod";
import type { IntegrationCapabilityAccess, ProvidedCapabilityId } from "./capabilities";
import type {
  ConnectionField,
  IntegrationBlockManifest,
  IntegrationManifest,
} from "./manifest";
import type { IntegrationRunState } from "./run-state";

/**
 * What core hands an integration, and the only thing it hands it: no database
 * handle, no reading of the process environment on its behalf, no worker
 * module. That is a statement about what is handed, not about what integration
 * code can reach: it runs in the worker's process, where global `fetch`,
 * `process.env` and its own dependencies need no import from us. It is trusted
 * code we review, and everything it needs from an operator comes through
 * `connection`, which is what makes the value follow the source an admin
 * chose, the run's pin and the redaction. Core builds the context for every
 * call, so a value here is always current (a rotated secret included).
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
   * Where this deployment receives this integration's webhooks, absolute, with
   * no trailing slash. Core owns the address and the route, so it says it
   * rather than letting an integration guess or read a core variable.
   *
   * It is what a health check compares against the URL the provider holds: an
   * App or a project pointed at another deployment goes on answering every
   * other check perfectly while nothing it sends ever arrives here.
   *
   * Absent when the deployment does not know its own public URL, which is a
   * misconfiguration core reports on its own rows; a check that needs it says
   * it could not be verified rather than inventing an expectation.
   */
  readonly webhookUrl?: string;
  /**
   * The context's LIFETIME, set by whatever core is doing when it builds it.
   * It is not a deadline for any one call, and it is not tied to a run being
   * cancelled (nothing aborts it on cancellation today).
   *
   * Work with a deadline of its own gets that deadline as the lifetime: a
   * block has 240 seconds, a connection test and a page reader 20, a webhook
   * request 120, `beginRun` 60, a health probe about 4. An adapter core holds
   * for a stretch of work (a poll pass, a run's attachment downloads, a step's
   * memory reads and writes) gets a lifetime that does not abort on its own,
   * except that memory aborts it once a provider has used up the time core
   * gives memory in that step. Each request through `http` is bounded by its
   * own attempt timeout (`IntegrationRequestInit.timeoutMs`) and by this
   * lifetime, and a `signal` you pass in a request's options is honoured
   * alongside both. `llm` is not bound to it. Pass it to anything else that
   * waits.
   *
   * Integration code never has to recognise core's run-control errors (a
   * cancelled run, an exhausted budget). Nothing in this context raises one
   * today, and one thrown out of an executor is let through by the generic
   * step rather than reported as the block's own failure.
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
  /**
   * 1 the first time the graph runs this node; higher when it runs it again,
   * inside a Loop. Core never retries an executor that started.
   */
  readonly attempt: number;
  /**
   * What the run is about, the same value `beginRun` was given: the ticket
   * key for a ticket run, and the identifier core gives a run with no ticket
   * (see `IntegrationRunStart.subjectKey`).
   */
  readonly subjectKey: string;
  /**
   * This integration's per-run state (see `run-state.ts`), created at the first
   * use of the integration in this run and the same value at every later one.
   * `null` when the manifest declares no run state, and also when creating it
   * failed: a block for which that makes the work impossible says so rather
   * than reporting a result nothing produced.
   */
  readonly state: IntegrationRunState | null;
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

/**
 * Only the capabilities a block can actually reach from inside itself. A block
 * may require one it cannot hold (`agent_tracing` is applied by core to a
 * sandbox, not called by a block), and then the requirement still decides
 * whether the block is offered at all; it simply has no key here, so nothing
 * can be called on it.
 */
type RequiredCapabilities<B extends IntegrationBlockManifest> = {
  readonly [C in RequiredCapabilityId<B> &
    keyof IntegrationCapabilityAccess]: IntegrationCapabilityAccess[C];
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
 * `maxRetryAfterMs`. A write (anything else) is sent once by default: a PUT
 * or a DELETE repeated after an ambiguous 5xx reports a conflict for a merge,
 * a rebase or a file commit that landed, and even a 429 is no proof a write
 * did nothing (Atlassian: "Only retry if the API is idempotent and the
 * response includes a Retry-After header"). `resendAfterRateLimit` and
 * `retries` are the two ways a caller says otherwise. A `signal` in `init`
 * ends the request as a whole, retries included, alongside `ctx.signal`. A
 * non-2xx response is returned, not thrown.
 *
 * An attempt ends when the whole body has been read: the Response comes back
 * with its body already read, so the attempt deadline covers the body too, and
 * a body the provider did not finish sending in time is an attempt that failed
 * (a read goes again, a write throws) rather than a short success.
 * `streamBody` opts out, for a download too large to hold in memory.
 *
 * A value no request can carry is refused before anything is sent: a header
 * built from a connection value with a line break in it, or a URL built from
 * one that does not parse, throws `ConnectionValueError` naming the field.
 *
 * What a failed request throws has every connection secret taken out of its
 * message, its stack, its fields and its causes, and is otherwise the error it
 * was: the same class and `name` (a deadline is still a `TimeoutError` or an
 * `AbortError`, "never reached the server" is still a `TypeError` with a
 * cause), and the same `code` and `status`.
 */
export interface IntegrationHttp {
  fetch(input: string | URL | Request, init?: IntegrationRequestInit): Promise<Response>;
}

export interface IntegrationRequestInit extends RequestInit {
  /** Per attempt. Defaults to `INTEGRATION_HTTP_DEFAULTS.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Extra attempts. Defaults to `INTEGRATION_HTTP_DEFAULTS.retries` for a read
   * and 0 for a write. Set it on a write only where the provider makes the
   * request idempotent (an idempotency key, a conditional header); set it to
   * 0 for a request that must be sent exactly once whatever comes back.
   */
  retries?: number;
  /**
   * Send this WRITE again after a 429 that says how long to wait
   * (`Retry-After`), once that wait has passed; nothing else about it is
   * retried, and a 429 without `Retry-After` is final. Set it only where the
   * provider documents that a rate-limited call was not processed and may be
   * repeated as it was: Slack does ("wait for the indicated number of seconds
   * before retrying the same request", docs.slack.dev/apis/web-api/rate-limits).
   * Atlassian says the opposite for its writes. A read needs no flag. A body
   * that is a stream, or a `Request` object, is sent once regardless, because
   * it cannot be sent twice.
   */
  resendAfterRateLimit?: boolean;
  /**
   * Hand back the answer as soon as its headers arrive and leave the body to
   * the caller, for a download too large to hold in memory. By default the
   * body is read inside the attempt, so the attempt deadline covers it and a
   * body cut short is an attempt that failed. A streamed body is outside that:
   * the attempt deadline still runs while the caller reads it, so give such a
   * request a `timeoutMs` that covers the whole download, and treat a read
   * that throws as the provider not being reached. What that read throws is
   * the runtime's own error, not a redacted copy.
   */
  streamBody?: boolean;
}

export const INTEGRATION_HTTP_DEFAULTS = {
  timeoutMs: 30_000,
  retries: 2,
  /** The methods core retries on its own; see `IntegrationRequestInit` for writes. */
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
 * and pays for. Each call is bounded under the function's invocation ceiling
 * (`apps/worker/src/infra/llm.ts`); it is not bound to `signal`, and its usage
 * is not yet recorded against the block.
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
