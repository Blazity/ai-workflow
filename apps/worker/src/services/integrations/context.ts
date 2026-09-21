import type { IntegrationContext, IntegrationLogFields, IntegrationLogger } from "@integrations/sdk";
import { INTEGRATION_HTTP_DEFAULTS } from "@integrations/sdk";
import type { IntegrationManifest } from "@integrations/sdk";

import { logger } from "../../infra/logger.js";
import { type ConnectionValue, redactIntegrationText } from "./connection-values.js";

/**
 * The context an integration receives for a connection test or a health probe.
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
  readonly signal: AbortSignal;
}): IntegrationContext<IntegrationManifest> {
  const redact = (text: string) => redactIntegrationText(text, input.secrets);
  const webhookUrl = integrationWebhookUrl(input.manifest.id);
  return {
    connection: input.values as never,
    http: { fetch: (target, init) => fetchWithPolicy(target, init, input.signal) },
    log: redactingLogger(input.manifest.id, redact),
    signal: input.signal,
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
 * The HTTP policy the SDK documents: a per-attempt timeout, retries for reads
 * only, `Retry-After` honoured up to a ceiling, a non-2xx returned rather than
 * thrown.
 *
 * Writes are not retried by default because a PUT or a DELETE at these providers
 * is a merge, a rebase or a file commit, and repeating one after an ambiguous
 * 5xx reports a conflict for work that landed.
 */
async function fetchWithPolicy(
  target: string | URL | Request,
  init: (RequestInit & { timeoutMs?: number; retries?: number }) | undefined,
  outer: AbortSignal,
): Promise<Response> {
  const method = (init?.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase();
  const retriable = INTEGRATION_HTTP_DEFAULTS.retriedMethods.includes(
    method as (typeof INTEGRATION_HTTP_DEFAULTS.retriedMethods)[number],
  );
  const retries = init?.retries ?? (retriable ? INTEGRATION_HTTP_DEFAULTS.retries : 0);
  const timeoutMs = init?.timeoutMs ?? INTEGRATION_HTTP_DEFAULTS.timeoutMs;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([outer, timer]);
    try {
      const response = await fetch(target, { ...init, signal });
      if (attempt === retries || (response.status !== 429 && response.status < 500)) {
        return response;
      }
      const wait = retryAfterMs(response);
      if (wait === null) return response;
      await delay(wait, outer);
      continue;
    } catch (error) {
      lastError = error;
      if (outer.aborted || attempt === retries) throw error;
      await delay(250 * (attempt + 1), outer);
    }
  }
  throw lastError ?? new Error("Request failed");
}

/** A wait longer than the ceiling is a refusal, not a wait: the invocation has
 *  its own deadline and sleeping through it helps nobody. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (!Number.isFinite(seconds)) return 0;
  const ms = seconds * 1000;
  return ms > INTEGRATION_HTTP_DEFAULTS.maxRetryAfterMs ? null : ms;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
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
