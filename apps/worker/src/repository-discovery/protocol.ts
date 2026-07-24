import { z } from "zod";
import type { SelectedRepository } from "../adapters/vcs/repository-directory.js";
import {
  repositoryCatalogKey,
  type RepositoryCatalogEntry,
} from "./catalog.js";

const MAX_DISCOVERED_REPOSITORIES = 3;

const discoveryResultSchema = z
  .object({
    status: z.enum(["selected", "clarification_needed", "failed"]),
    repositories: z
      .array(
        z
          .object({
            provider: z.enum(["github", "gitlab"]),
            repoPath: z.string().min(1),
            rationale: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(MAX_DISCOVERED_REPOSITORIES)
      .nullable(),
    confidence: z.enum(["high", "medium", "low"]).nullable(),
    questions: z.array(z.string().trim().min(1).max(500)).max(3).nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();

export type RepositoryDiscoveryDecision =
  | {
      kind: "selected";
      repositories: SelectedRepository[];
      confidence: "high" | "medium";
    }
  | {
      kind: "clarification_needed";
      questions: string[];
      reason: string;
    }
  | {
      kind: "failed";
      error: string;
    };

export function validateRepositoryDiscoveryResult(
  raw: unknown,
  catalog: RepositoryCatalogEntry[],
  mandatoryRepositories: SelectedRepository[],
): RepositoryDiscoveryDecision {
  const parsed = discoveryResultSchema.safeParse(raw);
  if (!parsed.success) {
    return clarification("Repository discovery returned an invalid response.");
  }
  const result = parsed.data;
  if (result.status === "failed") {
    return {
      kind: "failed",
      error: result.error ?? "Repository discovery failed.",
    };
  }
  if (result.status === "clarification_needed") {
    return {
      kind: "clarification_needed",
      questions:
        result.questions && result.questions.length > 0
          ? result.questions
          : [whichRepositoryQuestion()],
      reason: "model_requested_clarification",
    };
  }
  if (
    result.confidence === "low" ||
    result.confidence === null ||
    result.repositories === null ||
    result.repositories.length === 0
  ) {
    return clarification("Repository discovery confidence was too low.");
  }

  const catalogByKey = new Map(
    catalog.map((repository) => [repositoryCatalogKey(repository), repository]),
  );
  const selected = new Map<string, SelectedRepository>();
  for (const repository of mandatoryRepositories) {
    selected.set(repositoryCatalogKey(repository), repository);
  }
  const discoveredKeys = new Set<string>();
  for (const requested of result.repositories) {
    const key = repositoryCatalogKey(requested);
    if (discoveredKeys.has(key)) {
      return clarification("Repository discovery returned duplicate repositories.");
    }
    discoveredKeys.add(key);
    const repository = catalogByKey.get(key);
    if (!repository || !repository.usable) {
      return clarification("Repository discovery requested an unavailable repository.");
    }
    if (!selected.has(key)) {
      selected.set(key, {
        provider: repository.provider,
        repoPath: repository.repoPath,
        defaultBranch: repository.defaultBranch,
        selectedRationale: requested.rationale,
      });
    }
  }

  return {
    kind: "selected",
    repositories: [...selected.values()],
    confidence: result.confidence,
  };
}

function clarification(reason: string): RepositoryDiscoveryDecision {
  return {
    kind: "clarification_needed",
    questions: [whichRepositoryQuestion()],
    reason,
  };
}

function whichRepositoryQuestion(): string {
  return "Which repository or repositories should this ticket inspect or modify? Reply with full repository paths.";
}
