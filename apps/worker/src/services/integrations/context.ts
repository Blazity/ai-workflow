import type {
  IntegrationContext,
  IntegrationLogFields,
  IntegrationLogger,
  IntegrationRequestInit,
} from "@integrations/sdk";
import { INTEGRATION_HTTP_DEFAULTS } from "@integrations/sdk";
import type { IntegrationManifest } from "@integrations/sdk";

import { logger } from "../../infra/logger.js";
import { type ConnectionValue, redactIntegrationText } from "./connection-values.js";

/**
 * The context an integration's own code receives: a connection test, a health
 * probe, a block, and every capability adapter core resolves.
 *
 * Only the `IntegrationContext` half of the contract: the block half adds the
 * run's identity, the capabilities a block declared and `llm`, and belongs to
 * the stage that builds the generic step (S4). Everything here is what the SDK
 * documents, so the half S4 adds composes with it rather than replacing it.
 *
 * Every secret of this connection is taken out of whatever core records: the log
 * fields, the event name, and the message a failed request produces. A provider
 * that echoes a token in its error body is normal, and that body is what an
 * admin reads on the card.
 */
export function buildIntegrationContext(input: {
  readonly manifest: IntegrationManifest;
  readonly values: Readonly<Record<string, ConnectionValue>>;
  readonly secrets: readonly string[];
  /**
   * The LIFETIME of this context, handed to the integration as `ctx.signal`:
   * once it aborts, every request through `http` stops, the ones in flight
   * included. It is not a per-request deadline and must not be used as one.
   * Each attempt already has its own timer, and a signal that aborts on a
   * clock is the context expiring under whoever still holds it: every later
   * request fails at once with an error that reads exactly like the provider
   * timing out.
   */
  readonly lifetime: AbortSignal;
}): IntegrationContext<IntegrationManifest> {
  const redact = (text: string) => redactIntegrationText(text, input.secrets);
  const webhookUrl = integrationWebhookUrl(input.manifest.id);
  return {
    connection: input.values as never,
    http: { fetch: (target, init) => fetchWithPolicy(target, init, input.lifetime, redact) },
    log: redactingLogger(input.manifest.id, redact),
    signal: input.lifetime,
    ...(webhookUrl ? { webhookUrl } : {}),
  };
}

/**
 * The address this deployment receives an integration's deliveries at.
 *
 * One route, `/webhooks/<id>`, and one base, so an integration comparing what
 * the provider holds against where deliveries would arrive is comparing
 * against core's answer rather than its own guess. Nothing when the deployment
 * has no public URL configured: an empty expectation would read as a mismatch
 * on every provider.
 */
function integrationWebhookUrl(id: string): string | undefined {
  // Read off `process.env` rather than the validated environment module, which
  // this file may not import: it is reached from the integrations barrel, and
  // pulling environment validation in there makes importing the barrel fail
  // wherever the variables are not set. The value is a URL a person typed, and
  // nothing here depends on its shape beyond being non-empty.
  const base = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/u, "");
  return base ? `${base}/webhooks/${id}` : undefined;
}

function redactingLogger(
  integrationId: string,
  redact: (text: string) => string,
): IntegrationLogger {
  const write = (level: "debug" | "info" | "warn" | "error") =>
    (first: IntegrationLogFields | string, second?: string): void => {
      const event = typeof first === "string" ? first : (second ?? "integration_event");
      const fields = typeof first === "string" ? {} : first;
      logger[level](
        { integration: integrationId, ...redactFields(fields, redact) },
        redact(event),
      );
    };
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  } as IntegrationLogger;
}

function redactFields(
  fields: IntegrationLogFields,
  redact: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? redact(value) : value;
  }
  return out;
}

/**
 * The HTTP policy the SDK documents: a per-attempt timeout, retries for reads,
 * a rate limit waited out for every method, `Retry-After` honoured up to a
 * ceiling, a non-2xx returned rather than thrown.
 *
 * Writes are not retried after a failure because a PUT or a DELETE at these
 * providers is a merge, a rebase or a file commit, and repeating one after an
 * ambiguous 5xx reports a conflict for work that landed. A 429 is not
 * ambiguous: the provider says it did nothing, so a write is sent again once
 * the wait it asked for has passed. That is what a Slack notification relied
 * on when it went through Slack's own client, which waited out every rate
 * limit; this policy is the one place that decision lives now.
 *
 * THREE THINGS END A REQUEST, and each has one owner:
 *
 * - the context's `lifetime`, owned by whoever holds the adapter. It ends every
 *   request made through the context, the one in flight included, and it is
 *   never a clock started when the context was built.
 * - the caller's own `signal` in `init` (or on a `Request`), owned by the
 *   adapter making this one request. It ends this request, retries included.
 *   `fetch` takes a single signal, so one not joined here would be silently
 *   replaced and a deadline the adapter set would never operate.
 * - the attempt deadline, `timeoutMs`, owned by this policy. It ends one
 *   attempt, and a read may then try again.
 *
 * WHAT IT THROWS is never what `fetch` threw. Node's own messages carry
 * request material: an invalid header value is quoted whole (`Headers.append:
 * "Token <the key>" is an invalid header value.`, which is what a key pasted
 * from a wrapped terminal produces), and a URL that did not parse is quoted
 * with its query string. The copy that leaves here is `redactedError`'s:
 * the connection's secrets out of its message, its stack and every cause, its
 * `name` kept (`TimeoutError` and `AbortError` are how callers tell a deadline
 * from a failure) and its class kept (`TypeError` with a cause is how Node
 * spells "never reached the server"). The original is not reachable from the
 * copy.
 */
