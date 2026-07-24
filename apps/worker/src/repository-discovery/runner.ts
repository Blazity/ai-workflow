import type { TicketContent } from "../adapters/issue-tracker/types.js";
import type { PreSandboxRepositoryDiscovery } from "../pre-sandbox/types.js";
import type { ResearchRepository } from "../sandbox/agents/types.js";
import {
  repositoryCatalogKey,
  type RepositoryCatalogEntry,
} from "./catalog.js";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";

export const REPOSITORY_DISCOVERY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["selected", "clarification_needed", "failed"],
    },
    repositories: {
      anyOf: [
        {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              provider: { type: "string", enum: ["github", "gitlab"] },
              repoPath: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["provider", "repoPath", "rationale"],
            additionalProperties: false,
          },
        },
        { type: "null" },
      ],
    },
    confidence: {
      anyOf: [
        { type: "string", enum: ["high", "medium", "low"] },
        { type: "null" },
      ],
    },
    questions: {
      anyOf: [
        { type: "array", maxItems: 3, items: { type: "string" } },
        { type: "null" },
      ],
    },
    error: { type: ["string", "null"] },
  },
  required: ["status", "repositories", "confidence", "questions", "error"],
  additionalProperties: false,
});

export function assembleRepositoryDiscoveryPrompt(input: {
  ticket: Pick<
    TicketContent,
    | "identifier"
    | "title"
    | "description"
    | "acceptanceCriteria"
    | "comments"
    | "labels"
  >;
  discovery: PreSandboxRepositoryDiscovery;
}): string {
  return [
    "Select the smallest sufficient repository set for researching this ticket.",
    "Use only exact provider and repoPath values from the server-owned catalog.",
    "Return at most 3 repositories. Use medium/high confidence only when evidence is concrete.",
    "If the evidence is ambiguous, request clarification instead of guessing.",
    "",
    "Ticket:",
    JSON.stringify(input.ticket),
    "",
    "Mandatory repositories (always include):",
    JSON.stringify(
      input.discovery.mandatoryRepositories.map(({ provider, repoPath }) => ({
        provider,
        repoPath,
      })),
    ),
    "",
    "Accessible repository catalog:",
    JSON.stringify(input.discovery.catalog),
  ].join("\n");
}

export type RepositoryExpansionDecision =
  | { kind: "attach"; repositories: SelectedRepository[] }
  | { kind: "clarification_needed"; questions: string[] };

export function validateRepositoryExpansionRequests(input: {
  requests: ResearchRepository[];
  catalog: RepositoryCatalogEntry[];
  attached: Array<Pick<SelectedRepository, "provider" | "repoPath">>;
  completedRounds: number;
}): RepositoryExpansionDecision {
  if (input.completedRounds >= 2) {
    return clarification(
      "Research already used the maximum of 2 repository expansion rounds. Which repositories are essential?",
    );
  }
  if (input.requests.length === 0) {
    return clarification(
      "Research requested more repository context without naming a repository. Which repository is required?",
    );
  }
  if (input.requests.length > 3) {
    return clarification(
      "Research requested more than 3 repositories in one round. Which 3 are essential?",
    );
  }
  const catalog = new Map(
    input.catalog.map((repository) => [
      repositoryCatalogKey(repository),
      repository,
    ]),
  );
  const attached = new Set(input.attached.map(repositoryCatalogKey));
  const requested = new Set<string>();
  const repositories: SelectedRepository[] = [];
  for (const request of input.requests) {
    const key = repositoryCatalogKey(request);
    if (requested.has(key)) {
      return clarification(
        `Research requested ${request.provider}:${request.repoPath} more than once.`,
      );
    }
    requested.add(key);
    if (attached.has(key)) {
      return clarification(
        `Research requested ${request.provider}:${request.repoPath}, but it is already attached. Which additional repository is required?`,
      );
    }
    const repository = catalog.get(key);
    if (!repository?.usable) {
      return clarification(
        `Research requested unavailable repository ${request.provider}:${request.repoPath}. Which accessible repository should be used?`,
      );
    }
    repositories.push({
      provider: repository.provider,
      repoPath: repository.repoPath,
      defaultBranch: repository.defaultBranch,
      selectedRationale: request.rationale,
    });
  }
  if (input.attached.length + repositories.length > 8) {
    return clarification(
      "Attaching those repositories would exceed the 8-repository workspace limit. Which repositories are essential?",
    );
  }
  return { kind: "attach", repositories };
}

function clarification(question: string): RepositoryExpansionDecision {
  return { kind: "clarification_needed", questions: [question] };
}
