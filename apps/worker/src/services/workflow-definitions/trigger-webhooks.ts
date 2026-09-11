/**
 * The webhook endpoint behind one trigger node, as the editor manages it.
 *
 * Every operation here is about a credential, so each one is audited by actor
 * and endpoint id and never by value: no secret, and no payload of anything the
 * endpoint received, reaches a log line. The store's refusals come back as
 * values rather than exceptions, because the same missing row means 404 in one
 * route and 409 in another depending on what the caller was trying to do.
 */
import { listConnectedRecentWebhookDeliveries } from "../../db/repositories/webhook-trigger-deliveries.js";
import {
  getConnectedWebhookEndpointById,
  getConnectedWebhookEndpointForNode,
  revealConnectedWebhookEndpointSecret,
  revokeConnectedWebhookEndpoint,
  rotateConnectedWebhookEndpointSecret,
  setConnectedWebhookEndpointSecret,
  unrevokeConnectedWebhookEndpoint,
  WebhookRotationInFlightError,
  WebhookSecretInvalidError,
  type WebhookEndpointRow,
} from "../../webhook-trigger/endpoint-store.js";
import { getConnectedEnabledDeployedDefinition } from "../../engine/definition-trigger-routing.js";
import { parseOptionalWorkflowDefinitionVersionRow } from "../../engine/stored-definition-reads.js";
import {
  auditWebhookAction,
  mintMissingEndpointForConnectedDefinition,
  type WebhookEndpointTarget,
} from "./webhook-endpoint-nodes.js";

/** How much history the endpoint panel shows. Enough to see a pattern, small
 *  enough to stay one query and one render. */
const DELIVERY_LOG_LIMIT = 50;

/** The endpoint row for one trigger node, or null when none has been minted. */
export function findWebhookEndpoint(
  target: WebhookEndpointTarget,
): Promise<WebhookEndpointRow | null> {
  return getConnectedWebhookEndpointForNode(target.definitionId, target.nodeId);
}

/** Recent deliveries for one endpoint, newest first. */
export function listWebhookEndpointDeliveries(endpointId: string) {
  return listConnectedRecentWebhookDeliveries(endpointId, DELIVERY_LOG_LIMIT);
}

export type WebhookEndpointState =
  | { state: "unconfigured" | "await_deploy"; endpoint: null }
  | { state: "revoked" | "active" | "inactive"; endpoint: WebhookEndpointRow };

/**
 * Everything the editor shows for one webhook trigger node, minus the wire
 * shaping the transport does.
 *
 * Reading also heals: an endpoint is normally minted when a definition is
 * deployed or enabled, but a definition deployed before this feature existed (or
 * one whose best-effort mint failed) has a live webhook node and no endpoint
 * row. Minting here means opening the node's panel repairs it. The heal is a
 * write, so the caller says whether this request may make it: a member GET with
 * no row reads await_deploy instead, and an owner or admin opening the panel is
 * what backfills a pre-existing definition.
 */
export async function readWebhookEndpointState(
  target: WebhookEndpointTarget,
  options: { actorId: string; mayMint: boolean; encryptionKey: string | undefined },
): Promise<WebhookEndpointState> {
  if (!options.encryptionKey) return { state: "unconfigured", endpoint: null };
  let endpoint = await getConnectedWebhookEndpointForNode(target.definitionId, target.nodeId);
  if (!endpoint && options.mayMint) {
    endpoint = await mintMissingEndpointForConnectedDefinition(options.encryptionKey, target);
    if (endpoint) auditWebhookAction(options.actorId, endpoint.id, "minted");
  }
  if (!endpoint) return { state: "await_deploy", endpoint: null };
  if (endpoint.revokedAt) return { state: "revoked", endpoint };

  // Present and live, but is THIS definition currently receiving deliveries?
  // Routing is per endpoint, so its own definition must be enabled with a
  // readable deployed head; otherwise the endpoint exists but every delivery
  // to it is refused.
  const rawLive = await getConnectedEnabledDeployedDefinition(target.definitionId);
  const live = rawLive
    ? { ...rawLive, current: parseOptionalWorkflowDefinitionVersionRow(rawLive.current) }
    : null;
  return { state: live?.current ? "active" : "inactive", endpoint };
}

/** The current signing secret, or null when there is nothing to reveal. */
export async function revealWebhookSecret(
  encryptionKey: string,
  endpointId: string,
  actorId: string,
): Promise<string | null> {
  const secret = await revealConnectedWebhookEndpointSecret(encryptionKey, endpointId);
  if (!secret) return null;
  auditWebhookAction(actorId, endpointId, "revealed");
  return secret;
}

