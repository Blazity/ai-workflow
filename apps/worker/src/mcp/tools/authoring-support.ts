import { McpPublicError, type McpActorContext } from "../contracts.js";

/**
 * The three pieces every authoring tool needs before it may touch a store, kept in
 * one place because two of them are security narrowings and a narrowing that exists
 * twice gets fixed once. Deliberately NOT the store error mapping: each store raises
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
