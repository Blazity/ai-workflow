import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  IntegrationContext,
  IntegrationWebhook,
  IntegrationWebhookReception,
  TrackerTicketEvent,
} from "@integrations/sdk";
import { JiraAdapter } from "./issue-tracker";
import type { manifest } from "./manifest";

type JiraContext = IntegrationContext<typeof manifest>;

/**
 * What a Jira delivery is, from raw bytes to something core can act on.
 *
 * This half owns Jira and nothing else: the signature over the exact bytes,
 * where a ticket key and a status live in Jira's own envelope, which project
 * this connection watches, and whether the account that acted is this
 * deployment's own. It decides nothing about runs. What a ticket entering a
 * column means, which run owns it, whether a question is waiting on a comment
 * and what cancelling does are core's, and they are the same for the next
 * issue tracker.
 *
 * Until S12 this file's ancestor did all of it: 792 lines that verified an
 * HMAC and then dispatched, resumed and cancelled runs directly. The behaviour
 * that mattered is pinned by recorded deliveries in
 * `apps/worker/src/routes/webhooks/jira-ticket-webhook.characterisation.test.ts`,
 * which passed against that code unedited and passes against this.
 */
export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => {
    const refusal = verifySignature(request.rawBody, request.headers, ctx);
    if (refusal) return refusal;

    const body = parseBody(request.rawBody);
    if (body === null) {
      return ignored("unparseable_body");
    }

    const ticketKey = readString(body?.issue?.key);
    if (!ticketKey) {
      ctx.log.debug(
        { webhookEvent: readString(body?.webhookEvent) ?? "" },
        "jira_webhook_no_ticket_key",
      );
      return ignored("no_ticket_key");
    }

    const projectKey = readString(body?.issue?.fields?.project?.key);
    const watched = ctx.connection.projectKey.trim().toUpperCase();
    if (projectKey && projectKey.toUpperCase() !== watched) {
      ctx.log.debug({ ticketKey, projectKey, watched }, "jira_webhook_wrong_project");
      return ignored("wrong_project", ticketKey);
    }

    const statusChange = readStatusChange(body);
    const event: TrackerTicketEvent = {
      ticketKey,
      status: readString(body?.issue?.fields?.status?.name) ?? null,
      statusId: readString(body?.issue?.fields?.status?.id) ?? null,
      statusChange,
      actor: await whoActed(body, statusChange !== null, ctx),
    };
    ctx.log.info(
      {
        ticketKey,
        webhookEvent: readString(body?.webhookEvent) ?? "",
        status: event.status,
        statusChanged: statusChange !== null,
        actor: event.actor,
      },
      "jira_webhook_understood",
    );
    return { kind: "ticket_events", events: [event], response: { status: 200 } };
  },
};

/**
 * Who moved the ticket, in the only terms core can act on.
 *
 * The product moves tickets itself: finishing a run sends the ticket to AI
 * Review, failing one sends it to the backlog, parking for a question or a
 * plan sends it to the backlog too. Every one of those fires this webhook, and
 * the only thing separating that echo from a person dragging the ticket out is
 * whether the account that acted is ours.
 *
 * It is asked only where it can change an answer: a real status change, made
 * by a named account, on an issue update. A delivery about a comment or a
 * label moves nothing, so buying a request to ask "was that me" would be a
 * round trip on the provider's clock for an answer nobody reads.
 *
 * A tracker that cannot be asked yields `unknown` rather than a guess. The
 * usual cause is a token without permission to read its own account, and the
 * cost of guessing "it was a person" silently is the product cancelling its
 * own runs the moment it finishes them.
 */
async function whoActed(
  body: any,
  statusChanged: boolean,
  ctx: JiraContext,
): Promise<TrackerTicketEvent["actor"]> {
  const actorAccountId = readString(body?.user?.accountId);
  const isIssueUpdate = readString(body?.webhookEvent) === "jira:issue_updated";
  if (!actorAccountId || !statusChanged || !isIssueUpdate) return "other";
  try {
    const ours = (await adapterFor(ctx).getCurrentUserAccountId()).trim();
    return ours !== "" && ours === actorAccountId ? "self" : "other";
  } catch (error) {
    ctx.log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "jira_webhook_actor_lookup_failed",
    );
    return "unknown";
  }
}

export function adapterFor(ctx: JiraContext): JiraAdapter {
  return new JiraAdapter({
    baseUrl: ctx.connection.baseUrl,
    apiToken: ctx.connection.apiToken,
    projectKey: ctx.connection.projectKey,
    fetch: ctx.http.fetch,
  });
}

function ignored(reason: string, ticketKey?: string): IntegrationWebhookReception {
  return {
    kind: "ticket_events",
    events: [],
    response: { status: 200 },
    ignored: { reason, ...(ticketKey ? { ticketKey } : {}) },
  };
}

/**
 * The HMAC Jira signs the body with, over the exact bytes it sent.
 *
 * KNOWN DEFECT, carried across the S12 rewrite unchanged and deliberately: the
 * documented scheme is HMAC-SHA256, but the hash algorithm below comes from
 * the signature header the SENDER supplied. Correcting it changes who is
 * authenticated, which is a security fix with its own ticket rather than
 * something a refactor may slip in while nobody is comparing behaviour.
 */
function verifySignature(
  rawBody: string,
  headers: Readonly<Record<string, string>>,
  ctx: JiraContext,
): IntegrationWebhookReception | null {
  const secret = ctx.connection.webhookSecret;
  if (!secret) {
    return {
      kind: "refused",
      status: 503,
      // An operator reads this on the health screen beside the delivery that
      // was turned away, so it says what to do rather than what went wrong.
      reason:
        "No Jira webhook secret is configured, so this deployment cannot tell a real delivery from anyone else's. Add the secret here and in the Jira webhook.",
    };
  }
  const header = headers["x-hub-signature"];
  if (!header) {
    return { kind: "refused", status: 401, reason: "The delivery carried no signature." };
  }
  const [method, received] = header.split("=", 2);
  if (!method || !received) {
    return { kind: "refused", status: 401, reason: "The signature header is malformed." };
  }
  let expected: string;
  try {
    expected = createHmac(method, secret).update(rawBody, "utf8").digest("hex");
  } catch {
    return {
      kind: "refused",
      status: 401,
      reason: "The signature names a hash this deployment cannot compute.",
    };
  }
  const left = Buffer.from(received, "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { kind: "refused", status: 401, reason: "The signature did not match." };
  }
  return null;
}

/** Jira posts JSON. An empty body is its keepalive and means "no issue". */
function parseBody(rawBody: string): any {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

/**
 * The status change THIS delivery carried.
 *
 * The issue envelope says where the ticket is now, which is equally true of a
 * delivery about a comment or a label. Only a changelog entry for the status
 * field is evidence that somebody moved it, and moving it is the gesture core
 * acts on.
 */
function readStatusChange(body: any): TrackerTicketEvent["statusChange"] {
  const items = Array.isArray(body?.changelog?.items) ? body.changelog.items : [];
  const change = items.find(
    (item: any) => typeof item?.field === "string" && item.field.toLowerCase() === "status",
  );
  if (!change) return null;
  const id = change.to == null ? "" : String(change.to).trim();
  const name = typeof change.toString === "string" ? change.toString.trim() : "";
  if (!id && !name) return null;
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
