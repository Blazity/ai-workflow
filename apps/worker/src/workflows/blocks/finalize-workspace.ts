import { z } from "zod";
import type { SelectedRepository } from "../../adapters/vcs/repository-directory.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    /** Execution-only compatibility marker produced by stored-definition
     * upgrades. The dashboard never authors this field. */
    legacyRequiredChecks: z.array(z.string().min(1)).optional(),
  })
  .strict();

async function blockFinalizePrLinksCommentStep(
  ticketId: string,
  prs: Array<{ provider: SelectedRepository["provider"]; repoPath: string; url: string; id: number }>,
  heading: string,
): Promise<void> {
  "use step";
  const { createStepAdapters } = await import("../../lib/step-adapters.js");
  const { issueTracker } = createStepAdapters();
  const lines = prs.map((pr) => `- ${pr.provider}:${pr.repoPath}: #${pr.id} ${pr.url}`);
  try {
    await issueTracker.postComment(ticketId, `${heading}\n${lines.join("\n")}`);
  } catch (err) {
    const { logger } = await import("../../lib/logger.js");
    logger.warn(
      { ticketId, prs, err: err instanceof Error ? err.message : String(err) },
      "pr_links_comment_failed",
    );
  }
}
blockFinalizePrLinksCommentStep.maxRetries = 0;

/**
 * finalize_workspace: gate on typed `checks.*` status inputs, push the workspace
 * and open or reuse workflow-owned pull requests via publishWorkspaceChanges,
 * comment the PR links on the ticket, and set ctx.publication. The run is
 * unregistered exactly once before PR creation through ctx.unregisterBeforePr
 * (mirrors agent.ts's open_pr semantics).
 */
export const execute: BlockExecuteFn = async (
  block,
  steps,
  ctx,
  resolvedInputs = {},
): Promise<BlockExecutionResult> => {
  const unmetChecks = new Set(
    Object.entries(resolvedInputs)
      .filter(([name, status]) => name.startsWith("checks.") && status !== "ok")
      .map(([name]) => name.slice("checks.".length)),
  );
  const legacyRequiredChecks = Array.isArray(block.params.legacyRequiredChecks)
    ? block.params.legacyRequiredChecks.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      )
    : [];
  for (const id of legacyRequiredChecks) {
    const status = Object.prototype.hasOwnProperty.call(steps, id)
      ? steps[id]?.output.status
      : undefined;
    if (status !== "ok") unmetChecks.add(id);
  }
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

  try {
    const { publishWorkspaceChanges } = await import("../workspace-publication.js");
    const publication = await publishWorkspaceChanges({
      sandboxId: ctx.sandboxId,
      ticketKey: ctx.ticket.identifier,
      branchName: ctx.branchName,
      repositories: ctx.selectedRepositories,
      title: ctx.ticket.title,
      agentKind: ctx.runDefaultKind,
      model: ctx.defaults[ctx.runDefaultKind],
      clarifications: ctx.clarifications,
      beforeCreatePullRequests: async () => {
        await ctx.unregisterBeforePr();
      },
    });
    ctx.publication = publication;

    if (publication.status === "failed") {
      if (publication.prs.length > 0) {
        await blockFinalizePrLinksCommentStep(
          ctx.ticket.identifier,
          publication.prs,
          "Pull requests created before publication failed:",
        );
      }
      return {
        kind: "failed",
        output: { status: "failed" },
        reason: publication.reason,
        phase: "push",
      };
    }

    if (publication.prs.some((pr) => pr.isNew)) {
      await blockFinalizePrLinksCommentStep(
        ctx.ticket.identifier,
        publication.prs,
        "Pull requests ready for review:",
      );
    }

    return {
      kind: "next",
      output: {
        status: "published",
        prs: publication.prs.map((pr) => ({
          provider: pr.provider,
          repoPath: pr.repoPath,
          id: pr.id,
          url: pr.url,
          isNew: pr.isNew,
        })),
      },
    };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
      phase: "push",
    };
  }
};
