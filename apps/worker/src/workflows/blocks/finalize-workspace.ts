import { z } from "zod";
import { isRunControlError } from "../run-control-error.js";
import type { WorkspaceGate } from "../workspace-gate.js";
import {
  executionError,
  type BlockExecuteFn,
  type BlockExecutionResult,
  type StepsRecord,
} from "./types.js";

export const paramsSchema = z.object({}).strict();

/**
 * Recover the workspace gate from a durable checks-node output. The gate is
 * ephemeral heap state on ctx.prePrGate, so a scheduler resume in a cold Fluid
 * instance (checks handler body not re-run) leaves it null while the checks
 * node's checkpointed output still carries it. Both run_pre_pr_checks and
 * run_checks emit a `gate` field; the `outcome`-string marker keeps recovery
 * pinned to a checks-shaped output. Returns null when no step carries a valid
 * gate (checks genuinely never passed), so the publication boundary still fails
 * closed with `missing_gate`.
 *
 * Iterates in reverse so the most recently completed checks output wins when a
 * run executed checks more than once (e.g. a loop): the last durable gate is the
 * one the hot path would have held on ctx.prePrGate at finalize time.
 *
 * SAFETY: this recovers a gate purely from durable checks output, so it cannot
 * observe an `invalidateWorkspaceGate` that ran AFTER checks but was never
 * re-executed on the cold-resume path. If a workspace-mutating or sandbox-restore
 * node sits BETWEEN the checks node and finalize, the hot path would have nulled
 * the gate (forcing a re-check) while a cold resume can resurrect it here. The
 * built-in linear ticket workflow has no such intervening node; custom workflows
 * can. This is bounded by the publication-boundary guards, which still re-verify
 * the immutable config version (configuration_changed) and the exact clean
 * TRACKED-file fingerprint (workspace_changed) against the live workspace. The
 * residual blind spot is untracked-only mutation, which mirrors the pre-existing
 * untracked-file tolerance the fingerprint deliberately ignores
 * (workspace-gate.ts inspectWorkspaceForGateStep, `--untracked-files=no`).
 * A follow-up that binds recovery to finalize's direct control-flow predecessor
 * (requires threading the definition edges into EngineCtx) would close it.
 */
export function recoverPrePrGateFromSteps(steps: StepsRecord): WorkspaceGate | null {
  const outputs = Object.values(steps);
  for (let index = outputs.length - 1; index >= 0; index -= 1) {
    const output = outputs[index]?.output as Record<string, unknown> | undefined;
    if (!output || typeof output.outcome !== "string" || !("gate" in output)) {
      continue;
    }
    const gate = output.gate;
    if (
      gate !== null &&
      typeof gate === "object" &&
      typeof (gate as { configurationVersion?: unknown }).configurationVersion === "number" &&
      typeof (gate as { fingerprint?: unknown }).fingerprint === "string"
    ) {
      return {
        configurationVersion: (gate as WorkspaceGate).configurationVersion,
        fingerprint: (gate as WorkspaceGate).fingerprint,
      };
    }
  }
  return null;
}

/**
 * finalize_workspace: retain the v1 `checks.*` compatibility gate, then rely on
 * the publication boundary to independently verify the current versioned
 * pre-publication gate and exact workspace fingerprint before any push.
 * It never creates PRs; subject ownership remains held until the workflow's
 * terminal release.
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
  if (unmetChecks.size > 0) {
    const unmet = [...unmetChecks];
    return executionError(`required checks not satisfied: ${unmet.join(", ")}`, {
      category: "checks",
    });
  }

  if (!ctx.sandboxId) {
    return executionError(
      "no workspace: connect prepare_workspace before finalize_workspace",
      { category: "sandbox" },
    );
  }

  if (!ctx.workspaceManifest) {
    return executionError("workspace has no manager-authored trusted manifest", {
      category: "sandbox",
    });
  }

  try {
    const { finalizeWorkspacePublication } = await import("../workspace-publication.js");
    const publication = await finalizeWorkspacePublication({
      runId: ctx.runId,
      subjectKey: ctx.entry.subjectKey,
      ownerToken: ctx.entry.ownerToken,
      sandboxId: ctx.sandboxId,
      ticketKey: ctx.ticket.identifier,
      workspaceManifest: ctx.workspaceManifest,
      repositoryScope: ctx.repositoryScope,
      prePrGate: ctx.prePrGate ?? recoverPrePrGateFromSteps(steps),
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
      return executionError(publication.reason, {
        category: publication.failureKind === "pre_pr_gate" ? "checks" : "provider",
        phase: publication.failureKind === "pre_pr_gate" ? "pre-pr-checks" : "push",
      });
    }

    if (publication.status !== "finalized") {
      return executionError(
        `Finalize Workspace received unexpected publication status: ${publication.status}`,
        { category: "engine", phase: "push" },
      );
    }

    return {
      kind: "next",
      output: {
        status: "finalized",
        repositories: publication.repositories.map((repository) => ({
          provider: repository.provider,
          repoPath: repository.repoPath,
          branchName: repository.branchName,
          defaultBranch: repository.defaultBranch,
          expectedHead: repository.expectedHead,
          pushedHead: repository.pushedHead,
        })),
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "provider",
      phase: "push",
    });
  }
};
