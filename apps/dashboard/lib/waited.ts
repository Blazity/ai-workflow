/**
 * Compact "how long it has been waiting" label from an ISO timestamp. Computed
 * on the client from a first-seen instant, so `now` is injectable for tests.
 */
export function formatWaited(fromIso: string, now: number = Date.now()): string {
  const ms = now - new Date(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
