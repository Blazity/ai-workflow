import type { JsonValue, WebhookAuthScheme } from "@shared/contracts";
import {
  createError,
  defineEventHandler,
  getHeader,
  getHeaders,
  getRouterParam,
  readRawBody,
} from "h3";
import { env } from "../../../../env.js";
import { PostgresRunRegistry } from "../../../adapters/run-registry/postgres.js";
import type { RunRegistryAdapter } from "../../../adapters/run-registry/types.js";
import { getDb, type Db } from "../../../db/client.js";
import {
  envTriggerRateLimitDefault,
  triggerNodeRateLimitParams,
} from "../../../lib/dispatch.js";
import { logger } from "../../../lib/logger.js";
import {
  resolveTriggerRateLimit,
  type TriggerRateLimitConfig,
} from "../../../lib/trigger-rate-limit.js";
import {
  WebhookSecretDecryptionError,
  WebhookSecretKeyMismatchError,
} from "../../../lib/webhook-crypto.js";
import {
  dispatchWebhookDelivery,
  fallbackWebhookDeliveryId,
  type WebhookDispatchDeps,
  type WebhookDispatchGuardRejection,
  type WebhookDispatchTarget,
} from "../../../webhook-trigger/dispatch-webhook-trigger.js";
import {
  decryptCandidateSecrets,
  getWebhookEndpointById,
  readWebhookEndpointForDelivery,
  type WebhookEndpointRow,
} from "../../../webhook-trigger/endpoint-store.js";
import {
  mapWebhookPayload,
  type WebhookMappingConfig,
} from "../../../webhook-trigger/payload-mapping.js";
import {
  checkAndIncrementWebhookRate,
  DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  WEBHOOK_INGRESS_LIMIT_PER_MINUTE,
} from "../../../webhook-trigger/rate-limit.js";
import { recordWebhookRejection } from "../../../webhook-trigger/rejection-counters.js";
import { verifyWebhookAuth } from "../../../webhook-trigger/verify.js";
import {
  getEnabledDeployedDefinition,
  getWorkflowDefinitionVersion,
} from "../../../workflow-definition/store.js";

/**
 * Public ingress for one webhook trigger endpoint. Outside the dashboard session
 * middleware (it only gates /api/v1/*), so the endpoint's own signature or token
 * is the entire authentication story.
 *
 * The order below is the security contract, not an implementation detail:
 * identity of the endpoint, then whether it is still live, then rate limiting,
 * then size, then authentication, and only then anything that parses what the
 * sender sent. Nothing before authentication touches the body's content, and
 * every refusal is tallied so an endpoint that rejects everything is visible to
 * the operator instead of looking idle.
 *
 * The HTTP response deliberately collapses the precise reason to a coarse one
 * (404 not_found for both unknown and disabled endpoints, 401 unauthorized for
 * both missing and invalid signatures, a generic 503 for decrypt drift). The
 * precise reason is still recorded in the rejection counter and surfaced to the
 * operator; the external caller only learns the class, so a URL holder cannot
 * enumerate endpoint state or key drift.
 */

/** Refused before the request could become a delivery. Recorded verbatim in the
 *  rejection counter (the operator's signal); the caller sees only the coarse
 *  response REJECTIONS maps each to. */
type WebhookRejectionReason =
  | "unknown_endpoint"
  | "endpoint_disabled"
  | "rate_limited"
  | "length_required"
  | "payload_too_large"
  | "decrypt_failed"
  | "missing_signature"
  | "invalid_signature"
  | "stale_timestamp"
  | "invalid_payload";

/** Precise reason -> the coarse HTTP answer the external caller receives. */
const REJECTIONS: Record<
  WebhookRejectionReason,
  { status: number; externalReason: string }
> = {
  // Unknown and disabled collapse to one answer: which endpoint ids exist, and
  // which were taken out of service, is not something a caller may enumerate.
  unknown_endpoint: { status: 404, externalReason: "not_found" },
  endpoint_disabled: { status: 404, externalReason: "not_found" },
  rate_limited: { status: 429, externalReason: "rate_limited" },
  length_required: { status: 411, externalReason: "length_required" },
  payload_too_large: { status: 413, externalReason: "payload_too_large" },
  // Never 401: a decrypt failure is a deployment key problem, not a bad
  // credential, and the operator fix is different. The generic 503 body keeps it
  // from being told apart from an ordinary outage from the outside.
  decrypt_failed: { status: 503, externalReason: "unavailable" },
  // Missing and invalid collapse: "you sent no signature" and "your signature
  // was wrong" must look identical to a probing caller.
  missing_signature: { status: 401, externalReason: "unauthorized" },
  invalid_signature: { status: 401, externalReason: "unauthorized" },
  // A missing, non-numeric, or out-of-tolerance timestamp is precise in the
  // counter (it distinguishes replay-window drift from a wrong secret) but the
  // caller only ever learns unauthorized, same as any other auth failure.
  stale_timestamp: { status: 401, externalReason: "unauthorized" },
  // Reachable only after authentication succeeds, so it is no oracle: a genuine
  // sender that posted a non-JSON body deserves the precise reason.
  invalid_payload: { status: 422, externalReason: "invalid_payload" },
};

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

