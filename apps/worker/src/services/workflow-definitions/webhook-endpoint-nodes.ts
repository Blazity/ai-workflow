/**
 * What the deployed graph says about one webhook trigger node.
 *
 * Minting a URL and dry-running a payload against it ask the same question:
 * does the enabled, deployed head of this definition still declare this node?
 * Anything short of that is the "authored but not live" case, so both live here
 * next to the one lookup that answers it, and neither can drift from the other.
 */
import type { JsonValue } from "@shared/contracts";
import { getDb, type Db } from "../../db/client.js";
import { logger } from "../../infra/logger.js";
import {
  acceptWebhookDelivery,
  completeWebhookDelivery,
} from "../../webhook-trigger/delivery-store.js";
import {
  getWebhookEndpointForNode,
  mintWebhookEndpointsForDefinition,
  type MintableWebhookNode,
  type WebhookEndpointRow,
} from "../../webhook-trigger/endpoint-store.js";
import {
  getDeployedWorkflowDefinitionVersion,
  getEnabledDeployedDefinition,
  getWorkflowDefinition,
  runnableDefinitionOf,
} from "../../workflow-definition/store.js";
import { webhookSubjectKey } from "../run-lifecycle/index.js";
import {
  mapWebhookPayload,
  type WebhookMappingConfig,
} from "../webhook-trigger/index.js";

export interface WebhookEndpointTarget {
  definitionId: number;
  nodeId: string;
}

/** Who did what to which endpoint. Never the secret, and never the payload of
 *  anything the endpoint received. */
export function auditWebhookAction(
  actorId: string,
  endpointId: string,
  action:
    | "minted"
    | "rotated"
    | "secret_imported"
    | "revealed"
    | "revoked"
    | "unrevoked"
    | "tested",
): void {
  logger.info({ actorId, endpointId, action }, "webhook_endpoint_action");
}

/**
 * The endpoint's node in the definition's live deployed head, with the version
 * it belongs to. Null unless the definition is enabled, not archived, has a
 * deployed head, and that head declares this webhook node: anything short of all
 * four is the "authored but not live" case, which must never mint a URL a sender
 * could rely on nor let a dead endpoint be tested green.
 */
export async function findDeployedWebhookNode(
  db: Db,
  target: WebhookEndpointTarget,
): Promise<{ definitionVersion: number; node: MintableWebhookNode } | null> {
  const definition = await getWorkflowDefinition(db, target.definitionId);
  if (!definition || !definition.enabled || definition.archivedAt) return null;
  const head = await getDeployedWorkflowDefinitionVersion(db, target.definitionId);
  const graph = runnableDefinitionOf(head);
  if (!head || !graph) return null;
  const node = graph.nodes.find(
    (n) => n.id === target.nodeId && n.type === "trigger_webhook",
  );
  if (!node) return null;
  return {
    definitionVersion: head.version,
    node: { id: node.id, type: "trigger_webhook", configuration: node.configuration ?? {} },
  };
}

/** Mint only for a node that is genuinely live (enabled, not archived, deployed
 *  head declares it), so a draft or a disabled definition never gets a URL a
 *  sender could rely on. */
export async function mintMissingEndpoint(
  db: Db,
  encryptionKey: string,
  target: WebhookEndpointTarget,
): Promise<WebhookEndpointRow | null> {
  const deployed = await findDeployedWebhookNode(db, target);
  if (!deployed) return null;

  await mintWebhookEndpointsForDefinition(db, encryptionKey, {
    definitionId: target.definitionId,
    nodes: [deployed.node],
  });
  return getWebhookEndpointForNode(db, target.definitionId, target.nodeId);
}

export type WebhookTestDeliveryResult =
  | {
      ok: true;
      deliveryId: string;
      entry: ReturnType<typeof mapWebhookPayload>["entry"];
      subjectId: ReturnType<typeof mapWebhookPayload>["subjectId"];
    }
  | { ok: false; reason: "not_deployed" | "not_owner" };

/**
 * Answer "what would this endpoint make of this payload" without any of the
 * consequences of a real delivery.
 *
 * A dry run end to end: it maps the payload exactly as the delivery path would
 * and writes one log row so the operator sees the probe next to real traffic,
 * but it claims no subject, starts no run, and above all takes an identity no
 * sender can ever produce. A real delivery id is either the sender's header or a
 * digest of the body; this one is "test:" plus a UUID, so posting the same body
 * for real afterwards is still a first delivery rather than a replay of this.
 *
 * A dead endpoint must test red, not green, so it is refused when its definition
 * is not enabled and deployed: the probe never suggests a delivery would work
 * when it would be refused at the door.
 */
export async function runWebhookTestDelivery(input: {
  target: WebhookEndpointTarget;
  endpointId: string;
  payload: JsonValue;
  deliveryId: string;
  actorId: string;
}): Promise<WebhookTestDeliveryResult> {
  const db = getDb();

  // The log row pins a definition version, and the version is also where the
  // mappings live. findDeployedWebhookNode also gates enabled + not archived,
  // so a disabled or draft definition has nothing to test against.
  const deployed = await findDeployedWebhookNode(db, input.target);
  if (!deployed) return { ok: false, reason: "not_deployed" };

  // A live delivery to this endpoint is refused unless this definition is
  // enabled with a readable deployed head, so the probe must be too.
  const live = await getEnabledDeployedDefinition(db, input.target.definitionId);
  if (!live || !live.current) return { ok: false, reason: "not_owner" };

  const mapped = mapWebhookPayload(
    deployed.node.configuration as WebhookMappingConfig,
    input.payload,
  );
  await acceptWebhookDelivery(db, {
    endpointId: input.endpointId,
    deliveryId: input.deliveryId,
    // Its own subject too, so a probe never queues behind (or ahead of) real
    // traffic about the same external subject.
    subjectKey: webhookSubjectKey(input.endpointId, input.deliveryId),
    definitionId: input.target.definitionId,
    definitionVersion: deployed.definitionVersion,
    nodeId: input.target.nodeId,
    entry: mapped.entry,
    verifiedWith: null,
  });
  await completeWebhookDelivery(db, input.endpointId, input.deliveryId, {
    outcome: "test",
    reason: null,
    runId: null,
    verifiedWith: null,
  });

  auditWebhookAction(input.actorId, input.endpointId, "tested");
  return { ok: true, deliveryId: input.deliveryId, entry: mapped.entry, subjectId: mapped.subjectId };
}
