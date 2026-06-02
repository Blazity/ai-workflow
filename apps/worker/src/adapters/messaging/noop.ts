import { logger } from "../../lib/logger.js";
import type { MessagingAdapter, TicketEvent } from "./types.js";

/**
 * Used when Slack credentials aren't configured. Swallows all events so the
 * workflow can run end-to-end without a messaging integration.
 */
export class NoopMessagingAdapter implements MessagingAdapter {
  async notifyForTicket(ticketKey: string, event: TicketEvent): Promise<void> {
    logger.debug({ ticketKey, kind: event.kind }, "messaging disabled — skipping notification");
  }
}
