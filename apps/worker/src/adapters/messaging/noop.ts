import { logger } from "../../lib/logger.js";
import type { MessagingAdapter, TicketEvent } from "./types.js";

/**
 * Used when Slack credentials aren't configured. Swallows all events so the
 * workflow can run end-to-end without a messaging integration.
 */
export class NoopMessagingAdapter implements MessagingAdapter {
  async notifyForTicket(ticketKey: string, event: TicketEvent): Promise<void> {
    // warn, not debug: the default level is info (lib/logger.ts), so a debug line
    // produced no output at all, and some of what is dropped here is the only
    // outbound record of an event a person was meant to see (an MCP authoring
    // announcement, a failed run). A swallowed notification is worth one line an
    // operator can find.
    logger.warn(
      { ticketKey, kind: event.kind },
      "messaging disabled, skipping notification",
    );
  }
}
