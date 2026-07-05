import type { GateStatusCapableVCS, GateStatusRef } from "../adapters/vcs/types.js";
import type { VcsProviderKind } from "../../env.js";

export interface PostPrGateWorkflowInput {
  prNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  title: string;
  body: string;
  author: string;
  isDraft: boolean;
  url: string;
  /** Owner/repo string for gate-store keys. */
  ownerRepo: string;
  provider: VcsProviderKind;
}

/**
 * Detached workflow triggered by the GitHub webhook. Does NOT block agent.ts
 * and is NOT called from inside the implementation workflow. Coupling is
 * one-way: agent.ts creates a PR -> that PR fires `pull_request` -> this runs.
 */
export async function postPrGateWorkflow(
  input: PostPrGateWorkflowInput,
): Promise<{ ranSteps: number; failed: boolean }> {
  "use workflow";

  const summary = await runGate(input);
  return summary;
}

async function runGate(input: PostPrGateWorkflowInput) {
  "use step";
  const { loadPostPrGateConfig } = await import("../post-pr-gate/config.js");
  const { postPrGateStepRegistry } = await import("../post-pr-gate/steps/index.js");
  const { executePostPrGatePhase } = await import("../post-pr-gate/runner.js");
  const { GateStore } = await import("../post-pr-gate/gate-store.js");
  const { getDb } = await import("../db/client.js");
  const { ticketKeyFromBranch } = await import("../lib/branch-prefix.js");
  const { createAdapters } = await import("../lib/adapters.js");
  const { logger } = await import("../lib/logger.js");
  const { hasGateStatusCapability } = await import("../adapters/vcs/types.js");

  const config = loadPostPrGateConfig();
  const adapters = createAdapters({
    provider: input.provider,
    repoPath: input.ownerRepo,
    baseBranch: input.baseRef,
  });
  const gateStore = new GateStore(getDb());

  if (config.postPrGate.runOn.botPrsOnly && !input.headRef.startsWith("blazebot/")) {
    logger.info({ headRef: input.headRef }, "post_pr_gate_skipped_not_bot_branch");
    return { ranSteps: 0, failed: false };
  }
  if (!config.postPrGate.runOn.draftPrs && input.isDraft) {
    logger.info({ pr: input.prNumber }, "post_pr_gate_skipped_draft");
    return { ranSteps: 0, failed: false };
  }
  const baseFilter = config.postPrGate.runOn.baseBranches;
  if (baseFilter.length > 0 && !baseFilter.includes(input.baseRef)) {
    logger.info({ baseRef: input.baseRef }, "post_pr_gate_skipped_base_branch");
    return { ranSteps: 0, failed: false };
  }

  if (!hasGateStatusCapability(adapters.vcs)) {
    throw new Error("VCS adapter does not support gate statuses");
  }
  const vcs = adapters.vcs;

  const ticketKey = ticketKeyFromBranch(input.headRef);
  let ticket = null;
  if (ticketKey) {
    try {
      const fetched = await adapters.issueTracker.fetchTicket(ticketKey);
      ticket = {
        identifier: fetched.identifier,
        title: fetched.title,
        description: fetched.description,
        acceptanceCriteria: fetched.acceptanceCriteria,
        comments: fetched.comments,
        labels: fetched.labels,
      };
    } catch (err) {
      logger.warn(
        { ticketKey, err: (err as Error).message },
        "post_pr_gate_ticket_fetch_failed",
      );
    }
  }

  const gateStatusRefs: GateStatusRef[] = [];
  for (const step of config.postPrGate.steps) {
    const name = `blazebot / ${step.name ?? step.uses}`;
    const ref = await (vcs as GateStatusCapableVCS).createGateStatus(
      name,
      input.headSha,
    );
    gateStatusRefs.push(ref);
  }
  const appended = await gateStore.appendGateStatusRefsForSha(
    input.ownerRepo,
    input.prNumber,
    input.headSha,
    gateStatusRefs,
  );
  if (!appended) {
    logger.warn(
      { ownerRepo: input.ownerRepo, prNumber: input.prNumber, headSha: input.headSha },
      "post_pr_gate_append_gate_status_refs_noop",
    );
  }

  // Diff and files are null in v1. Add a fetch-diff step here when the first
  // diff-consuming gate step lands.
  return executePostPrGatePhase({
    context: {
      pr: {
        number: input.prNumber,
        url: input.url,
        headSha: input.headSha,
        headRef: input.headRef,
        baseRef: input.baseRef,
        title: input.title,
        body: input.body,
        author: input.author,
        isDraft: input.isDraft,
      },
      ticket,
      diff: null,
      files: null,
      adapters: {
        vcs: adapters.vcs,
        issueTracker: adapters.issueTracker,
      },
    },
    config,
    gateStatusRefs,
    registry: postPrGateStepRegistry,
    logger,
  });
}
runGate.maxRetries = 0;