/**
 * Take an endpoint out of service, and report when it happened.
 *
 * The row is read back rather than trusted: the revocation instant is the
 * database clock's, and an endpoint that was already revoked keeps its original
 * one. Null means the row is gone, which the caller answers as a miss.
 */
export async function revokeWebhookEndpointForNode(
  endpointId: string,
  actorId: string,
): Promise<Date | null> {
  await revokeConnectedWebhookEndpoint(endpointId);
  const revoked = await getConnectedWebhookEndpointById(endpointId);
  if (!revoked?.revokedAt) return null;
  auditWebhookAction(actorId, endpointId, "revoked");
  return revoked.revokedAt;
}

export type WebhookRevivalResult =
  | { ok: true; endpointId: string; secret: string }
  | { ok: false; reason: "unknown" | "not_revoked" };

/**
 * Bring a revoked endpoint back on a brand new secret.
 *
 * The store would happily run this against a live endpoint, which would silently
 * replace a working secret with no rotation window and no warning, so it is
 * refused: reviving is only meaningful for something that is out of service.
 * A live endpoint's secret is replaced through a rotation, which keeps the old
 * one accepted while the sender is updated.
 */
export async function reviveWebhookEndpoint(
  encryptionKey: string,
  endpoint: WebhookEndpointRow,
  actorId: string,
): Promise<WebhookRevivalResult> {
  if (!endpoint.revokedAt) return { ok: false, reason: "not_revoked" };
  const revived = await unrevokeConnectedWebhookEndpoint(encryptionKey, endpoint.id);
  if (!revived) {
    // The revival only touches a still-revoked row. Our pre-read saw one, so a
    // null means the row changed underneath us: revived by a concurrent caller,
    // or its definition was archived away.
    const stillThere = await getConnectedWebhookEndpointById(endpoint.id);
    return { ok: false, reason: stillThere ? "not_revoked" : "unknown" };
  }

  auditWebhookAction(actorId, revived.endpointId, "unrevoked");
  return { ok: true, endpointId: revived.endpointId, secret: revived.secret };
}

export type WebhookRotationResult =
  | { ok: true; endpointId: string; secret: string; previousExpiresAt: Date }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "rotation_in_flight"; previousExpiresAt: Date };

/**
 * Replace the signing secret and return the new one, once.
 *
 * A rotation keeps the replaced secret valid for a fixed window so the sender
 * can be updated without a failed delivery. Rotating again while that window is
 * open would evict a secret the first rotation is still promising to accept, so
 * it is refused until the operator says `force` (the leaked-secret case, where
 * the old one must die now).
 */
export async function rotateWebhookSecret(
  encryptionKey: string,
  endpointId: string,
  options: { force: boolean; actorId: string },
): Promise<WebhookRotationResult> {
  let rotated: Awaited<ReturnType<typeof rotateConnectedWebhookEndpointSecret>>;
  try {
    rotated = await rotateConnectedWebhookEndpointSecret(encryptionKey, endpointId, {
      force: options.force,
    });
  } catch (error) {
    if (error instanceof WebhookRotationInFlightError) {
      return {
        ok: false,
        reason: "rotation_in_flight",
        previousExpiresAt: error.previousExpiresAt,
      };
    }
    throw error;
  }
  if (!rotated) return { ok: false, reason: "unknown" };

  auditWebhookAction(options.actorId, rotated.endpointId, "rotated");
  return {
    ok: true,
    endpointId: rotated.endpointId,
    secret: rotated.secret,
    previousExpiresAt: rotated.previousExpiresAt,
  };
}

export type WebhookSecretImportResult =
  | { ok: true; endpoint: WebhookEndpointRow }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "invalid"; message: string };

/**
 * Adopt a secret the sender itself generated, for a system that signs with its
 * own value rather than one this endpoint minted.
 *
 * A hard replace with no dual-accept window: the old minted secret stops working
 * immediately, which is the operator's explicit intent when importing. The
 * imported value is never logged and never echoed back.
 */
export async function importWebhookSecret(
  encryptionKey: string,
  endpointId: string,
  secret: string,
  actorId: string,
): Promise<WebhookSecretImportResult> {
  let updated: WebhookEndpointRow | null;
  try {
    updated = await setConnectedWebhookEndpointSecret(encryptionKey, endpointId, secret);
  } catch (error) {
    if (error instanceof WebhookSecretInvalidError) {
      return { ok: false, reason: "invalid", message: error.message };
    }
    throw error;
  }
  if (!updated) return { ok: false, reason: "unknown" };

  // Actor and endpoint id only: never the imported secret.
  auditWebhookAction(actorId, updated.id, "secret_imported");
  return { ok: true, endpoint: updated };
}
