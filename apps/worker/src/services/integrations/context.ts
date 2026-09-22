import type {
  IntegrationContext,
  IntegrationLogFields,
  IntegrationLogger,
  IntegrationRequestInit,
} from "@integrations/sdk";
import { ConnectionValueError, INTEGRATION_HTTP_DEFAULTS } from "@integrations/sdk";
import type { IntegrationManifest } from "@integrations/sdk";

import { logger } from "../../infra/logger.js";
import { deploymentPublicBaseUrl } from "../../infra/public-base-url.js";
import { type ConnectionValue, redactIntegrationText } from "./connection-values.js";
import { valueProblemSentence } from "./value-problems.js";

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
  const fields = sendableFieldsOf(input.manifest, input.values);
  return {
    connection: input.values as never,
    http: {
      fetch: (target, init) => fetchWithPolicy(target, init, { lifetime: input.lifetime, redact, fields }),
    },
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
  // The same base the health page scopes webhook deliveries by, from its one
  // reader, so where deliveries arrive and whose deliveries are counted
  // describe the same deployment.
  const base = deploymentPublicBaseUrl();
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
 * `Retry-After` honoured up to a ceiling, a non-2xx returned rather than
 * thrown, and a value no request can carry refused before anything is sent.
 *
 * WRITES ARE SENT ONCE unless the caller says otherwise. A PUT or a DELETE at
 * these providers is a merge, a rebase or a file commit, and repeating one
 * after an ambiguous 5xx reports a conflict for work that landed. A 429 is not
 * proof either: Atlassian's rate-limiting guide says "Only retry if the API is
 * idempotent and the response includes a Retry-After header", and repeating a
 * Jira create or an Arthur task create that did land makes a second one. So a
 * write goes again after a 429 only when the caller set
 * `resendAfterRateLimit` (a provider that documents the call was not
 * processed: Slack) and the 429 said how long to wait.
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
  context: {
    readonly lifetime: AbortSignal;
    readonly redact: (text: string) => string;
    readonly fields: readonly SendableField[];
  },
): Promise<Response> {
  try {
    const unsendable = unsendableValue(target, init?.headers, context.fields);
    if (unsendable) throw unsendable;
    return await fetchWithRetries(target, init, context.lifetime);
  } catch (error) {
    throw redactedError(error, context.redact);
  }
}

async function fetchWithRetries(
  target: string | URL | Request,
  init: IntegrationRequestInit | undefined,
  lifetime: AbortSignal,
): Promise<Response> {
  const {
    timeoutMs,
    retries: requestedRetries,
    resendAfterRateLimit,
    signal: callerSignal,
    ...request
  } = init ?? {};
  const method = (request.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase();
  const read = INTEGRATION_HTTP_DEFAULTS.retriedMethods.includes(
    method as (typeof INTEGRATION_HTTP_DEFAULTS.retriedMethods)[number],
  );
  // A body that is read as it is sent cannot be sent twice.
  const replayable = !(target instanceof Request) && !(request.body instanceof ReadableStream);
  // How many times a request may go again after this kind of answer. An
  // explicit `retries` is the caller's word for every case; otherwise a read
  // may go again after anything, and a write only after a 429 that said how
  // long to wait, and only when its caller asked for exactly that.
  const retriesAfter = (answer: "threw" | "failed" | "rate_limited_with_wait"): number => {
    if (requestedRetries !== undefined) return requestedRetries;
    if (read) return INTEGRATION_HTTP_DEFAULTS.retries;
    return answer === "rate_limited_with_wait" && resendAfterRateLimit === true && replayable
      ? INTEGRATION_HTTP_DEFAULTS.retries
      : 0;
  };
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
      if (wholeRequest.aborted || attempt >= retriesAfter("threw")) throw error;
      await delay(backoffMs(attempt), wholeRequest);
      continue;
    }
    const rateLimited = response.status === 429;
    if (!rateLimited && response.status < 500) return response;
    const answer =
      rateLimited && response.headers.has("retry-after") ? "rate_limited_with_wait" : "failed";
    if (attempt >= retriesAfter(answer)) return response;
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

/** A connection value as `ctx.http` checks it before sending. */
interface SendableField {
  readonly key: string;
  readonly label: string;
  readonly env: string;
  readonly value: string;
}

function sendableFieldsOf(
  manifest: IntegrationManifest,
  values: Readonly<Record<string, ConnectionValue>>,
): SendableField[] {
  return manifest.connection.fields.flatMap((field) => {
    const value = values[field.key];
    return typeof value === "string" && value.length > 0
      ? [{ key: field.key, label: field.label, env: field.env, value }]
      : [];
  });
}

/**
 * A connection value that no request can carry, found before anything is sent,
 * as the error that says so; null when the request is fine as far as the
 * connection's values go.
 *
 * Node would refuse these too, but with a `TypeError` that quotes the value
 * whole and says nothing about where it came from, so it read as the provider
 * being unreachable, and a token pasted with a line break stayed "Connected"
 * while failing every request. Two cases, both about a value this connection
 * holds:
 *
 * - a header whose value contains a connection value with a line break or a
 *   NUL (what the fetch standard forbids in a header value) or a character
 *   above U+00FF (a header is bytes: a zero-width space or a curly quote pasted
 *   from a document);
 * - a URL that does not parse and starts with a connection value (a site
 *   address typed without `https://`).
 *
 * The message names the field's label and never the value; the words are
 * `value-problems.ts`'s, so this and a card's status say the same thing. A
 * secret with a line break never gets here from a run or a test, because
 * reading the values already refused it; this is the platform's header rule,
 * and it holds for any value that ends up in a header, a setting the resolver
 * rightly let through included.
 */
function unsendableValue(
  target: string | URL | Request,
  headers: HeadersInit | undefined,
  fields: readonly SendableField[],
): ConnectionValueError | null {
  if (typeof target === "string" && !URL.canParse(target)) {
    const field = fields.find((candidate) => target.startsWith(candidate.value.replace(/\/+$/u, "")));
    if (field) {
      return new ConnectionValueError(field.key, valueProblemSentence(field, "not_a_url"));
    }
  }
  for (const value of headerValues(headers)) {
    for (const field of fields) {
      if (!value.includes(field.value)) continue;
      if (["\r", "\n", "\0"].some((character) => field.value.includes(character))) {
        return new ConnectionValueError(field.key, valueProblemSentence(field, "header_line_break"));
      }
      if ([...field.value].some((character) => (character.codePointAt(0) ?? 0) > 0xff)) {
        return new ConnectionValueError(field.key, valueProblemSentence(field, "header_character"));
      }
    }
  }
  return null;
}

function headerValues(headers: HeadersInit | undefined): string[] {
  // A `Headers` object cannot hold such a value: building it would already
  // have thrown, in the integration's own code.
  if (!headers || headers instanceof Headers) return [];
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return entries.flatMap((entry) => (typeof entry[1] === "string" ? [entry[1]] : []));
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
