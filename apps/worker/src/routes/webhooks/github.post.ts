import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { start, getRun } from "workflow/api";
import { env } from "../../../env.js";
import { verifyGitHubWebhookSignature } from "../../lib/github-webhook-sig.js";
import { GateStore, type CurrentGateRun } from "../../post-pr-gate/gate-store.js";
import { getDb } from "../../db/client.js";
import { postPrGateWorkflow } from "../../workflows/post-pr-gate.js";
import { logger } from "../../lib/logger.js";
import { createAdapters } from "../../lib/adapters.js";
import { hasCheckRunCapability } from "../../adapters/vcs/types.js";

const ALLOWED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    verifyGitHubWebhookSignature(
      rawBody,
      getHeader(event, "x-hub-signature-256"),
      env.GITHUB_WEBHOOK_SECRET!,
    );
  } catch (err) {
    throw createError({ statusCode: 401, statusMessage: (err as Error).message });
  }

  const ghEvent = getHeader(event, "x-github-event");
  if (ghEvent !== "pull_request") {
    return { status: "ignored", reason: "not_pull_request_event" };
  }

  const body = rawBody ? JSON.parse(rawBody) : {};
  const action = body?.action;
  const pr = body?.pull_request;
  const repo = body?.repository;
  if (!pr || !repo) {
    return { status: "ignored", reason: "malformed_payload" };
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return { status: "ignored", reason: `action_${action}` };
  }

  const ownerRepo = `${repo.owner.login}/${repo.name}`;

  if (env.GITHUB_OWNER && env.GITHUB_REPO) {
    const expected = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    if (ownerRepo !== expected) {
      logger.info({ ownerRepo, expected }, "post_pr_gate_webhook_skipped_other_repo");
      return { status: "ignored", reason: "other_repo" };
    }
  }

  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const headRef = pr.head.ref;

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
      await cancelPreviousRun(previous, ownerRepo);
    }

    // Write the pointer BEFORE start(). The workflow's appendCheckRunIdsForSha
    // is guarded by headSha (not runId), so it works regardless of whether
    // start() / claimRun / updateRunIdIfHeadSha have completed yet. runId is
    // filled in below once start() returns.
    await gateStore.setCurrent(ownerRepo, prNumber, {
      runId: "",
      headSha,
      checkRunIds: [],
    });

    const handle = await start(postPrGateWorkflow, [
      {
        prNumber,
        headSha,
        headRef,
        baseRef: pr.base.ref,
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user?.login ?? "unknown",
        isDraft: !!pr.draft,
        url: pr.html_url,
        ownerRepo,
      },
    ]);

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
    // Atomic CAS by headSha — does not stomp checkRunIds that the workflow
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
});

async function cancelPreviousRun(
  previous: CurrentGateRun,
  ownerRepo: string,
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

  if (previous.checkRunIds.length === 0) return;

  const adapters = createAdapters();
  if (!hasCheckRunCapability(adapters.vcs)) return;

  for (const id of previous.checkRunIds) {
    await adapters.vcs.updateCheckRun(id, {
      status: "completed",
      conclusion: "cancelled",
      summary: "Cancelled - newer commit replaces this gate run.",
    }).catch((err) => {
      logger.warn(
        { ownerRepo, checkRunId: id, err: (err as Error).message },
        "post_pr_gate_cancel_check_failed",
      );
    });
  }
}
