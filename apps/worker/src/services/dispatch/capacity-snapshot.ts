/**
 * Dispatch-capacity snapshot for the Overview.
 *
 * occupiedSlots is counted through the exact helper the refusal path counts
 * against (listCapacityConsumers, so parked claims and fresh reservations are
 * included): a full pool with zero executing runs must read as full, not idle.
 * queued is the at-capacity waiting list written by the poll.
 */
import type { DispatchCapacityResponse, SettingsSnapshot } from "@shared/contracts";
import { listConnectedQueuedDispatchTickets } from "../../db/repositories/dispatch-capacity-queue.js";
import { maxConcurrentAgents } from "../settings/index.js";
import { createAdapters } from "../../engine/support/adapters.js";
import { capacityConsumerCount } from "./dispatch.js";

export async function readDispatchCapacity(
  settings: SettingsSnapshot,
): Promise<DispatchCapacityResponse> {
  const adapters = createAdapters();
  const [occupiedSlots, queued] = await Promise.all([
    capacityConsumerCount(adapters.runRegistry),
    listConnectedQueuedDispatchTickets(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    occupiedSlots,
    maxSlots: maxConcurrentAgents(settings),
    queued: queued.map((row) => ({
      ticketKey: row.ticketKey,
      queuedAt: row.queuedAt.toISOString(),
    })),
  };
}
