import type { JsonValue, WebhookAuthScheme } from "@shared/contracts";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import { PostgresRunRegistry } from "../../../adapters/run-registry/postgres.js";
import { getDb, type Db } from "../../../db/client.js";
import { logger } from "../../../infra/logger.js";
import {
  WebhookSecretDecryptionError,
  WebhookSecretKeyMismatchError,
} from "../../../infra/webhook-crypto.js";
import {
  decryptCandidateSecrets,
  readWebhookEndpointForDelivery,
  type WebhookEndpointRow,
} from "../../../webhook-trigger/endpoint-store.js";
import {
  getEnabledDeployedDefinition,
  runnableDefinitionOf,
} from "../../../workflow-definition/store.js";
import { webhookTriggerEncryptionKey } from "../../settings/index.js";
import {
  DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  WEBHOOK_INGRESS_LIMIT_PER_MINUTE,
  checkAndIncrementWebhookRate,
  dispatchWebhookDelivery,
  fallbackWebhookDeliveryId,
  mapWebhookPayload,
  recordWebhookRejection,
  verifyWebhookAuth,
  type WebhookMappingConfig,
} from "../../webhook-trigger/index.js";
import { createWebhookDispatchDeps, webhookNodeOf } from "./dispatch-deps.js";

/**
 * Public ingress for one webhook trigger endpoint, as a service operation.
 *
 * The route above it owns raw-byte capture and the HTTP answer; everything that
 * decides whether a delivery becomes a run lives here, because the order below
 * is the security contract, not an implementation detail: identity of the
 * endpoint, then whether it is still live, then rate limiting, then size, then
 * authentication, and only then anything that parses what the sender sent.
 * Nothing before authentication touches the body's content, and every refusal is
 * tallied so an endpoint that rejects everything is visible to the operator
 * instead of looking idle.
 *
 * The precise refusal reason returned here is what the operator sees in the
 * rejection counter. Collapsing it to the coarse class the external caller
 * learns is the route's job, so a URL holder cannot enumerate endpoint state or
 * key drift.
 */

/** Refused before the request could become a delivery. Recorded verbatim in the
 *  rejection counter (the operator's signal); the caller sees only the coarse
 *  class the route maps each to. */
export type WebhookRejectionReason =
  | "unknown_endpoint"
  | "endpoint_disabled"
  | typeof RETIRED_SCHEMA_MESSAGE
  | "rate_limited"
  | "length_required"
  | "payload_too_large"
  | "decrypt_failed"
  | "missing_signature"
  | "invalid_signature"
  | "stale_timestamp"
  | "invalid_payload";

/** Bodies above this are refused. Large enough for any realistic ticket-shaped
 *  payload, small enough that a hostile sender cannot fill the inbox with one
 *  request. Exported so the dry-run test delivery enforces the same cap. */
export const WEBHOOK_MAX_BODY_BYTES = 512 * 1024;

/** A minted id is `wh_` + 24 hex chars. A segment that cannot be one never named
 *  an endpoint, so it is refused without a counter row: recording under the raw
 *  segment would let an unauthenticated caller mint unbounded counter rows. */
const WEBHOOK_ENDPOINT_ID_PATTERN = /^wh_[0-9a-f]{24}$/;

/** A well-formed but unknown id is tallied under this single constant, not the
 *  raw segment, so the rejection table's cardinality stays at real endpoints + 1
 *  no matter how many distinct fake ids are probed. */
const UNKNOWN_ENDPOINT_COUNTER_ID = "unknown";

/** Delivery id header value is capped so a hostile sender cannot bloat the
 *  primary key with an unbounded identity. */
const MAX_DELIVERY_ID_LENGTH = 200;

/** The endpoint's node in the definition version this delivery is pinned to. */
interface LiveWebhookTarget {
  definitionId: number;
  definitionVersion: number;
  nodeId: string;
  configuration: WebhookMappingConfig;
}

/** Everything the decision needs from the request, with no H3 event attached. */
export interface CustomWebhookRequest {
  /** The `[endpointId]` path segment, already trimmed. */
  endpointId: string;
  /** The sender's Content-Length header, verbatim. */
  contentLength: string | undefined;
  /** The exact bytes the sender posted, as UTF-8. */
  rawBody: string;
  /** Every request header, lowercased, as the signature check reads them. */
  headers: Record<string, string | undefined>;
  /** The sender's delivery id header, when it sent one. */
  deliveryIdHeader: string | undefined;
}

