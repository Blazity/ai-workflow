import type { TriggerEvent } from "@shared/contracts";
import { isManagedGateCheckName } from "../../engine/support/workflow-naming.js";

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
 * the bit their integration set, so this answers only for the old ones and the
 * set can never grow.
 */
export function isLegacyTrustedCheckDelivery(
  delivery: Pick<TriggerEvent["delivery"], "producer" | "source">,
): boolean {
  return (
    delivery.producer === "github-actions" ||
    delivery.source === "merge_request_event"
  );
}

/**
 * Whether a check name is one the post-PR gate created itself.
 *
 * Provider neutral: a name this deployment configured for a gate step, or one
 * carrying a managed prefix. Acting on our own check would make the gate chase
 * its own tail.
 */
export function isGateCheckName(
  name: string,
  gateCheckNames: readonly string[],
): boolean {
  if (typeof name !== "string") return false;
  if (gateCheckNames.includes(name)) return true;
  return isManagedGateCheckName(name);
}
