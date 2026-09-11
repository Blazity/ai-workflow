import {
  createError,
  defineEventHandler,
  getHeader,
  getHeaders,
  getRouterParam,
  readRawBody,
} from "h3";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
// The cluster module this route delivers through, not the barrel, which also
// re-exports the polling pass and the other providers' handlers.
import {
  deliverCustomWebhook,
  type WebhookRejectionReason,
} from "../../../services/triggers/custom-webhooks/deliver.js";

/**
 * Public ingress for one webhook trigger endpoint. Outside the dashboard session
 * middleware (it only gates /api/v1/*), so the endpoint's own signature or token
 * is the entire authentication story.
 *
 * This file is the transport adapter: it hands the headers and a reader for the
 * raw bytes to the service that owns the ordered decision (lookup, revocation,
 * ingress budget, size, authentication, inbox budget, parse, dispatch), and maps
 * the precise answer that comes back to the coarse one the caller may learn. The
 * bytes stay unread until that order reaches them.
 *
 * That collapse is the point: 404 not_found for both unknown and disabled
 * endpoints, 401 unauthorized for both missing and invalid signatures, a generic
 * 503 for decrypt drift. The precise reason is still recorded in the rejection
 * counter and surfaced to the operator; the external caller only learns the
 * class, so a URL holder cannot enumerate endpoint state or key drift.
 */

/** Precise reason -> the coarse HTTP answer the external caller receives. */
const REJECTIONS: Record<
  WebhookRejectionReason,
  { status: number; externalReason: string }
> = {
  // Unknown and disabled collapse to one answer: which endpoint ids exist, and
  // which were taken out of service, is not something a caller may enumerate.
  unknown_endpoint: { status: 404, externalReason: "not_found" },
  endpoint_disabled: { status: 404, externalReason: "not_found" },
  [RETIRED_SCHEMA_MESSAGE]: { status: 404, externalReason: "not_found" },
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

const DELIVERY_ID_HEADER = "x-delivery-id";

export default defineEventHandler(async (event) => {
  const outcome = await deliverCustomWebhook({
    endpointId: getRouterParam(event, "endpointId")?.trim() ?? "",
    contentLength: getHeader(event, "content-length"),
    // Lazy on purpose: the service refuses an unknown, disabled or rate-limited
    // endpoint, and a body whose declared length is already over the cap, before
    // it asks for the bytes. Passing a string here would buffer them first.
    readRawBody: async () => (await readRawBody(event, "utf8")) ?? "",
    headers: getHeaders(event),
    deliveryIdHeader: getHeader(event, DELIVERY_ID_HEADER),
  });

  switch (outcome.outcome) {
    case "unroutable":
      // Same bytes as an unknown endpoint, deliberately: a segment that could
      // never have been minted must not be distinguishable from one that was.
      throw refusal(404, "not_found");
    case "refused": {
      const { status, externalReason } = REJECTIONS[outcome.reason];
      throw refusal(status, externalReason);
    }
    case "dispatched":
      return { status: "dispatched", runId: outcome.runId };
    case "coalesced":
      return { status: "coalesced" };
    case "rejected":
      return { status: "rejected", reason: outcome.reason };
    case "at_capacity":
      throw createError({ statusCode: 503, statusMessage: "webhook_at_capacity" });
    case "dispatch_failed":
      throw createError({
        statusCode: 500,
        statusMessage: "webhook_dispatch_failed",
        data: { diagnosticId: outcome.diagnosticId },
      });
  }
});

function refusal(status: number, externalReason: string) {
  return createError({
    statusCode: status,
    statusMessage: externalReason,
    data: { reason: externalReason },
  });
}
