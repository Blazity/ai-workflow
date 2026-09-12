/**
 * One settings snapshot per HTTP request, loaded once and shared.
 *
 * A request is an entry point, and the rule for an entry point is that it reads
 * the store once and hands the result down synchronously. A route rarely calls
 * one service though: the actor guard needs the organization, the handler needs
 * a limit, and a service below both needs a third key. Without memoisation each
 * of those would be its own round trip, and worse, two of them could disagree
 * when an operator saves the Settings page between them. So the load is keyed on
 * the event: whoever asks first pays for it, everybody else in the same request
 * gets the same immutable object.
 *
 * The promise is what is stored, not the resolved value, so two reads that start
 * before the first finishes still share one query rather than racing into two.
 */
import type { H3Event } from "h3";
import type { SettingsSnapshot } from "@shared/contracts";
import { loadSettingsSnapshot } from "./snapshot.js";

/** Where the per-request snapshot lives on the event. */
type SnapshotCarrier = { settingsSnapshot?: Promise<SettingsSnapshot> };

/** The deployment's settings as this request sees them. One load per request. */
export function getRequestSettingsSnapshot(event: H3Event): Promise<SettingsSnapshot> {
  const carrier = event.context as SnapshotCarrier;
  carrier.settingsSnapshot ??= loadSettingsSnapshot();
  return carrier.settingsSnapshot;
}
