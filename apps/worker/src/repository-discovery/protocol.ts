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
      confidence: "high";
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

type ProposedRepository = {
  provider: "github" | "gitlab";
  repoPath: string;
  rationale: string;
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
  // AIW-147 IM-7: only "high" confidence auto-selects. "medium" and "low" now
  // become a clarification. When the model proposed candidates, list them (with
  // provider-scoped paths and rationales) so the human can pick one quickly,
  // mirroring the pre-AIW-147 ranked-candidate question that repo-selection
  // asked before this branch.
  const proposals = result.repositories ?? [];
  if (result.confidence !== "high" || proposals.length === 0) {
    if (proposals.length > 0) {
      return {
        kind: "clarification_needed",
        questions: [candidateClarificationQuestion(proposals)],
        reason:
          result.confidence === "medium"
            ? "discovery_confidence_medium"
            : "discovery_confidence_low",
      };
    }
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
  for (const requested of proposals) {
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
  if (selected.size > MAX_DISCOVERED_REPOSITORIES) {
    return clarification("Repository discovery exceeded the initial repository limit.");
  }

  return {
    kind: "selected",
    repositories: [...selected.values()],
    confidence: "high",
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

// Ranked list of the repositories the model proposed, each with its
// provider-scoped path and rationale, so a human can confirm the selection in
// one reply.
function candidateClarificationQuestion(proposals: ProposedRepository[]): string {
  const candidates = proposals
    .map((proposal) => `${proposal.provider}:${proposal.repoPath} (${proposal.rationale})`)
    .join(", ");
  return [
    "Repository discovery was not confident enough to select automatically.",
    "Which repository or repositories should this ticket inspect or modify?",
    "Reply with full provider-scoped paths (for example github:acme/app).",
    `Proposed candidates: ${candidates}.`,
  ].join(" ");
}
