import type { RunRepositoryAccess } from "@shared/contracts";

/** Beyond this many keys the line says how many are not shown instead of
 *  growing until it wraps the header. */
const SHOWN_KEYS = 5;

/**
 * The one line the run header gives to "could this run have reached that
 * repository?".
 *
 * It is the list the run FROZE at start, not the catalog as it stands now: a
 * repository switched off an hour after the run began still contributed its
 * rules and could still be cloned, and a repository switched on afterwards
 * could not. Answering from today's catalog is the mistake this line exists to
 * prevent, so it never reads the catalog at all.
 *
 * `null` for a run that started before the list was recorded. That is not an
 * empty list and must not render as one: the header shows nothing rather than
 * claim the run reached nothing.
 */
export function repositoryAccessLine(
  access: RunRepositoryAccess | null | undefined,
): string | null {
  if (!access) return null;
  if (!access.activated) {
    return (
      "Repository access frozen at start: bridge, nobody had activated the " +
      "catalog, so every repository the installation exposes was reachable."
    );
  }
  const keys = access.enabledKeys;
  if (keys.length === 0) {
    return "Repository access frozen at start: 0 enabled, no repository was reachable.";
  }
  const shown = keys.slice(0, SHOWN_KEYS).join(", ");
  const rest = keys.length - SHOWN_KEYS;
  return `Repository access frozen at start: ${keys.length} enabled (${shown}${
    rest > 0 ? `, and ${rest} more` : ""
  }).`;
}
