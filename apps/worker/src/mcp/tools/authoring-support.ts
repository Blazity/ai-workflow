import { NoopMessagingAdapter } from "../../adapters/messaging/noop.js";
import type { MessagingAdapter } from "../../adapters/messaging/types.js";
import { logger } from "../../lib/logger.js";
import {
  McpPublicError,
  type McpActorContext,
  type McpToolDependencies,
} from "../contracts.js";

/**
 * The pieces every authoring tool needs around a store write, kept in one place
 * because two of them are security narrowings and a narrowing that exists twice
 * gets fixed once. Deliberately NOT the store error mapping: each store raises
 * its own error class over its own statuses, and folding those into one function
 * would mean one module deciding which of another store's failures wrote nothing.
 */

/** Raised before the store was reached, or by a store refusal that provably wrote
 * nothing, so the idempotency key goes back into circulation: a caller that
 * corrected its arguments must not lose the key for a day over a refusal that
 * changed no state. */
export function refusal(
  code: McpPublicError["code"],
  message: string,
  retryable = false,
): McpPublicError {
  return new McpPublicError(code, message, retryable, undefined, true);
}

/** The stores' role gates take a DashboardRole, whose union has no "service" member
 * while an MCP actor's role does. The policy for every authoring tool admits only
 * admin and owner, so this narrows instead of casting: any other role that ever
 * reaches here is refused rather than handed to a store as an editor.
 *
 * Not exported: every caller wants the whole actor below, and the narrowing is not
 * something a tool should be able to take without the label that goes with it. */
function editorRoleOf(actor: McpActorContext): "admin" | "owner" {
  if (actor.role !== "admin" && actor.role !== "owner") {
    throw refusal("FORBIDDEN", "Access denied");
  }
  return actor.role;
}

/** The written row's own history records the MCP client behind the write, exactly as
 * a dashboard save records the person behind it. */
export function storeActor(actor: McpActorContext) {
  return {
    role: editorRoleOf(actor),
    id: actor.userId ?? actor.subject,
    label: `MCP ${actor.clientId}`,
  };
}

/**
 * The messaging adapter is ticket-scoped: notifyForTicket looks a thread parent up
 * by this key and replies under it, or posts top-level when there is none. An
 * authoring change belongs to no ticket, so it travels under a key that is not a
 * ticket key and that nothing ever anchors a parent to (only a `started` event
 * does, chatsdk.ts:113): every announcement is then its own top-level message
 * instead of a reply buried under some run's status line.
 */
const AUTHORING_SUBJECT_KEY = "mcp-authoring";

/**
 * How long the announcement may hold a reply that is already earned. A chat backend
 * that hangs rather than fails would otherwise keep the handler running until the
 * wrapper's own deadline (MCP_TOOL_TIMEOUT_MS), which answers TIMEOUT and seals the
 * idempotency key with it: a verdict that says "the write may not have happened"
 * about a write that certainly did. So a slow channel gives up its turn.
 *
 * A bound, not a guarantee, and the difference is worth stating: this budget is spent
 * AFTER the store write, so it adds to whatever that write took. A publish that
 * already spent most of MCP_TOOL_TIMEOUT_MS can still cross it while waiting here,
 * and a deployment can still be reported as a timeout. Closing that would mean
 * threading the wrapper's remaining time into the operation, which executeMcpMutation
 * does not currently hand out (it passes a lease id, not a deadline).
 */
const ANNOUNCEMENT_TIMEOUT_MS = 5_000;

/** Long enough for a workflow name or a prompt slug to be recognized, short enough
 *  that a 200-character name cannot push the facts of the announcement off the
 *  readable part of the line. */
const MAX_LABEL_LENGTH = 80;

/**
 * The only shape a caller-supplied name may take inside an announcement. Every
 * label in these messages is text somebody else chose: a workflow name comes
 * straight from workflows.create, whose schema bounds the LENGTH and nothing else
 * (tool-catalog.ts), a pinned repository path may hold anything without whitespace,
 * and the version author label carries whatever the dashboard or an MCP client was
 * called. An agent reading a ticket it does not trust chooses all of them.
 *
 * Slack reads our strings as raw mrkdwn, so `<`, `>` and `|` are the characters
 * that matter: they are what turns text into `<https://attacker.example|Deploy
 * approved>` or an `<@U123>` mention inside the one message an operator is supposed
 * to trust. Newlines matter for the same reason, since a second line can be written
 * to read like a line the platform wrote. So the three characters go, every run of
 * whitespace collapses to one space, and the result is cut to MAX_LABEL_LENGTH.
 *
 * Deliberately NOT in adapters/messaging/format.ts: that module's escaping is
 * scoped to broadcast tokens precisely so the platform's own `<url|label>` links
 * keep working (format.ts:141-142), and the deep links these announcements carry
 * are exactly such links. The distinction is between our own composed text and the
 * labels interpolated into it, which is a distinction only this side knows.
 */
