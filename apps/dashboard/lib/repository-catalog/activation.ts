// apps/dashboard/lib/repository-catalog/activation.ts
//
// What the activation dialog has to say before anyone confirms.
//
// Activation is the moment dispatch stops selecting repositories the catalog
// does not enable. Two different populations matter and the dialog states both:
// how many repositories stop passing at all, and which of those have work in
// flight right now. Showing only the second (the worker's 409 list) would let
// an admin end the bridge believing three repositories are affected when the
// number is ninety.
import type {
  RepositoryCatalogClaimedRepository,
  RepositoryCatalogEntry,
  RepositoryCatalogState,
  RepositoryOption,
} from "@shared/contracts";
import { repositoryCatalogKey } from "@shared/contracts";

import { formatDateTime } from "./format";

export interface ActivationImpact {
  /** Rows that will stop passing: everything the catalog does not enable. */
  stopping: RepositoryCatalogEntry[];
  /** Rows that keep passing. */
  keeping: RepositoryCatalogEntry[];
  /**
   * Repositories the installation exposes that the catalog does not hold at
   * all.
   *
   * These stop passing too, and no catalog row can warn about them: after
   * activation the worker selects enabled catalog rows, so "not in the catalog"
   * and "in the catalog and not enabled" have exactly the same effect. A dialog
   * that counted only the rows would tell an admin with an empty catalog that
   * activating changes nothing.
   */
  uncatalogued: { provider: string; path: string }[];
  /** True when the provider directory could not be read, so `uncatalogued` is
   *  "not known", never "none". */
  directoryUnknown: boolean;
  /** Of the stopping rows, the ones the worker reported as holding a run claim.
   *  Approximate by construction: no table ties a workflow-owned branch to the
   *  run that created it, so this is "repositories with branches on tickets
   *  that currently hold a claim". */
  claimed: RepositoryCatalogClaimedRepository[];
}

export function activationImpact(input: {
  repositories: readonly RepositoryCatalogEntry[];
  claimed: readonly RepositoryCatalogClaimedRepository[];
  /** The provider directory, or null when it could not be read. */
  directory: readonly RepositoryOption[] | null;
}): ActivationImpact {
  const held = new Set(
    input.repositories.map((repository) => repositoryCatalogKey(repository)),
  );
  const uncatalogued: { provider: string; path: string }[] = [];
  for (const option of input.directory ?? []) {
    const key = repositoryCatalogKey({
      provider: option.provider,
      path: option.repoPath,
    });
    if (held.has(key)) continue;
    uncatalogued.push({ provider: option.provider, path: option.repoPath });
  }
  return {
    stopping: input.repositories.filter((repository) => !repository.enabled),
    keeping: input.repositories.filter((repository) => repository.enabled),
    uncatalogued,
    directoryUnknown: input.directory === null,
    claimed: [...input.claimed],
  };
}

/** How many names a "and N more" list shows before it stops. Ten is enough to
 *  recognise the fleet and short enough to read before clicking. */
const NAME_CAP = 10;

/** The uncatalogued population, named. Capped, because an installation with 300
 *  repositories would otherwise bury the confirm button under the warning. */
export function uncataloguedSummary(impact: ActivationImpact): string {
  if (impact.directoryUnknown) {
    return "The provider directory could not be read, so how many repositories the installation exposes outside this catalog is not known. Those repositories stop passing too.";
  }
  if (impact.uncatalogued.length === 0) {
    return "Every repository the installation exposes is already in this catalog.";
  }
  const names = impact.uncatalogued
    .slice(0, NAME_CAP)
    .map((repository) => `${repository.provider}:${repository.path}`)
    .join(", ");
  const rest = impact.uncatalogued.length - NAME_CAP;
  return `${repositories(
    impact.uncatalogued.length,
  )} the installation exposes are not in the catalog and stop passing: ${names}${
    rest > 0 ? `, and ${rest} more` : ""
  }.`;
}

/**
 * Why activation must not be offered at all, or null.
 *
 * A catalog with nothing enabled is the one case where confirming is never the
 * right answer: dispatch would stop selecting every repository at once, and the
 * repair (enable a row) is one click away on the same screen.
 */
export function activationBlocker(impact: ActivationImpact): string | null {
  if (impact.keeping.length === 0) {
    return "no repository in this catalog is enabled, so activating would stop dispatch selecting every repository at once; enable at least one first";
  }
  return null;
}

/** "1 repository" / "3 repositories", so a dialog about ending a grant never
 *  reads like a template that did not run. */
function repositories(n: number): string {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}

/**
 * The headline, both populations in one sentence.
 *
 * Written for the case the brief calls out: the number that matters is how many
 * rows stop passing, and the claimed list is a subset of it, not the whole
 * story.
 */
