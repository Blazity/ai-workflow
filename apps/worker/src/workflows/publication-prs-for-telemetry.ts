import type { RunPullRequest } from "@shared/contracts";
import type { WorkspacePublicationResult } from "./workspace-publication.js";

/** Project a workspace publication into the exact durable workflow_runs.prs shape. */
export function publicationPrsForTelemetry(
  publication: WorkspacePublicationResult | null | undefined,
): RunPullRequest[] | null {
  if (publication?.status !== "published" || publication.prs.length === 0) return null;
  return publication.prs.map((pr) => {
    const repository = publication.repositories.find(
      (candidate) =>
        candidate.provider === pr.provider && candidate.repoPath === pr.repoPath,
    );
    return {
      provider: pr.provider,
      repoPath: pr.repoPath,
      id: pr.id,
      url: pr.url,
      ...(repository?.pushedHead ? { headSha: repository.pushedHead } : {}),
    };
  });
}
