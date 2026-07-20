import { z } from "zod";
import { isRunControlError } from "../run-control-error.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z.object({}).strict();

/**
 * finalize_workspace: gate on typed `checks.*` status inputs, preflight every
 * repository, push with exact leases, and emit a durable publication attempt.
 * It never creates PRs; subject ownership remains held until the workflow's
 * terminal release.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  const unmetChecks = new Set(
    Object.entries(resolvedInputs)
      .filter(([name, status]) => name.startsWith("checks.") && status !== "ok")
      .map(([name]) => name.slice("checks.".length)),
  );
  if (unmetChecks.size > 0) {
    const unmet = [...unmetChecks];
    return {
      kind: "failed",
      output: { status: "failed", unmetChecks: unmet },
      reason: `required checks not satisfied: ${unmet.join(", ")}`,
    };
  }

  if (!ctx.sandboxId) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "no workspace: connect prepare_workspace before finalize_workspace",
    };
  }

  if (!ctx.workspaceManifest) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "workspace has no manager-authored trusted manifest",
    };
  }

  try {
    const { finalizeWorkspacePublication } = await import("../workspace-publication.js");
    const publication = await finalizeWorkspacePublication({
      runId: ctx.runId,
      subjectKey: ctx.entry.subjectKey,
      ownerToken: ctx.entry.ownerToken,
      blockId: block.id,
      sandboxId: ctx.sandboxId,
      ticketKey: ctx.ticket.identifier,
      workspaceManifest: ctx.workspaceManifest,
      clarifications: ctx.clarifications,
      sourcePullRequest:
        ctx.entry.kind === "pr_trigger"
          ? {
              provider: ctx.entry.pr.provider,
              repoPath: ctx.entry.pr.repoPath,
              prId: ctx.entry.pr.prNumber,
              headSha: ctx.entry.pr.headSha,
              baseRef: ctx.entry.pr.baseRef,
            }
          : undefined,
    });
    ctx.publication = publication;

    if (publication.status === "failed") {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: publication.reason,
        phase: "push",
      };
    }

    if (publication.status !== "finalized") {
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: `Finalize Workspace received unexpected publication status: ${publication.status}`,
        phase: "push",
      };
    }

    return {
      kind: "next",
      output: {
        status: "finalized",
        publicationAttemptId: publication.attemptId,
        repositories: publication.repositories.map((repository) => ({
          provider: repository.provider,
          repoPath: repository.repoPath,
          branchName: repository.branchName,
          expectedHead: repository.expectedHead,
          pushedHead: repository.pushedHead,
        })),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
      phase: "push",
    };
  }
};
