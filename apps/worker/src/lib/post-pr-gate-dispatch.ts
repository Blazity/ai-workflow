import { start, getRun } from "workflow/api";
import { hasGateStatusCapability } from "../adapters/vcs/types.js";
import { getDb } from "../db/client.js";
import { createAdapters } from "./adapters.js";
import { logger } from "./logger.js";
import { GateStore, type CurrentGateRun } from "../post-pr-gate/gate-store.js";
import { loadPostPrGateConfig } from "../post-pr-gate/config.js";
import {
  postPrGateWorkflow,
  type PostPrGateWorkflowInput,
} from "../workflows/post-pr-gate.js";

interface DispatchPostPrGateWebhookInput {
  action: string;
  workflowInput: PostPrGateWorkflowInput;
}

export async function dispatchPostPrGateWebhook({
  action,
  workflowInput,
}: DispatchPostPrGateWebhookInput) {
  const { ownerRepo, prNumber, headSha } = workflowInput;
  const config = loadPostPrGateConfig();
  const eligibility = checkPostPrGateEligibility(workflowInput, config);
  if (eligibility) return eligibility;

  const gateStore = new GateStore(getDb());

  const lockToken = await gateStore.acquireLock(ownerRepo, prNumber);
  if (!lockToken) {
    logger.info({ ownerRepo, prNumber, headSha }, "post_pr_gate_webhook_lock_busy");
    return { status: "ignored", reason: "lock_busy" };
  }

  try {
    if (action === "reopened") {
      const cur = await gateStore.getCurrent(ownerRepo, prNumber);
      if (cur && cur.headSha === headSha) {
        return { status: "ignored", reason: "reopened_same_sha" };
      }
    }

    const existingClaim = await gateStore.getDedupe(ownerRepo, prNumber, headSha);
    if (existingClaim !== null) {
      logger.info(
        { ownerRepo, prNumber, headSha, existingClaim },
        "post_pr_gate_webhook_already_claimed",
      );
      return { status: "ignored", reason: "already_claimed", runId: existingClaim };
    }

    const previous = await gateStore.getCurrent(ownerRepo, prNumber);
    if (previous && previous.headSha !== headSha) {
      await cancelPreviousRun(previous, workflowInput);
    }

    // Write the pointer BEFORE start(). The workflow's appendGateStatusRefsForSha
    // is guarded by headSha (not runId), so it works regardless of whether
    // start() / claimRun / updateRunIdIfHeadSha have completed yet. runId is
    // filled in below once start() returns.
    await gateStore.setCurrent(ownerRepo, prNumber, {
      runId: "",
      headSha,
      gateStatusRefs: [],
    });

    const handle = await start(postPrGateWorkflow, [workflowInput]);

    const claimed = await gateStore.claimRun(ownerRepo, prNumber, headSha, handle.runId);
    if (claimed !== null) {
      logger.warn(
        { ownerRepo, prNumber, headSha, runId: handle.runId, winner: claimed },
        "post_pr_gate_lock_ttl_lost_race",
      );
      await getRun(handle.runId).cancel().catch(() => undefined);
      // Don't clear the pointer — the winning webhook's pointer is the source
      // of truth.
      return { status: "ignored", reason: "already_claimed", runId: claimed };
    }
    // Atomic CAS by headSha — does not stomp gateStatusRefs that the workflow
    // may have already appended.
    await gateStore.updateRunIdIfHeadSha(ownerRepo, prNumber, headSha, handle.runId);

    logger.info(
      { ownerRepo, prNumber, headSha, runId: handle.runId },
      "post_pr_gate_started",
    );
    return { status: "dispatched", runId: handle.runId };
  } finally {
    await gateStore.releaseLock(ownerRepo, prNumber, lockToken);
  }
}

function checkPostPrGateEligibility(
  input: PostPrGateWorkflowInput,
  config: ReturnType<typeof loadPostPrGateConfig>,
): { status: "ignored"; reason: "not_bot_branch" | "draft" | "base_branch" } | null {
  if (config.postPrGate.runOn.botPrsOnly && !input.headRef.startsWith("blazebot/")) {
    logger.info({ headRef: input.headRef }, "post_pr_gate_skipped_not_bot_branch");
    return { status: "ignored", reason: "not_bot_branch" };
  }
  if (!config.postPrGate.runOn.draftPrs && input.isDraft) {
    logger.info({ pr: input.prNumber }, "post_pr_gate_skipped_draft");
    return { status: "ignored", reason: "draft" };
  }
  const baseFilter = config.postPrGate.runOn.baseBranches;
  if (baseFilter.length > 0 && !baseFilter.includes(input.baseRef)) {
    logger.info({ baseRef: input.baseRef }, "post_pr_gate_skipped_base_branch");
    return { status: "ignored", reason: "base_branch" };
  }
  return null;
}

async function cancelPreviousRun(
  previous: CurrentGateRun,
  input: PostPrGateWorkflowInput,
): Promise<void> {
  try {
    const run = getRun(previous.runId);
    await run.cancel();
  } catch (err) {
    logger.warn(
      { runId: previous.runId, err: (err as Error).message },
      "post_pr_gate_cancel_previous_failed",
    );
  }

  if (previous.gateStatusRefs.length === 0) return;

  const adapters = createAdapters({
    provider: input.provider,
    repoPath: input.ownerRepo,
    baseBranch: input.baseRef,
  });
  if (!hasGateStatusCapability(adapters.vcs)) return;

  for (const ref of previous.gateStatusRefs) {
    await adapters.vcs.updateGateStatus(ref, {
      status: "completed",
      conclusion: "cancelled",
      summary: "Cancelled - newer commit replaces this gate run.",
    }).catch((err) => {
      logger.warn(
        { ownerRepo: input.ownerRepo, gateStatusRef: ref, err: (err as Error).message },
        "post_pr_gate_cancel_status_failed",
      );
    });
  }
}
