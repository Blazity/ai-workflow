/**
 * Which conversation a ticket's messages belong to.
 *
 * One row per ticket in `thread_parents`, holding whatever the provider called
 * the message it anchored on. Core never reads the value: it is an opaque
 * handle, which is why a second messaging provider needs no table and no
 * migration, and why the rows written before any of this existed (a Slack
 * message timestamp) are still exactly what their provider expects.
 *
 * It is keyed by ticket rather than by run on purpose: a ticket that is run
 * twice keeps one thread, which is what the channel shows and what the slash
 * command clears.
 *
 * A provider that no longer recognises a handle forgets it and anchors a new
 * one, so a deployment that switched providers heals itself at the first
 * event rather than at a migration.
 */
import type { MessagingConversation } from "@integrations/sdk";

export async function conversationFor(ticketKey: string): Promise<MessagingConversation> {
  const { createConnectedPostgresRunRegistry } = await import(
    "../../db/repositories/active-runs.js"
  );
  const { logger } = await import("../../infra/logger.js");
  const store = createConnectedPostgresRunRegistry();
  // Read once, before the provider is asked for anything: a lookup that fails
  // means "no conversation yet", which anchors a new one, and that is better
  // than an event nobody sees.
  const handle = await store.getParent(ticketKey).catch((error: unknown) => {
    logger.warn(
      { ticketKey, error: (error as Error).message },
      "messaging_conversation_lookup_failed",
    );
    return null;
  });
  return {
    handle,
    async remember(next: string) {
      await store.setParent(ticketKey, next).catch((error: unknown) =>
        logger.warn(
          { ticketKey, error: (error as Error).message },
          "messaging_conversation_persist_failed",
        ),
      );
    },
    async forget() {
      await store.clearParent(ticketKey).catch(() => {});
    },
  };
}
