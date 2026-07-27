import type {
  RepositoryMetadata,
  SelectedRepository,
  WorkflowOwnedBranch,
} from "../../adapters/vcs/repository-directory.js";
import type { PreSandboxStepHandler } from "../types.js";
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
  const repositories = await createRepositoryDirectoryForProviders(
    getConfiguredVcsProviders(),
  ).listRepositories();
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

  const selected = selectRepositoriesFromMetadata({
    ticketText: ticketText(context.ticket),
    repositories,
    workflowOwnedBranches,
  });

  if (selected.status === "clarification_needed") {
    return {
      status: "halt",
      outcome: "needs_clarification",
      message: selected.questions[0],
      questions: selected.questions,
    };
  }

  if (selected.status === "discovery_needed") {
    return {
      status: "continue",
      repositoryDiscovery: {
        catalog: selected.catalog,
        mandatoryRepositories: selected.mandatoryRepositories,
      },
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
  };
};

export function selectRepositoriesFromMetadata(input: {
  ticketText: string;
  repositories: RepositoryMetadata[];
  workflowOwnedBranches: WorkflowOwnedBranchSelectionInput[];
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

  const ticketText = input.ticketText.toLowerCase();
  const exactMatches = usableRepositories.filter((repo) =>
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

  if (usableRepositories.length === 1) {
    return {
      status: "selected",
      repositories: [
        selectedRepository(usableRepositories[0]!, "only accessible repository"),
      ],
    };
  }

  // Discovery hands the catalog to the model, so enforce the bounded limit here.
  // Deterministic selection above never fails on catalog size.
  return {
    status: "discovery_needed",
    catalog: buildRepositoryCatalog(input.repositories),
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
