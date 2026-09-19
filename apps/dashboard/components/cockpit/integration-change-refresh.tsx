"use client";

import { useIntegrationChangeRefresh } from "@/lib/integrations/change-signal";

/**
 * Keeps a screen's idea of the integrations current, for the screens that are
 * rendered on the server and so cannot hold the listener themselves.
 *
 * Two screens need it for different reasons and the reason is the same fact.
 * The workflow editor's palette and canvas warnings are pure functions of the
 * block registry the server rendered with, so an author whose colleague reached
 * for a kill switch would keep blocks that can no longer run. The Integrations
 * list is a snapshot of every status, so an admin whose colleague disconnected
 * something would keep reading Connected next to a Manage link that opens a
 * screen offering to disconnect what is already gone.
 */
export function IntegrationChangeRefresh() {
  useIntegrationChangeRefresh();
  return null;
}