const DELIVERY_ID_HEADER = "x-delivery-id";

/** The endpoint's node in the definition version this delivery is pinned to. */
interface LiveWebhookTarget {
  definitionId: number;
  definitionVersion: number;
  nodeId: string;
  configuration: WebhookMappingConfig;
}

export default defineEventHandler(async (event) => {
  const db = getDb();
  const endpointId = getRouterParam(event, "endpointId")?.trim() ?? "";

  // A malformed segment never named an endpoint. Refuse it before any DB write,
  // and above all without a counter row keyed on the raw segment.
  if (!WEBHOOK_ENDPOINT_ID_PATTERN.test(endpointId)) {
    throw createError({
      statusCode: 404,
      statusMessage: "not_found",
      data: { reason: "not_found" },
    });
  }

  const found = await readWebhookEndpointForDelivery(db, endpointId);
  // Well-formed but unknown: tallied under one constant id so a probe of many
  // fake ids cannot grow the rejection table beyond real endpoints + 1.
  if (!found) return reject(db, UNKNOWN_ENDPOINT_COUNTER_ID, "unknown_endpoint");
  const { endpoint, dbNow } = found;
  if (endpoint.revokedAt) return reject(db, endpointId, "endpoint_disabled");

  // Fail-closed and uncached: an endpoint row outlives the definition state that
  // makes it dispatchable, so the live head is what decides, on every request.
  const target = await resolveLiveWebhookTarget(db, endpoint);
  if (!target) return reject(db, endpointId, "endpoint_disabled");

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
  if (!ingress.allowed) return reject(db, endpointId, "rate_limited");

  // Require an honest Content-Length so the cheap refusal below runs before the
  // body is buffered. The post-read cap still holds as defense against a lying
  // length: a sender controls the header, and readRawBody buffers what arrives.
  const declaredLength = Number(getHeader(event, "content-length"));
  if (!Number.isFinite(declaredLength)) {
    return reject(db, endpointId, "length_required");
  }
  if (declaredLength > WEBHOOK_MAX_BODY_BYTES) {
    return reject(db, endpointId, "payload_too_large");
  }
  const rawBody = (await readRawBody(event, "utf8")) ?? "";
  if (Buffer.byteLength(rawBody, "utf8") > WEBHOOK_MAX_BODY_BYTES) {
    return reject(db, endpointId, "payload_too_large");
  }

  // dbNow, not the app clock: previousExpiresAt was stamped on the DB clock, so
  // a skewed worker must not keep offering a replaced secret past its expiry.
  const candidates = decryptEndpointSecrets(endpoint, dbNow);
  if (!candidates) return reject(db, endpointId, "decrypt_failed");

  // The endpoint row is the source of truth for the scheme and header override:
  // a deploy re-syncs them from the node config (like any other block param),
  // and this row is exactly what the config API shows the operator.
  const verified = verifyWebhookAuth({
    scheme: endpoint.authScheme as WebhookAuthScheme,
    headerName: endpoint.headerName,
    rawBody,
    headers: getHeaders(event),
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
    return reject(db, endpointId, verified.reason);
  }

  // Inbox budget, charged only now that the signature is valid: authenticated
  // deliveries have their own limit that unauthenticated junk cannot spend.
  const inbox = await checkAndIncrementWebhookRate(
    db,
    endpointId,
    "inbox",
    DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE,
  );
  if (!inbox.allowed) return reject(db, endpointId, "rate_limited");

  let body: JsonValue;
  try {
    body = JSON.parse(rawBody) as JsonValue;
  } catch {
    return reject(db, endpointId, "invalid_payload");
  }

  // A sender that repeats its delivery id gets the first envelope back. Without
  // one, the body's digest stands in, so a blind retry still starts one run.
  const deliveryId =
    getHeader(event, DELIVERY_ID_HEADER)?.trim().slice(0, MAX_DELIVERY_ID_LENGTH) ||
    fallbackWebhookDeliveryId(rawBody);

  const mapped = mapWebhookPayload(target.configuration, body);
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
    return { status: "dispatched", runId: result.runId };
  }
  if (result.result === "coalesced") {
    return { status: "coalesced" };
  }
  if (result.result === "rejected") {
    // Durably recorded and decided: the endpoint or its node went away between
    // acceptance and dispatch. Nothing the sender can retry into a run.
    return { status: "rejected", reason: result.reason };
  }
  if (result.result === "at_capacity") {
    logger.info({ endpointId, deliveryId }, "webhook_delivery_at_capacity");
    throw createError({
      statusCode: 503,
      statusMessage: "webhook_at_capacity",
    });
  }
  throw createError({
    statusCode: 500,
    statusMessage: "webhook_dispatch_failed",
    data: { diagnosticId: result.reason },
  });
});

