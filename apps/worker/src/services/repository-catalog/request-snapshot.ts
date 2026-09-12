/**
 * One repository catalog snapshot per HTTP request, loaded once and shared.
 *
 * The same rule the settings snapshot follows, for the same reason: the store is
 * asynchronous and the predicate that decides "may this repository be
 * dispatched" is not, so an entry point reads the catalog once and hands the
 * result down synchronously. A request rarely asks once: a webhook delivery can
 * evaluate several candidate events and then fall through to the legacy gate,
 * and two reads that disagreed because an operator enabled a repository between
 * them would refuse one event and accept its sibling.
 *
 * The promise is what is stored, not the resolved value, so two reads that start
 * before the first finishes still share one query rather than racing into two.
 */
import type { H3Event } from "h3";
import {
  loadRepositoryCatalogSnapshot,
  type RepositoryCatalogSnapshot,
} from "./store.js";

/** Where the per-request snapshot lives on the event. */
type SnapshotCarrier = {
  repositoryCatalogSnapshot?: Promise<RepositoryCatalogSnapshot>;
};

/** The deployment's repository catalog as this request sees it. One load per
 *  request. */
export function getRequestRepositoryCatalogSnapshot(
  event: H3Event,
): Promise<RepositoryCatalogSnapshot> {
  const carrier = event.context as SnapshotCarrier;
  carrier.repositoryCatalogSnapshot ??= loadRepositoryCatalogSnapshot();
  return carrier.repositoryCatalogSnapshot;
}
