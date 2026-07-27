import type { WorkflowRepositoryScope } from "@shared/contracts";
import {
  filterPinnedRepositories,
  type RepositoryMetadata,
  type SelectedRepository,
  type WorkflowOwnedBranch,
} from "../../adapters/vcs/repository-directory.js";
import type {
  PreSandboxRepositoryScopeNarrowing,
  PreSandboxStepHandler,
} from "../types.js";
import {
  buildRepositoryCatalog,
  buildRepositoryCatalogEntries,
  type RepositoryCatalogEntry,
} from "../../repository-discovery/catalog.js";

export interface WorkflowOwnedBranchSelectionInput {
  provider: RepositoryMetadata["provider"];
  repoPath: string;
  branch: WorkflowOwnedBranch;
}

export const repoSelectionStep: PreSandboxStepHandler = async ({ context }) => {
  const { createRepositoryDirectoryForProviders } = await import("../../adapters/vcs/repository-directory.js");
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
  const repositories = await createRepositoryDirectoryForProviders(
    listedVcsProviders(
      getConfiguredVcsProviders(),
      repositoryScope,
      workflowOwnedBranches,
    ),
  ).listRepositories();

  const selected = selectRepositoriesFromMetadata({
    ticketText: ticketText(context.ticket),
    repositories,
    workflowOwnedBranches,
    ...(repositoryScope ? { repositoryScope } : {}),
  });
  const narrowing = scopeNarrowing(repositories, repositoryScope);

  if (selected.status === "clarification_needed") {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: selected.questions[0],
      questions: selected.questions,
      ...(narrowing ? { repositoryScopeNarrowing: narrowing } : {}),
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
  };
};

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
}):
  | { status: "selected"; repositories: SelectedRepository[] }
  | {
      status: "discovery_needed";
      catalog: RepositoryCatalogEntry[];
      mandatoryRepositories: SelectedRepository[];
    }
  | { status: "clarification_needed"; questions: string[] } {
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
      return {
        status: "clarification_needed",
        questions: [
          "More than 3 repositories match this ticket. Which repositories are essential for the initial research?",
        ],
      };
    }
    return { status: "selected", repositories: [...selected.values()] };
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