export function announcementLabel(raw: string): string {
  const flattened = raw.replace(/[<>|]/g, "").replace(/\s+/g, " ").trim();
  return flattened.length > MAX_LABEL_LENGTH
    ? `${flattened.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`
    : flattened;
}

/**
 * Whether an authoring announcement can actually reach anybody on this deployment.
 * Reported by system.capabilities, because a client is entitled to know when it is
 * unobserved: with no chat credentials configured lib/adapters.ts hands every tool
 * the no-op adapter, and the announcement then goes nowhere. The audit row is
 * written either way, which is what keeps "none" an honest answer rather than a
 * confession that nothing is recorded.
 *
 * Asked of the adapter instance rather than re-derived from the env, so it cannot
 * drift from the condition createAdapters actually branches on. A deps object built
 * by a test with no messaging at all answers "none" for the same reason.
 */
export function authoringAnnouncementDelivery(
  messaging: MessagingAdapter | undefined,
): "chat" | "none" {
  if (!messaging || messaging instanceof NoopMessagingAdapter) return "none";
  return "chat";
}

/**
 * Tells the operators' channel that an authoring write landed. The audit row
 * records that a call happened and hashes what it carried, which answers a
 * question only somebody already looking can ask; this is the half that reaches a
 * person who is not looking, and it is why an admin token driven by ticket text
 * cannot rewrite what future runs are told with nobody the wiser.
 *
 * `what` must name the row and the versions and NOTHING of the content written:
 * this message goes to a channel with a longer memory than the audit table, and a
 * prompt body or a graph belongs in neither.
 *
 * Every caller-supplied label inside `what` must already have been through
 * announcementLabel above. The adapter's note branch defangs broadcast tokens in
 * the whole string (format.ts:161), which stops a channel-wide ping and NOTHING
 * else: it leaves `<url|label>`, `<@user>` and newlines intact, so an unsanitized
 * name can forge a clickable link or a second line inside this message. That is
 * enforced at the interpolation sites rather than here, because the deep links the
 * callers compose are legitimate `<url|label>` and must survive.
 *
 * Best-effort in both directions a notification can go wrong, because the write has
 * ALREADY happened when this runs and neither failure may change what the tool
 * answers: a rejection is logged and swallowed, and a send that has not finished
 * inside ANNOUNCEMENT_TIMEOUT_MS is left to finish on its own. The catch is
 * attached to the send rather than wrapped around the await, so a rejection
 * arriving after this function returned is still handled and cannot surface as an
 * unhandled rejection. notifyForTicket promises never to throw; a promise is not
 * what a write this consequential should rest on, so the guarantee is enforced here
 * as well as documented there.
 *
 * Awaited rather than left dangling: this platform runs on serverless functions
 * that may be frozen the moment a handler returns, and a dangling send is a
 * notification an operator never gets.
 */
export async function announceAuthoringChange(
  deps: McpToolDependencies,
  what: string,
): Promise<void> {
  // The actor's own identifiers go through the same sanitizer as everything else:
  // they come off a registered OAuth client and a token subject, so they are not
  // this server's own text either.
  const who = `MCP client ${announcementLabel(deps.actor.clientId)} (${announcementLabel(
    deps.actor.subject,
  )})`;
  const context = {
    clientId: deps.actor.clientId,
    actorSubject: deps.actor.subject,
    requestId: deps.requestId,
  };
  // Wrapped in an async function, so an adapter that throws where it should have
  // rejected still arrives at the catch below rather than escaping into the tool as
  // the failure of a write that succeeded.
  const send = async (): Promise<void> => {
    await deps.adapters.messaging.notifyForTicket(AUTHORING_SUBJECT_KEY, {
      kind: "note",
      text: `:memo: ${who} ${what}`,
    });
  };
  const sent = send().catch((error: unknown) => {
    logger.warn(
      { ...context, err: error instanceof Error ? error.message : String(error) },
      "mcp_authoring_notification_failed",
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(context, "mcp_authoring_notification_slow");
      resolve();
    }, ANNOUNCEMENT_TIMEOUT_MS);
  });
  await Promise.race([sent, deadline]);
  clearTimeout(timer);
}
