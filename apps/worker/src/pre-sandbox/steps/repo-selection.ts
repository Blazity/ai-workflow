import type {
  RepositoryMetadata,
  SelectedRepository,
  WorkflowOwnedBranch,
} from "../../adapters/vcs/repository-directory.js";
import type { PreSandboxStepHandler } from "../types.js";

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
  | { status: "clarification_needed"; questions: string[] } {
  const repositoriesByKey = new Map(input.repositories.map((repo) => [repositoryKey(repo), repo]));
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
  const exactMatches = input.repositories.filter((repo) =>
    ticketText.includes(repo.repoPath.toLowerCase()),
  );
  for (const repo of exactMatches) {
    const key = repositoryKey(repo);
    if (!selected.has(key)) {
      selected.set(key, selectedRepository(repo, "ticket mentions repository path"));
    }
  }

  if (selected.size === 0) {
    const scored = input.repositories
      .map((repo) => ({ repo, score: scoreRepository(input.ticketText, repo) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const topScore = scored[0]?.score ?? 0;
    for (const item of scored.filter((candidate) => candidate.score === topScore)) {
      selected.set(repositoryKey(item.repo), selectedRepository(item.repo, "ticket text matches repository metadata"));
    }
  }

  if (selected.size > 0) {
    return { status: "selected", repositories: [...selected.values()] };
  }

  if (input.repositories.length === 1) {
    return {
      status: "selected",
      repositories: [selectedRepository(input.repositories[0], "only accessible repository")],
    };
  }

  return {
    status: "clarification_needed",
    questions: ["Which repository should this ticket modify?"],
  };
}

function repositoryKey(repo: Pick<RepositoryMetadata, "provider" | "repoPath">): string {
  return `${repo.provider}:${repo.repoPath}`;
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

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "in",
  "the",
  "to",
  "update",
  "fix",
  "add",
  "change",
]);

function scoreRepository(ticketText: string, repo: RepositoryMetadata): number {
  const ticketTokens = tokenize(ticketText);
  const repoTokens = new Set([
    ...tokenize(repo.repoPath),
    ...tokenize(repo.name),
    ...tokenize(repo.description),
    ...repo.topics.flatMap((topic) => tokenize(topic)),
  ]);

  let score = 0;
  for (const token of ticketTokens) {
    if (repoTokens.has(token)) score += 1;
  }
  return score;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
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