async function fetchWithPolicy(
  target: string | URL | Request,
  init: IntegrationRequestInit | undefined,
  lifetime: AbortSignal,
  redact: (text: string) => string,
): Promise<Response> {
  try {
    return await fetchWithRetries(target, init, lifetime);
  } catch (error) {
    throw redactedError(error, redact);
  }
}

async function fetchWithRetries(
  target: string | URL | Request,
  init: IntegrationRequestInit | undefined,
  lifetime: AbortSignal,
): Promise<Response> {
  const { timeoutMs, retries: requestedRetries, signal: callerSignal, ...request } = init ?? {};
  const method = (request.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase();
  const retriable = INTEGRATION_HTTP_DEFAULTS.retriedMethods.includes(
    method as (typeof INTEGRATION_HTTP_DEFAULTS.retriedMethods)[number],
  );
  // A body that is read as it is sent cannot be sent twice.
  const replayable = !(target instanceof Request) && !(request.body instanceof ReadableStream);
  // A read may be repeated after anything. A write only after a 429, the
  // provider saying it did nothing, and only when its body can be sent again.
  // An explicit `retries` is the caller's word for every case.
  const retriesAfter = (rateLimited: boolean): number =>
    requestedRetries ??
    (retriable || (rateLimited && replayable) ? INTEGRATION_HTTP_DEFAULTS.retries : 0);
  const attemptDeadlineMs = timeoutMs ?? INTEGRATION_HTTP_DEFAULTS.timeoutMs;

  // Retries and the waits between them included.
  const wholeRequest = AbortSignal.any([
    lifetime,
    ...(callerSignal ? [callerSignal] : []),
    ...(target instanceof Request ? [target.signal] : []),
  ]);

  for (let attempt = 0; ; attempt += 1) {
    const thisAttempt = AbortSignal.any([wholeRequest, AbortSignal.timeout(attemptDeadlineMs)]);
    let response: Response;
    try {
      response = await fetch(target, { ...request, signal: thisAttempt });
    } catch (error) {
      if (wholeRequest.aborted || attempt >= retriesAfter(false)) throw error;
      await delay(backoffMs(attempt), wholeRequest);
      continue;
    }
    const rateLimited = response.status === 429;
    if (!rateLimited && response.status < 500) return response;
    if (attempt >= retriesAfter(rateLimited)) return response;
    const wait = waitBeforeRetry(response, attempt);
    if (wait === null) return response;
    // Released before the next attempt rather than left to the collector: an
    // unread body holds its connection, and a provider having a bad minute is
    // exactly when the pool runs short.
    try {
      await response.body?.cancel();
    } catch {
      // Already closed by the other side; nothing is held.
    }
    await delay(wait, wholeRequest);
  }
}

/** How deep a cause chain is copied. Node nests one level (`fetch failed` over
 *  the socket error); anything deeper is a provider SDK's own wrapping. */
const MAX_CAUSE_DEPTH = 4;

/**
 * A copy of anything integration code threw, safe to log and show, and still
 * the error it was to whoever catches it. The one way core turns a provider's
 * failure into an error it passes on, for `ctx.http` and for every capability
 * adapter (`usable.ts`).
 *
 * Taken out: the connection's secrets, from the message, the stack, every
 * string field and every cause.
 *
 * Kept: the class, because core decides by it (`IssueTrackerNotFoundError` is
 * a ticket that is gone, not an outage; `TypeError` with a cause is Node's
 * "never reached the server"); the `name` (`TimeoutError`, `AbortError`,
 * `FatalError`, which the Workflow DevKit reads); and every string, number and
 * boolean field (`code`, `status`), because core reads those too.
 *
 * Left behind: fields that hold objects. A provider's request and response
 * ride on its errors (Octokit's carries the request's headers), nothing core
 * decides reads them, and copying them would make the original reachable.
 */
export function redactedError(
  error: unknown,
  redact: (text: string) => string,
  depth = 0,
): Error {
  if (!(error instanceof Error)) return new Error(redact(String(error)));
  const message = redact(error.message);
  if (error instanceof DOMException) {
    // An abort or a timeout. The name is the whole of what callers read, and
    // the constructor is the only way to set it on this class.
    return new DOMException(message, error.name);
  }
  const cause =
    error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: redactedError(error.cause, redact, depth + 1) }
      : undefined;
  // A real error (so anything asking "is this an Error" still says yes) with
  // the original's prototype, so every class check holds. The class's own
  // constructor is not run: it may do work, take other arguments or throw.
  const copy = new Error(message, cause);
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error));
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "message" || key === "stack" || key === "cause") continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor || !("value" in descriptor)) continue;
    const value: unknown = descriptor.value;
    if (typeof value === "string") {
      Object.defineProperty(copy, key, { ...descriptor, value: redact(value) });
    } else if (typeof value === "number" || typeof value === "boolean") {
      Object.defineProperty(copy, key, descriptor);
    }
  }
  if (typeof error.stack === "string") copy.stack = redact(error.stack);
  return copy;
}

/** The wait before the next attempt after a network error, or after a 429 or
 *  a 5xx that did not say how long to wait. */
function backoffMs(attempt: number): number {
  return 250 * (attempt + 1);
}

/**
 * How long the provider asked us to wait, in either of the forms `Retry-After`
 * takes (seconds, or an HTTP date), or the backoff when it did not say.
 *
 * `null` for a wait longer than the ceiling: that is a refusal, not a wait,
 * because the invocation has its own deadline and sleeping through it helps
 * nobody.
 */
function waitBeforeRetry(response: Response, attempt: number): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return backoffMs(attempt);
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) return backoffMs(attempt);
  return ms > INTEGRATION_HTTP_DEFAULTS.maxRetryAfterMs ? null : Math.max(0, ms);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  // An aborted signal never fires "abort" again, so without this a wait would
  // sleep its whole length after the caller already gave up.
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