export type CustomWebhookOutcome =
  /** The path segment could never have named an endpoint: no counter, no probe. */
  | { outcome: "unroutable" }
  /** Refused with the precise reason the counter recorded. */
  | { outcome: "refused"; reason: WebhookRejectionReason }
  | { outcome: "dispatched"; runId: string }
  | { outcome: "coalesced" }
  /** Durably recorded and decided: nothing the sender can retry into a run. */
  | { outcome: "rejected"; reason: string }
  | { outcome: "at_capacity" }
  | { outcome: "dispatch_failed"; diagnosticId: string };

export async function deliverCustomWebhook(
  request: CustomWebhookRequest,
): Promise<CustomWebhookOutcome> {
  const db = getDb();
  const endpointId = request.endpointId;

  // A malformed segment never named an endpoint. Refuse it before any DB write,
  // and above all without a counter row keyed on the raw segment.
  if (!WEBHOOK_ENDPOINT_ID_PATTERN.test(endpointId)) {
    return { outcome: "unroutable" };
  }

  const found = await readWebhookEndpointForDelivery(db, endpointId);
  // Well-formed but unknown: tallied under one constant id so a probe of many
  // fake ids cannot grow the rejection table beyond real endpoints + 1.
  if (!found) return refuse(db, UNKNOWN_ENDPOINT_COUNTER_ID, "unknown_endpoint");
  const { endpoint, dbNow } = found;
  if (endpoint.revokedAt) return refuse(db, endpointId, "endpoint_disabled");

  // Fail-closed and uncached: an endpoint row outlives the definition state that
  // makes it dispatchable, so the live head is what decides, on every request.
  const resolvedTarget = await resolveLiveWebhookTarget(db, endpoint);
  if (!resolvedTarget) return refuse(db, endpointId, "endpoint_disabled");
  if (resolvedTarget.kind === "retired") {
    return refuse(db, endpointId, resolvedTarget.reason);
  }
  const target = resolvedTarget.target;

  // Ingress budget, charged before any decrypt or HMAC: a URL holder flooding
  // junk cannot burn unbounded CPU, and this never touches the inbox budget the
  // real sender spends. Only now that the id names a live row, since the counter
  // has a foreign key to it.
  const ingress = await checkAndIncrementWebhookRate(
    db,
    endpointId,
    "ingress",
    WEBHOOK_INGRESS_LIMIT_PER_MINUTE,
  );
  if (!ingress.allowed) return refuse(db, endpointId, "rate_limited");

  // Require an honest Content-Length so the cheap refusal below runs before the
  // body is buffered. The post-read cap still holds as defense against a lying
  // length: a sender controls the header, and the route buffers what arrives.
  const declaredLength = Number(request.contentLength);
  if (!Number.isFinite(declaredLength)) {
    return refuse(db, endpointId, "length_required");
  }
  if (declaredLength > WEBHOOK_MAX_BODY_BYTES) {
    return refuse(db, endpointId, "payload_too_large");
  }
  const rawBody = request.rawBody;
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BODY_BYTES) {
    return refuse(db, endpointId, "payload_too_large");
  }

  // dbNow, not the app clock: previousExpiresAt was stamped on the DB clock, so
  // a skewed worker must not keep offering a replaced secret past its expiry.
  const candidates = decryptEndpointSecrets(endpoint, dbNow);
  if (!candidates) return refuse(db, endpointId, "decrypt_failed");

  // The endpoint row is the source of truth for the scheme and header override:
  // a deploy re-syncs them from the node config (like any other block param),
  // and this row is exactly what the config API shows the operator.
  const verified = verifyWebhookAuth({
    scheme: endpoint.authScheme as WebhookAuthScheme,
    headerName: endpoint.headerName,
    rawBody,
    headers: request.headers,
    candidates,
    // Replay protection is per-endpoint config, re-synced from the node on every
    // deploy. dbNow, not the app clock: the freshness window is anchored to the
    // same clock the rotation window is, so a skewed worker never widens it.
    requireTimestamp: endpoint.requireTimestamp,
    timestampHeader: endpoint.timestampHeader,
    timestampToleranceSeconds: endpoint.timestampToleranceSeconds,
    now: dbNow,
  });
  if (!verified.ok) {
    return refuse(db, endpointId, verified.reason);
  }

  // Inbox budget, charged only now that the signature is valid: authenticated
  // deliveries have their own limit that unauthenticated junk cannot spend.
  const inbox = await checkAndIncrementWebhookRate(
    db,
    endpointId,
    "inbox",
    DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  );
  if (!inbox.allowed) return refuse(db, endpointId, "rate_limited");

  let body: JsonValue;
  try {
    body = JSON.parse(rawBody) as JsonValue;
  } catch {
    return refuse(db, endpointId, "invalid_payload");
  }

  // A sender that repeats its delivery id gets the first envelope back. Without
  // one, the body's digest stands in, so a blind retry still starts one run.
  const deliveryId =
    request.deliveryIdHeader?.trim().slice(0, MAX_DELIVERY_ID_LENGTH) ||
    fallbackWebhookDeliveryId(rawBody);

  const mapped = mapWebhookPayload(target.configuration, body, endpointId);
  const result = await dispatchWebhookDelivery(
    {
      endpointId,
      definitionId: target.definitionId,
      definitionVersion: target.definitionVersion,
      nodeId: target.nodeId,
      deliveryId,
      subjectId: mapped.subjectId,
      entry: mapped.entry,
      verifiedWith: verified.verifiedWith,
    },
    createWebhookDispatchDeps(db, new PostgresRunRegistry(db)),
  );

  if (result.result === "started") {
    return { outcome: "dispatched", runId: result.runId };
  }
  if (result.result === "coalesced") {
    return { outcome: "coalesced" };
  }
  if (result.result === "rejected") {
    return { outcome: "rejected", reason: result.reason };
  }
  if (result.result === "at_capacity") {
    logger.info({ endpointId, deliveryId }, "webhook_delivery_at_capacity");
    return { outcome: "at_capacity" };
  }
  return { outcome: "dispatch_failed", diagnosticId: result.reason };
}