/**
 * Deps for dispatching a webhook delivery, shared with the cron drain so both
 * paths apply the same guard. The guard re-reads state under the subject
 * reservation, because an endpoint can be revoked or a definition disabled while
 * a delivery waits, and it checks the node against the version the delivery is
 * pinned to rather than the current head: that is the graph the run executes.
 */
export function createWebhookDispatchDeps(
  db: Db,
  runRegistry: RunRegistryAdapter,
): WebhookDispatchDeps {
  return {
    db,
    runRegistry,
    maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
    ensureStillDispatchable: (target) => ensureStillDispatchable(db, target),
    resolveTriggerRateLimit: (target) => resolveWebhookTriggerRateLimit(db, target),
  };
}

/**
 * The webhook node's start budget, read from the version the delivery is pinned
 * to so the limit is the one authored in the graph this run would execute. The
 * node's own params beat the env default, and no configuration at all means
 * unlimited.
 *
 * The endpoint's own limits (ingress and inbox) are unrelated and still apply:
 * this is an additional, per-node cap, so the effective ceiling is the smallest
 * of the three.
 */
async function resolveWebhookTriggerRateLimit(
  db: Db,
  target: WebhookDispatchTarget,
): Promise<TriggerRateLimitConfig | null> {
  const pinned = await getWorkflowDefinitionVersion(
    db,
    target.definitionId,
    target.definitionVersion,
  );
  return resolveTriggerRateLimit(
    triggerNodeRateLimitParams(pinned?.definition, target.nodeId),
    envTriggerRateLimitDefault(env),
  );
}

async function ensureStillDispatchable(
  db: Db,
  target: WebhookDispatchTarget,
): Promise<WebhookDispatchGuardRejection | null> {
  const endpoint = await getWebhookEndpointById(db, target.endpointId);
  if (!endpoint || endpoint.revokedAt) return "endpoint_revoked";

  const live = await getEnabledDeployedDefinition(db, target.definitionId);
  if (!live || !live.current) return "definition_disabled";

  const pinned = await getWorkflowDefinitionVersion(
    db,
    target.definitionId,
    target.definitionVersion,
  );
  if (!pinned || !webhookNodeOf(pinned.definition.nodes, target.nodeId)) {
    return "node_missing";
  }
  return null;
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
): Promise<LiveWebhookTarget | null> {
  const live = await getEnabledDeployedDefinition(db, endpoint.definitionId);
  if (!live || !live.current) {
    return null;
  }
  const node = webhookNodeOf(live.current.definition.nodes, endpoint.nodeId);
  if (!node) return null;
  return {
    definitionId: endpoint.definitionId,
    definitionVersion: live.current.version,
    nodeId: endpoint.nodeId,
    configuration: node.configuration as WebhookMappingConfig,
  };
}

/** A trigger_webhook node only exists in a v2 graph, so matching on the type is
 *  also what narrows the node away from a v1 shape. */
function webhookNodeOf(
  nodes: readonly { id: string; type: string; configuration?: unknown }[],
  nodeId: string,
): { configuration: unknown } | null {
  const node = nodes.find((n) => n.id === nodeId && n.type === "trigger_webhook");
  return node ? { configuration: node.configuration ?? {} } : null;
}

/**
 * Every secret this endpoint still accepts, or null when the stored ciphertext
 * cannot be trusted. A decrypt failure is never an authentication failure: the
 * sender may be perfectly correct while the deployment lost or replaced its
 * encryption key, and reporting 401 would send an operator hunting the wrong bug.
 */
function decryptEndpointSecrets(endpoint: WebhookEndpointRow, now: Date) {
  const keyHex = env.WEBHOOK_TRIGGER_ENCRYPTION_KEY;
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
 * rejected request never becomes a delivery row) and answer the caller with the
 * coarse class REJECTIONS maps it to. The two are deliberately different: the
 * panel reads the precise counter, the external caller learns only the class.
 */
async function reject(
  db: Db,
  endpointId: string,
  reason: WebhookRejectionReason,
): Promise<never> {
  // Best-effort tally: a counter-write failure must not upgrade a coarse 4xx into
  // a 500, so it is swallowed. The caller still gets the right refusal status.
  await recordWebhookRejection(db, endpointId, reason).catch(() => {});
  const { status, externalReason } = REJECTIONS[reason];
  throw createError({
    statusCode: status,
    statusMessage: externalReason,
    data: { reason: externalReason },
  });
}
