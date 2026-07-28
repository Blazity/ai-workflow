import type { WorkflowRepositoryScope } from "@shared/contracts";
import {
  filterPinnedRepositories,
  pinnedScopeExcludesProvider,
  type RepositoryListingFailure,
  type RepositoryMetadata,
  type SelectedRepository,
  type WorkflowOwnedBranch,
} from "../../adapters/vcs/repository-directory.js";
import type {
  PreSandboxConfigStep,
  PreSandboxRepositoryCatalogDegradation,
  PreSandboxRepositoryScopeNarrowing,
  PreSandboxStepHandler,
} from "../types.js";
import {
  buildRepositoryCatalog,
  buildRepositoryCatalogEntries,
  type RepositoryCatalogEntry,
} from "../../repository-discovery/catalog.js";
import { filterRepositoriesForScope } from "../../lib/repo-allowlist.js";

export interface WorkflowOwnedBranchSelectionInput {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  branch: WorkflowOwnedBranch;
}

export const repoSelectionStep: PreSandboxStepHandler = async ({ context, step }) => {
  const { listRepositoriesAcrossProviders } = await import("../../adapters/vcs/repository-directory.js");
  const { getDb } = await import("../../db/client.js");
  const { listWorkflowOwnedBranchesForTicket } = await import("../../db/queries/workflow-owned-branches.js");
  const { getConfiguredVcsProviders } = await import("../../../env.js");
  const ticketIdentifier = context.ticket.identifier;
  const workflowOwnedBranches = ticketIdentifier
    ? (await listWorkflowOwnedBranchesForTicket(getDb(), ticketIdentifier)).map((record) => ({
        provider: record.provider,
        repoPath: record.repoPath,
        branch: {
          branchName: record.branchName,
          ...(record.pr ? { pr: record.pr } : {}),
        },
      }))
    : [];
  const repositoryScope = context.repositoryScope;
  const listing = await listRepositoriesAcrossProviders(
    listedVcsProviders(
      getConfiguredVcsProviders(),
      repositoryScope,
      workflowOwnedBranches,
    ),
  );
  const repositories = filterRepositoriesForScope(
    listing.repositories,
    repositoryScope,
  );
  const incompleteCatalogProviders = listing.failures
    .filter(
      (failure) =>
        !failedProviderCannotAffectSelection(
          failure.provider,
          repositoryScope,
          workflowOwnedBranches,
        ),
    )
    .map((failure) => failure.provider);

  const selected = selectRepositoriesFromMetadata({
    ticketText: ticketText(context.ticket),
    repositories,
    workflowOwnedBranches,
    ...(repositoryScope ? { repositoryScope } : {}),
    ...(incompleteCatalogProviders.length > 0 ? { incompleteCatalogProviders } : {}),
  });
  const narrowing = scopeNarrowing(repositories, repositoryScope);
  const degradation = catalogDegradation(
    listing.failures,
    selected.status === "catalog_incomplete",
  );

  if (selected.status === "catalog_incomplete") {
    return {
      status: "halt",
      outcome: "failed",
      message: incompleteCatalogMessage(step, listing.failures, selected.providers),
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (selected.status === "clarification_needed") {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: selected.questions[0],
      questions: selected.questions,
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  if (selected.status === "discovery_needed") {
    return {
      status: "continue",
      repositoryDiscovery: {
        catalog: selected.catalog,
        mandatoryRepositories: selected.mandatoryRepositories,
      },
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
      ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
    };
  }

  return {
    status: "continue",
    selectedRepositories: selected.repositories,
    promptAdditions: [
      {
        target: ["research", "implementation", "review"],
        title: "Selected Repositories",
        content: selected.repositories
          .map((repo) => `- ${repo.provider}:${repo.repoPath}: ${repo.selectedRationale}`)
          .join("\n"),
      },
    ],
    ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
    ...(degradation ? { repositoryCatalogDegradation: degradation } : {}),
  };
};

/**
 * Whether a provider that failed to answer could not have changed this run's
 * choice anyway. The definition pin already excludes everything it could have
 * offered, so the surviving listing is exactly what selection would have seen had
 * the provider answered, and the run proceeds on its normal path. A provider
 * carrying a workflow-owned branch for this ticket never qualifies: listedVcsProviders
 * queries it precisely so an in-flight pull request is not stranded, and treating
 * its silence as harmless would strand that pull request without saying so.
 */
function failedProviderCannotAffectSelection(
  provider: RepositoryMetadata["provider"],
  repositoryScope: WorkflowRepositoryScope | undefined,
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[],
): boolean {
  if (workflowOwnedBranches.some((branch) => branch.provider === provider)) {
    return false;
  }
  return pinnedScopeExcludesProvider(repositoryScope, provider);
}

/** Operator-facing telemetry for a provider that never answered, recorded whether
 *  or not the run survived it. */
function catalogDegradation(
  failures: RepositoryListingFailure[],
  failedClosed: boolean,
): PreSandboxRepositoryCatalogDegradation | null {
  if (failures.length === 0) return null;
  return {
    providers: failures.map((failure) => failure.provider),
    outcome: failedClosed ? "failed_closed" : "continued_degraded",
  };
}

/** Names the step the way the runner's own failureMessage does, so a run that
 *  stopped itself here stays greppable by step name exactly like a run whose
 *  listing threw. */
function incompleteCatalogMessage(
  step: PreSandboxConfigStep,
  failures: RepositoryListingFailure[],
  providers: RepositoryMetadata["provider"][],
): string {
  const reasons = failures
    .filter((failure) => providers.includes(failure.provider))
    .map((failure) => `${failure.provider}: ${failure.message}`)
    .join("; ");
  return (
    `${step.name ?? step.uses} failed: repository listing for ${providers.join(", ")} is unavailable (${reasons}), so the repository catalog was incomplete. ` +
    "No deterministic repository signal resolved the selection, and choosing from a partial catalog could pick the wrong repository. " +
    "Retry once the provider recovers, or name the repository path in the ticket."
  );
}

/**
 * Providers whose listings this run needs. A pin narrows the set so an excluded
 * provider is never even queried, but a provider carrying an in-flight
 * workflow-owned branch for this ticket always stays in: losing its listing
 * would strand that branch's open pull request the moment an operator edits the
 * pin.
 */
function listedVcsProviders<T extends { kind: RepositoryMetadata["provider"] }>(
  providers: T[],
  repositoryScope: WorkflowRepositoryScope | undefined,
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[],
): T[] {
  const pinned = repositoryScope?.providers ?? [];
  if (pinned.length === 0) return providers;
  const owned = new Set(workflowOwnedBranches.map((branch) => branch.provider));
  return providers.filter(
    (provider) => pinned.includes(provider.kind) || owned.has(provider.kind),
  );
}

function scopeNarrowing(
  repositories: RepositoryMetadata[],
  repositoryScope: WorkflowRepositoryScope | undefined,
): PreSandboxRepositoryScopeNarrowing | null {
  if (!repositoryScope) return null;
  if (
    (repositoryScope.repositories?.length ?? 0) === 0 &&
    (repositoryScope.providers?.length ?? 0) === 0
  ) {
    return null;
  }
  return {
    catalogSize: repositories.length,
    scopedCatalogSize: filterPinnedRepositories(repositories, repositoryScope).length,
  };
}

export function selectRepositoriesFromMetadata(input: {
  ticketText: string;
  repositories: RepositoryMetadata[];
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[];
  repositoryScope?: WorkflowRepositoryScope;
  /** Providers whose listing failed after retries and whose repositories could
   *  still have changed this choice. Absent when every provider answered, which
   *  keeps a healthy run on exactly its normal path. */
  incompleteCatalogProviders?: RepositoryMetadata["provider"][];
}):
  | { status: "selected"; repositories: SelectedRepository[] }
  | {
      status: "discovery_needed";
      catalog: RepositoryCatalogEntry[];
      mandatoryRepositories: SelectedRepository[];
    }
  | { status: "clarification_needed"; questions: string[] }
  | {
      status: "catalog_incomplete";
      providers: RepositoryMetadata["provider"][];
    } {
  const incompleteCatalogProviders = input.incompleteCatalogProviders ?? [];
  const catalog = buildRepositoryCatalogEntries(input.repositories);
  const usableKeys = new Set(
    catalog.filter((repo) => repo.usable).map((repo) => repositoryKey(repo)),
  );
  const usableRepositories = input.repositories.filter((repo) =>
    usableKeys.has(repositoryKey(repo)),
  );
  const repositoriesByKey = new Map(
    usableRepositories.map((repo) => [repositoryKey(repo), repo]),
  );
  const selected = new Map<string, SelectedRepository>();

  // Signal 0 is the definition pin below, but a repository carrying a
  // workflow-owned branch for this ticket enters first and is never subject to
  // the pin: dropping it would strand that branch's open pull request the moment
  // an operator edits the pin.
  for (const owned of input.workflowOwnedBranches) {
    const repo = repositoriesByKey.get(repositoryKey(owned));
    if (!repo) continue;
    selected.set(repositoryKey(repo), {
      provider: repo.provider,
      repoPath: repo.repoPath,
      defaultBranch: repo.defaultBranch,
      selectedRationale: "workflow-owned branch for this ticket",
      workflowOwnedBranch: owned.branch,
    });
  }

  // Pure intersection over what the server already offered, so the pin can only
  // ever remove candidates. Without a pin this is the input list untouched.
  const scopedRepositories = filterPinnedRepositories(
    usableRepositories,
    input.repositoryScope,
  );
  const pinnedRepositories = input.repositoryScope?.repositories ?? [];
  if (pinnedRepositories.length > 0) {
    const scopedByKey = new Map(
      scopedRepositories.map((repo) => [repositoryKey(repo), repo]),
    );
    const unavailable = pinnedRepositories
      .filter((pinned) => !scopedByKey.has(repositoryKey(pinned)))
      .map((pinned) => `${pinned.provider}:${pinned.repoPath}`);
    // A pin the server cannot satisfy is surfaced by name. Falling through to
    // model discovery would silently replace the operator's explicit choice, and
    // an empty selection would silently resolve the ticket to nothing.
    if (unavailable.length > 0) {
      // A pinned repository that is missing only because its provider never
      // answered is not an access problem the operator can fix in the pin.
      if (incompleteCatalogProviders.length > 0) {
        return incompleteCatalog(incompleteCatalogProviders);
      }
      return {
        status: "clarification_needed",
        questions: [
          `Repositories pinned to this workflow are unavailable: ${unavailable.join(", ")}. Restore access to them or update the workflow's pinned repositories.`,
        ],
      };
    }
    for (const repo of scopedByKey.values()) {
      const key = repositoryKey(repo);
      if (!selected.has(key)) {
        selected.set(key, selectedRepository(repo, "pinned to this workflow"));
      }
    }
    // The initial-match limit below exists for ambiguity between competing
    // signals. An explicit operator pin is not ambiguous, so it does not apply.
    return { status: "selected", repositories: [...selected.values()] };
  }

  const ticketText = input.ticketText.toLowerCase();
  const exactMatches = scopedRepositories.filter((repo) =>
    mentionsRepositoryPath(ticketText, repo.repoPath),
  );
  for (const repo of exactMatches) {
    const key = repositoryKey(repo);
    if (!selected.has(key)) {
      selected.set(key, selectedRepository(repo, "ticket mentions repository path"));
    }
  }

  if (selected.size > 0) {
    if (selected.size > 3) {
      if (incompleteCatalogProviders.length > 0) {
        return incompleteCatalog(incompleteCatalogProviders);
      }
      return {
        status: "clarification_needed",
        questions: [
          "More than 3 repositories match this ticket. Which repositories are essential for the initial research?",
        ],
      };
    }
    return { status: "selected", repositories: [...selected.values()] };
  }

  // Degradation stops here on purpose. Every path above resolves the selection
  // from a signal that does not depend on seeing the whole catalog: a
  // workflow-owned branch for this ticket, a repository path written in the ticket,
  // or a pin the surviving listing fully satisfied. The paths below do depend on
  // it. "Only accessible repository" is a claim about the entire catalog that a
  // partial listing cannot support, and discovery hands the catalog to the model,
  // which would then choose from a set silently missing a whole provider. A
  // clarification is no safer: it presents the same partial catalog to a human as
  // if it were the full picture. Failing the run names the provider that went
  // down; the wrong repository is found much later, by a human, after the branch
  // and pull request already exist.
  if (incompleteCatalogProviders.length > 0) {
    return incompleteCatalog(incompleteCatalogProviders);
  }

  if (scopedRepositories.length === 1) {
    return {
      status: "selected",
      repositories: [
        selectedRepository(scopedRepositories[0]!, "only accessible repository"),
      ],
    };
  }

  // Discovery hands the catalog to the model, so enforce the bounded limit here.
  // Deterministic selection above never fails on catalog size.
  return {
    status: "discovery_needed",
    catalog: buildRepositoryCatalog(
      filterPinnedRepositories(input.repositories, input.repositoryScope),
    ),
    mandatoryRepositories: [...selected.values()],
  };
}

function incompleteCatalog(
  providers: RepositoryMetadata["provider"][],
): { status: "catalog_incomplete"; providers: RepositoryMetadata["provider"][] } {
  return { status: "catalog_incomplete", providers };
}

function repositoryKey(repo: Pick<RepositoryMetadata, "provider" | "repoPath">): string {
  return `${repo.provider}:${repo.repoPath.toLowerCase()}`;
}

function selectedRepository(
  repo: RepositoryMetadata,
  selectedRationale: string,
): SelectedRepository {
  return {
    provider: repo.provider,
    repoPath: repo.repoPath,
    defaultBranch: repo.defaultBranch,
    selectedRationale,
  };
}

function mentionsRepositoryPath(ticketText: string, repoPath: string): boolean {
  const escaped = repoPath.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "[^a-z0-9/_-]";
  return new RegExp(`(^|${boundary})${escaped}($|${boundary})`).test(ticketText);
}

function ticketText(ticket: {
  identifier?: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  comments?: Array<{ author: string; body: string; createdAt?: string }>;
  labels?: string[];
}): string {
  return [
    ticket.identifier,
    ticket.title,
    ticket.description,
    ticket.acceptanceCriteria,
    ...(ticket.comments ?? []).map((comment) => comment.body),
    ...(ticket.labels ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}
