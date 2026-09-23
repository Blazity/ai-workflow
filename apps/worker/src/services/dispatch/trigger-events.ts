import type { TriggerEvent } from "@shared/contracts";

export type { TriggerEvent } from "@shared/contracts";

/**
 * What core still knows about a trigger event, now that no provider's
 * vocabulary lives here.
 *
 * Turning a provider's delivery into a `TriggerEvent` belongs to that
 * provider's integration (`integrations/<id>/webhook.ts`), which is why the
 * normalizers that used to sit in this file are gone. What is left is the two
 * questions core answers about an event it has already been handed.
 */

/**
 * Preserve trust for delivery envelopes recorded before the explicit bit
 * existed.
 *
 * These two producer names are read off rows already in the database, never
 * written: an envelope stored before `trustedByDefault` was part of the
 * contract carries no bit, and re-deciding it from nothing would either start
 * runs that could not start before or stop runs that could. New envelopes carry
 * the bit their integration set, webhook and manual dispatch alike (the
 * snapshot carries it per failed check), so this answers only for the old ones
 * and the set can never grow.
 */
export function isLegacyTrustedCheckDelivery(
  delivery: Pick<TriggerEvent["delivery"], "producer" | "source">,
): boolean {
  return (
    delivery.producer === "github-actions" ||
    delivery.source === "merge_request_event"
  );
}