export function activationSummary(impact: ActivationImpact): string {
  const keeping = repositories(impact.keeping.length);
  const stays = impact.keeping.length === 1 ? "stays" : "stay";
  // The population that stops is the rows this catalog does not enable PLUS
  // everything the installation exposes that the catalog never held: after
  // activation the worker selects enabled rows and nothing else, so both are
  // the same refusal and counting only the first understates it.
  const stopping = impact.stopping.length + impact.uncatalogued.length;
  if (stopping === 0 && !impact.directoryUnknown) {
    return `Every repository the installation exposes is in this catalog and enabled (${keeping}), so activating changes nothing about what the agent may touch today.`;
  }
  return `Activating stops dispatch selecting ${repositories(
    stopping,
  )} this catalog does not enable; ${keeping} ${stays} selectable. Until the catalog is activated the agent sees everything the installation sees.`;
}

/** The second sentence, about work in flight. Empty list gets its own wording:
 *  "none" has to be stated, or an admin cannot tell "nothing is running" from
 *  "nobody looked". */
export function claimedSummary(impact: ActivationImpact): string {
  if (impact.claimed.length === 0) {
    return "No repository that stops passing currently holds a run claim.";
  }
  return `${repositories(impact.claimed.length)} that stop passing currently hold a run claim. The next dispatch will stop selecting them; a run already inside one is not cancelled by this.`;
}

/** One claimed row, with the tickets and runs it was found through, so the
 *  admin can check rather than trust. */
export function claimedDetail(entry: RepositoryCatalogClaimedRepository): string {
  const tickets = entry.ticketKeys.length > 0 ? entry.ticketKeys.join(", ") : "no ticket";
  const runs = entry.runIds.length > 0 ? entry.runIds.join(", ") : "no run id";
  return `${tickets} · ${runs}`;
}

/** What goes back on the second request. The worker refuses an activation whose
 *  acknowledged list does not cover the claims it can see right now, so the
 *  dialog echoes exactly the keys it rendered. */
export function acknowledgedKeys(
  impact: ActivationImpact,
): string[] {
  return impact.claimed.map((entry) => entry.key);
}

/** The banner on the list while the bridge is on. Quoted from the brief. */
export const NOT_ACTIVATED_BANNER =
  "Catalog not activated: the agent sees everything the installation sees";

/** The reason is NOT sent: `repositoryCatalogActivateRequestSchema` is
 *  `.strict()` and carries only the acknowledged keys, so the field is a
 *  deliberate pause and nothing more. The copy says exactly that rather than
 *  promising an audit entry nobody writes. */
export const ACTIVATION_REASON_NOTE =
  "Your name and the time are recorded. The reason is not: it stays on this screen, as the pause before you end the bridge for everyone.";

export const ACTIVATION_REASON_MISSING = "a reason is required";

/** The dialog's stale-list refusal, the 409's own wording for a screen. */
export function staleActivationNotice(
  claimed: readonly RepositoryCatalogClaimedRepository[],
): string {
  return `The list moved while the dialog was open: ${repositories(
    claimed.length,
  )} now hold a run claim and are not enabled. Read the list again before confirming.`;
}

// ── Activation as a status line ─────────────────────────────────────────────
//
// Read from the catalog state row the worker returns, never from the
// `catalog.activated` settings key. Nothing writes that key: a deployment whose
// seed activated the catalog still resolved it to the default and told every
// reader the catalog was off, which is the worst direction for this particular
// lie to point.

/** Whether the catalog decides access, as a chip reads it. Null state is a
 *  worker that did not answer, which is not the same as "off". */
export function activationValue(
  state: RepositoryCatalogState | null,
): "Activated" | "Not activated" | "Unknown" {
  if (state === null) return "Unknown";
  return state.activated ? "Activated" : "Not activated";
}

/** Who activated the catalog and when, or the empty string when the state says
 *  neither (the bridge, or an activation recorded without an actor). */
function activatedByLine(state: RepositoryCatalogState | null): string {
  if (state === null || !state.activated) return "";
  const who = state.activatedByLabel;
  const when = state.activatedAt === null ? null : formatDateTime(state.activatedAt);
  if (who === null && when === null) return "";
  return `Activated${who === null ? "" : ` by ${who}`}${when === null ? "" : ` on ${when}`}.`;
}

/** The sentence under the chip: what activation means here, plus who ended the
 *  bridge, plus where the action lives when it has not been ended yet. */
export function activationDetail(state: RepositoryCatalogState | null): string {
  if (state === null) {
    return "The worker did not answer the catalog read, so activation cannot be shown here.";
  }
  if (!state.activated) {
    return "The agent sees everything the installation sees. Activate the catalog on the Repositories page.";
  }
  const by = activatedByLine(state);
  return by === ""
    ? "Only repositories enabled in the catalog are selected."
    : `Only repositories enabled in the catalog are selected. ${by}`;
}
