/**
 * What ending the bridge would change, as one read.
 *
 * The dashboard assembles this from three answers: the catalog list, the
 * provider directory it reads itself, and the 409 body the activate route hands
 * back when nothing is acknowledged yet. A surface with no dialog cannot POST a
 * write to find out what a write would do, so the same two catalog-side
 * populations are read here without touching activation at all.
 *
 * WHICH MAKES THIS A SECOND DERIVATION OF ONE FACT, and the two have to move
 * together. The dialog's populations come from that 409 body
 * (`routes/api/v1/repository-catalog/activate.post.ts` and the claimed-repository
 * read behind it); these come from the same catalog rows and the same claim
 * query. A change to what "stops passing" or "holds a claim" means has to land
 * in both, or the dialog and the tool will describe different activations of
 * the same catalog and only one of them will match what the service then does.
 * The service's own acknowledgement check is the tiebreaker in the end: it
 * refuses an activation whose claimed list it disagrees with, whichever surface
 * assembled it.
 *
 * The provider directory is deliberately NOT part of this. Repositories the
 * installation exposes that this catalog never held stop passing too, and the
 * dashboard counts them, but reading them costs a listing per configured
 * provider and the honest way to offer that is its own read
 * (`previewRepositoryImport`), not a hidden provider call inside a question
 * about the catalog. The caller that needs the full picture reads both.
 */
import type {
  RepositoryCatalogClaimedRepository,
  RepositoryCatalogEntry,
  RepositoryCatalogState,
} from "@shared/contracts";
import { listConnectedClaimedRepositoriesNotEnabled } from "../../db/repositories/repository-catalog.js";
import { loadRepositoryCatalogEntries } from "./store.js";

export interface RepositoryCatalogActivationPreview {
  state: RepositoryCatalogState;
  /** Rows that keep passing after activation: the ones the catalog enables. */
  keeping: RepositoryCatalogEntry[];
  /** Rows that stop passing: the ones it does not. */
  stopping: RepositoryCatalogEntry[];
  /**
   * Of the stopping rows, the ones holding a run claim right now, with the
   * tickets and runs they were found through.
   *
   * Approximate by construction, and the same list the activate route refuses
   * against: no table ties a workflow-owned branch to the run that created it,
   * so this means "repositories with branches on tickets that currently hold a
   * claim". A ticket re-run after an earlier run touched a repository still
   * lists that repository, which is why each entry carries its evidence.
   */
  claimed: RepositoryCatalogClaimedRepository[];
}

export async function readRepositoryCatalogActivationPreview(): Promise<RepositoryCatalogActivationPreview> {
  const [catalog, claimed] = await Promise.all([
    loadRepositoryCatalogEntries(),
    listConnectedClaimedRepositoriesNotEnabled(),
  ]);
  return {
    state: catalog.state,
    keeping: catalog.entries.filter((entry) => entry.enabled),
    stopping: catalog.entries.filter((entry) => !entry.enabled),
    claimed,
  };
}