/**
 * The endpoint's node in the live head, or null when this endpoint may not
 * receive anything right now: its own definition is disabled, archived, or has no
 * readable deployed head, or that head no longer declares this node. Routing is
 * per endpoint, so only this endpoint's own definition id decides.
 */
async function resolveLiveWebhookTarget(
  db: Db,
  endpoint: WebhookEndpointRow,
): Promise<
  | { kind: "runnable"; target: LiveWebhookTarget }
  | { kind: "retired"; reason: typeof RETIRED_SCHEMA_MESSAGE }
  | null
> {
  const live = await getEnabledDeployedDefinition(db, endpoint.definitionId);
  if (!live || !live.current) {
    return null;
  }
  if (live.current.schema === "legacy-v1") {
    return { kind: "retired", reason: RETIRED_SCHEMA_MESSAGE };
  }
  const liveGraph = runnableDefinitionOf(live.current);
  const node = liveGraph
    ? webhookNodeOf(liveGraph.nodes, endpoint.nodeId)
    : undefined;
  if (!node) return null;
  return {
    kind: "runnable",
    target: {
      definitionId: endpoint.definitionId,
      definitionVersion: live.current.version,
      nodeId: endpoint.nodeId,
      configuration: node.configuration as WebhookMappingConfig,
    },
  };
}

/**
 * Every secret this endpoint still accepts, or null when the stored ciphertext
 * cannot be trusted. A decrypt failure is never an authentication failure: the
 * sender may be perfectly correct while the deployment lost or replaced its
 * encryption key, and reporting 401 would send an operator hunting the wrong bug.
 */
function decryptEndpointSecrets(endpoint: WebhookEndpointRow, now: Date) {
  const keyHex = webhookTriggerEncryptionKey();
  if (!keyHex) {
    logger.warn({ endpointId: endpoint.id }, "webhook_delivery_decrypt_unconfigured");
    return null;
  }
  try {
    return decryptCandidateSecrets(endpoint, keyHex, now);
  } catch (error) {
    if (
      error instanceof WebhookSecretKeyMismatchError ||
      error instanceof WebhookSecretDecryptionError
    ) {
      // Name only: the error message carries key fingerprints, and nothing about
      // a secret belongs in a log line.
      logger.warn(
        { endpointId: endpoint.id, failure: error.name },
        "webhook_delivery_decrypt_failed",
      );
      return null;
    }
    throw error;
  }
}

/**
 * Tally the refusal under its precise reason (the operator's only trace, since a
 * rejected request never becomes a delivery row) and hand the caller that same
 * precise reason. The route collapses it to the coarse class the sender learns.
 */
async function refuse(
  db: Db,
  endpointId: string,
  reason: WebhookRejectionReason,
): Promise<CustomWebhookOutcome> {
  // Best-effort tally: a counter-write failure must not upgrade a coarse 4xx into
  // a 500, so it is swallowed. The caller still gets the right refusal status.
  await recordWebhookRejection(db, endpointId, reason).catch(() => {});
  return { outcome: "refused", reason };
}
