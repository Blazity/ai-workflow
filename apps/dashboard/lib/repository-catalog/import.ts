// apps/dashboard/lib/repository-catalog/import.ts
//
// The import dialog's arithmetic and its copy.
//
// Three buckets come back and an admin reads all three differently: rows that
// were created, keys this installation's listing did not contain (removed at
// the provider, or invisible to the configured token: a stale screen, reload
// it), and keys the catalog already held (a no-op worth confirming). Folding
// any two of them together is how an import reports "8 of 10 added" and leaves
// nobody able to say which two, or why.
import type {
  RepositoryCatalogImportCandidate,
  RepositoryCatalogImportResponse,
  RepositoryProviderStatus,
} from "@shared/contracts";
import { REPOSITORY_IMPORT_SKIPPED_NOTE } from "@shared/contracts";

/** Said beside a candidate the catalog already holds, ticked off and disabled.
 *  Quoted from the brief, because the point of the sentence is that importing
 *  is not granting and the switch is elsewhere. */
export const ALREADY_IN_CATALOG_NOTE =
  "already in the catalog, importing does not enable it; use the switch";

/** Said above the tick boxes, because `enabled` is one decision for the whole
 *  selection: the worker takes a single flag, and a per-row switch here would
 *  be a second, quieter way to grant access beside the audited one. */
export const IMPORT_ENABLED_NOTE =
  "One choice for the whole selection. Leave it off to add the repositories without letting the agent touch them yet.";

/** The provider directory failed. An empty list must never be presented as
 *  "nothing to import": a missing token and an empty installation are different
 *  facts and only one of them is the admin's to fix. */
export const PROVIDER_FAILED_NOTE =
  "The provider directory could not be listed, so this is not a complete picture of what exists. Nothing was imported. Retry, or fix the provider connection on the System health page.";

export const PROVIDER_UNAVAILABLE_NOTE =
  "A provider could not be listed, so nothing was imported. Retry once the provider answers; no repository was created by this attempt.";

/** Candidates an admin may actually tick: everything the catalog does not
 *  already hold. Archived repositories stay listed but are not offered, the way
 *  the editor's picker has always treated them. */
export function selectableCandidates(
  candidates: readonly RepositoryCatalogImportCandidate[],
): RepositoryCatalogImportCandidate[] {
  return candidates.filter(
    (candidate) => !candidate.inCatalog && !candidate.archived,
  );
}

/** Providers that answered with something other than a listing. Surfaced rather
 *  than swallowed: this is exactly the case where a repository is missing from
 *  the list for a reason that has nothing to do with the installation. */
export function problemProviders(
  providers: readonly RepositoryProviderStatus[],
): RepositoryProviderStatus[] {
  return providers.filter((provider) => provider.status !== "ready");
}

export function providerStatusLabel(status: RepositoryProviderStatus): string {
  if (status.status === "not_connected") return "not connected";
  if (status.status === "error") return status.error ?? "could not list repositories";
  return "ready";
}

function repositories(n: number): string {
  return `${n} ${n === 1 ? "repository" : "repositories"}`;
}

/**
 * The summary line after a commit, naming all three buckets every time.
 *
 * Even the zeroes: "0 already in the catalog" is what tells an admin the check
 * ran, and leaving a bucket out when it is empty is how a screen teaches people
 * that the missing number means something.
 *
 * The skipped bucket is named in three words here and explained in full on its
 * detail row below. A one-line summary that carries both causes of a skip reads
 * as a paragraph the moment a repository is skipped, which is exactly when the
 * two numbers before it need to stay legible.
 */
export function importSummary(result: RepositoryCatalogImportResponse): string {
  return [
    `${repositories(result.imported)} added`,
    `${result.alreadyPresent.length} already in the catalog`,
    `${result.skipped.length} not in the listing`,
  ].join(", ");
}

/** The follow-up sentence for each non-empty bucket, so the keys are readable
 *  rather than only counted. */
export function importDetails(
  result: RepositoryCatalogImportResponse,
): { label: string; keys: string[] }[] {
  const details: { label: string; keys: string[] }[] = [];
  if (result.alreadyPresent.length > 0) {
    details.push({
      label: "Already in the catalog, so nothing was created and nothing was enabled",
      keys: [...result.alreadyPresent],
    });
  }
  if (result.skipped.length > 0) {
    details.push({
      // Two causes, one bucket: the listing cannot tell a repository deleted
      // at the provider from one the configured token cannot see, and a screen
      // that claimed only the first sent people looking for a deletion that
      // never happened.
      label: `Skipped: ${REPOSITORY_IMPORT_SKIPPED_NOTE}. Reload the list before importing again`,
      keys: [...result.skipped],
    });
  }
  return details;
}

/** A 503 from the commit means a provider could not be listed at all and
 *  NOTHING was inserted, which is the one failure that must not read as a
 *  partial import. */
export function isProviderUnavailable(input: {
  status: number;
  message: string;
}): boolean {
  return input.status === 503 && input.message.includes("provider_unavailable");
}
