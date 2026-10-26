import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  IntegrationContext,
  IntegrationWebhook,
  IntegrationWebhookReception,
  TrackerTicketEvent,
} from "@integrations/sdk";
import { LinearAdapter } from "./issue-tracker";
import type { manifest } from "./manifest";

type LinearContext = IntegrationContext<typeof manifest>;

const WEBHOOK_REPLAY_WINDOW_MS = 60_000;

/**
 * Handles incoming Linear webhooks, verifying HMAC signatures and replay timestamps,
 * filtering watched projects, and extracting tracker ticket events.
 */
export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => {
    const refusal = verifySignature(request.rawBody, request.headers, ctx);
    if (refusal) return refusal;

    const body = parseBody(request.rawBody);
    if (body === null) {
      return ignored("unparseable_body");
    }

    const sentAt = body?.webhookTimestamp;
    if (
      typeof sentAt !== "number" ||
      !Number.isFinite(sentAt) ||
      Math.abs(Date.now() - sentAt) > WEBHOOK_REPLAY_WINDOW_MS
    ) {
      return {
        kind: "refused",
        status: 401,
        reason: "The delivery timestamp is outside the accepted window.",
      };
    }

    const ticketKey = readString(body?.data?.identifier) ?? readString(body?.data?.issue?.identifier);
    if (!ticketKey) {
      ctx.log.debug(
        { type: readString(body?.type) ?? "", action: readString(body?.action) ?? "" },
        "linear_webhook_no_ticket_key",
      );
      return ignored("no_ticket_key");
    }

    const projectKey = readString(body?.data?.team?.key) ?? readString(body?.data?.issue?.team?.key);
    const watched = ctx.connection.projectKey.trim().toUpperCase();
    if (projectKey && projectKey.toUpperCase() !== watched) {
      ctx.log.debug({ ticketKey, projectKey, watched }, "linear_webhook_wrong_project");
      return ignored("wrong_project", ticketKey);
    }

    const statusChange = readStatusChange(body);
    const status = readString(body?.data?.state?.name) ?? null;
    const statusId = readString(body?.data?.state?.id) ?? readString(body?.data?.stateId) ?? null;

    const event: TrackerTicketEvent = {
      ticketKey,
      status,
      statusId,
      statusChange,
      actor: await whoActed(body, statusChange !== null, ctx),
    };

    ctx.log.info(
      {
        ticketKey,
        type: readString(body?.type) ?? "",
        action: readString(body?.action) ?? "",
        status: event.status,
        statusChanged: statusChange !== null,
        actor: event.actor,
      },
      "linear_webhook_understood",
    );

    return { kind: "ticket_events", events: [event], response: { status: 200 } };
  },
};

/**
 * Determines whether the event was triggered by the bot itself or an external user.
 */
async function whoActed(
  body: any,
  statusChanged: boolean,
  ctx: LinearContext,
): Promise<TrackerTicketEvent["actor"]> {
  const actorAccountId = readString(body?.actor?.id);
  const isIssueUpdate = body?.type === "Issue" && body?.action === "update";
  if (!actorAccountId || !statusChanged || !isIssueUpdate) return "other";
  try {
    const ours = (await adapterFor(ctx).getCurrentUserAccountId()).trim();
    return ours !== "" && ours === actorAccountId ? "self" : "other";
  } catch (error) {
    ctx.log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "linear_webhook_actor_lookup_failed",
    );
    return "unknown";
  }
}

/**
 * Creates an issue tracker adapter instance for the given context.
 */
export function adapterFor(ctx: LinearContext): LinearAdapter {
  return new LinearAdapter({
    apiToken: ctx.connection.apiToken,
    projectKey: ctx.connection.projectKey,
    fetch: ctx.http.fetch,
  });
}

/**
 * Builds an ignored webhook reception result with an optional ticket key.
 */
function ignored(reason: string, ticketKey?: string): IntegrationWebhookReception {
  return {
    kind: "ticket_events",
    events: [],
    response: { status: 200 },
    ignored: { reason, ...(ticketKey ? { ticketKey } : {}) },
  };
}

/**
 * Verifies the Linear webhook delivery signature using HMAC-SHA256.
 */
function verifySignature(
  rawBody: string,
  headers: Readonly<Record<string, string>>,
  ctx: LinearContext,
): IntegrationWebhookReception | null {
  const secret = ctx.connection.webhookSecret;
  if (!secret) {
    return {
      kind: "refused",
      status: 503,
      reason:
        "No Linear webhook secret is configured, so this deployment cannot tell a real delivery from anyone else's. Add the secret here and in the Linear webhook.",
    };
  }

  const signature = headers["linear-signature"];
  if (!signature) {
    return { kind: "refused", status: 401, reason: "The delivery carried no signature." };
  }

  let expected: string;
  try {
    expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  } catch {
    return {
      kind: "refused",
      status: 401,
      reason: "The signature names a hash this deployment cannot compute.",
    };
  }

  const receivedTrimmed = signature.trim();
  const left = Buffer.from(receivedTrimmed, "hex");
  const right = Buffer.from(expected, "hex");

  if (left.length === 0 || left.length !== right.length || !timingSafeEqual(left, right)) {
    return { kind: "refused", status: 401, reason: "The signature did not match." };
  }

  return null;
}

/**
 * Safely parses the webhook body JSON payload.
 */
function parseBody(rawBody: string): any {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

/**
 * Extracts status transition data from an issue update payload.
 */
function readStatusChange(body: any): TrackerTicketEvent["statusChange"] {
  if (body?.type !== "Issue" || body?.action !== "update") return null;

  const updatedFrom = body?.updatedFrom;
  if (!updatedFrom || typeof updatedFrom.stateId !== "string") return null;

  const oldStateId = updatedFrom.stateId;
  const newStateId = readString(body?.data?.state?.id) ?? readString(body?.data?.stateId);
  const newStateName = readString(body?.data?.state?.name);

  if (oldStateId === newStateId) return null;
  if (!newStateId && !newStateName) return null;

  return {
    ...(newStateId ? { id: newStateId } : {}),
    ...(newStateName ? { name: newStateName } : {}),
  };
}

/**
 * Trims and returns a string if non-empty, otherwise returns null.
 */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
