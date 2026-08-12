import { isSafeWorkflowInputName, type JsonValue } from "@shared/contracts";

/**
 * Block-facing shape of one webhook delivery. Every field is a string because
 * the trigger_webhook block declares string outputs: an external system that
 * sends a number, a boolean, an object or nothing at all must still produce a
 * usable entry instead of failing the delivery.
 */
export interface WebhookTriggerEntry {
  subject: string;
  description: string;
  requester: string;
  priority: string;
  /** Optional provider-normalized support case. Generic webhooks omit this
   * field, preserving the original trigger contract. */
  supportCase?: SupportCase;
  /** The delivered body, unchanged, so a workflow can read anything the
   *  configured mappings did not name. JSON-shaped because it is persisted as
   *  jsonb and carried through a Workflow input, both of which must serialize. */
  payload: JsonValue;
}

/** Explicit contract shared by provider-specific support webhook endpoints.
 * The raw payload remains available alongside this bounded, normalized view. */
export interface SupportCase {
  [key: string]: JsonValue;
  provider: "zendesk" | "sentry";
  endpoint: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  description: string;
  severity: string;
  priority: string;
  reporter: string;
  customerContext: JsonValue;
  metadata: JsonValue;
}

/** Payload-shaped node-config keys. The endpoint row owns the auth keys, which
 * have no meaning for mapping. */
export interface WebhookMappingConfig {
  /** Set only for a provider-specific support endpoint. */
  provider?: "zendesk" | "sentry" | null;
  sourceIdPath?: string | null;
  sourceUrlPath?: string | null;
  customerContextPath?: string | null;
  subjectPath?: string | null;
  mapSubject?: string | null;
  mapDescription?: string | null;
  mapRequester?: string | null;
  mapPriority?: string | null;
}

export interface MappedWebhookPayload {
  entry: WebhookTriggerEntry;
  /** Stable external identity of the thing this delivery is about (a ticket id,
   *  for example). Null when no subjectPath is configured or it does not resolve
   *  to a non-empty scalar, in which case the caller falls back to the delivery
   *  id and every delivery gets its own subject. */
  subjectId: string | null;
}

/** Same values the block registry defaults to, repeated here so a caller that
 *  passes a partially populated config still maps the documented fields. */
const DEFAULT_MAPPINGS = {
  mapSubject: "subject",
  mapDescription: "description",
  mapRequester: "requester",
  mapPriority: "priority",
} as const;

/**
 * Resolve the configured dot-paths against a delivered JSON body. Deliberately
 * total: a missing path, a null, or a leaf that is not a scalar maps to the
 * empty string rather than throwing, because the sender controls the body and a
 * shape surprise must not turn an authenticated delivery into a 500.
 */
export function mapWebhookPayload(
  config: WebhookMappingConfig,
  body: JsonValue,
  endpointId = "",
): MappedWebhookPayload {
  const entry: WebhookTriggerEntry = {
    subject: mappedString(body, config.mapSubject ?? DEFAULT_MAPPINGS.mapSubject),
    description: mappedString(
      body,
      config.mapDescription ?? DEFAULT_MAPPINGS.mapDescription,
    ),
    requester: mappedString(
      body,
      config.mapRequester ?? DEFAULT_MAPPINGS.mapRequester,
    ),
    priority: mappedString(body, config.mapPriority ?? DEFAULT_MAPPINGS.mapPriority),
    payload: body,
  };
  if (config.provider) {
    const customerContext = resolvePayloadPath(
      body,
      config.customerContextPath ?? config.mapRequester ?? "",
    );
    entry.supportCase = {
      provider: config.provider,
      endpoint: endpointId,
      sourceId: mappedString(body, config.sourceIdPath),
      sourceUrl: mappedString(body, config.sourceUrlPath),
      title: entry.subject,
      description: entry.description,
      severity: entry.priority,
      priority: entry.priority,
      reporter: entry.requester,
      customerContext:
        customerContext === undefined ? entry.requester : (customerContext as JsonValue),
      metadata: body,
    };
  }
  return { entry, subjectId: resolveSubjectId(body, config.subjectPath) };
}

function resolveSubjectId(
  body: JsonValue,
  subjectPath: string | null | undefined,
): string | null {
  if (!subjectPath) return null;
  const resolved = mappedString(body, subjectPath).trim();
  return resolved.length > 0 ? resolved : null;
}

function mappedString(body: JsonValue, path: string | null | undefined): string {
  if (!path) return "";
  return scalarToString(resolvePayloadPath(body, path));
}

/**
 * Walk a dot-path over plain objects and arrays. The path must satisfy the same
 * segment rule the node-config validator enforces, so a mapping can never reach
 * a prototype-mutating property even if a row was written around that validator.
 * Numeric segments index arrays; anything unresolvable returns undefined.
 */
function resolvePayloadPath(body: JsonValue, path: string): unknown {
  if (!isSafeWorkflowInputName(path)) return undefined;
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function scalarToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  // null, undefined, objects and arrays have no meaningful one-line rendering.
  return "";
}
