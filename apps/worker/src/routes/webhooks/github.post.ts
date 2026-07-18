import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env, getVcsBotLogin } from "../../../env.js";
import { PostgresRunRegistry } from "../../adapters/run-registry/postgres.js";
import { getDb } from "../../db/client.js";
import { ticketKeyFromBranch } from "../../lib/branch-prefix.js";
import {
  dispatchTriggerEvent,
  resolveEnabledReviewStates,
  type DispatchTriggerResult,
} from "../../lib/dispatch-trigger.js";
import { verifyGitHubWebhookSignature } from "../../lib/github-webhook-sig.js";
import { logger } from "../../lib/logger.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";
import { isRepoAllowed } from "../../lib/repo-allowlist.js";
import { normalizeGitHubEvent } from "../../lib/trigger-events.js";
import { loadPostPrGateConfig } from "../../post-pr-gate/config.js";

const GATE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

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

  const ghEvent = getHeader(event, "x-github-event") ?? "";
  const deliveryId = getHeader(event, "x-github-delivery")?.trim() ?? "";
  if (!deliveryId) {
    return { status: "ignored", reason: "missing_delivery_id" };
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  const repo = body?.repository;
  if (!repo) {
    return { status: "ignored", reason: "malformed_payload" };
  }

  const ownerRepo = `${repo.owner.login}/${repo.name}`;
  if (!isRepoAllowed(ownerRepo)) {
    logger.info({ ownerRepo }, "github_webhook_skipped_repo_not_allowed");
    return { status: "ignored", reason: "other_repo" };
  }
  if (env.GITHUB_OWNER && env.GITHUB_REPO) {
    const expected = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    // GitHub owner/repo slugs are case-insensitive, so the payload's
    // repo.owner.login ("Blazity") can differ in case from the configured
    // GITHUB_OWNER ("blazity"). Compare case-insensitively or every demo
    // webhook is silently dropped as other_repo.
    if (ownerRepo.toLowerCase() !== expected.toLowerCase()) {
      logger.info({ ownerRepo, expected }, "github_webhook_skipped_other_repo");
      return { status: "ignored", reason: "other_repo" };
    }
  }

  const config = loadPostPrGateConfig();
  const gateCheckNames = config.postPrGate.steps.map(
    (step) => `blazebot / ${step.name ?? step.uses}`,
  );
  // For review events, resolve the enabled definition's `on` set so normalize
  // drops states the operator has not opted into (default: changes_requested).
  const botLogin = getVcsBotLogin("github");
  const reviewStates =
    ghEvent === "pull_request_review"
      ? await resolveEnabledReviewStates(getDb(), "github", botLogin)
      : undefined;
  const evt = normalizeGitHubEvent(ghEvent, body, {
    gateCheckNames,
    deliveryId,
    botLogin,
    ...(reviewStates ? { reviewStates } : {}),
  });

  if (evt) {
    const db = getDb();
    const result = await dispatchTriggerEvent(evt, {
      db,
      runRegistry: new PostgresRunRegistry(db),
      maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
    });

    // The gate keeps running exactly as today whenever the definition did not
    // claim this PR: no enabled definition, or a non-bot PR the definition
    // ignores (ignored_not_workflow_owned).
    if (
      evt.triggerType === "trigger_pr_created" &&
      (result.result === "no_definition" ||
        result.result === "ignored_not_workflow_owned" ||
        result.result === "ignored_provider")
    ) {
      return dispatchPostPrGateWebhook(buildGateInput(body, ownerRepo));
    }
    if (evt.triggerType === "trigger_pr_created" && ticketKeyFromBranch(evt.pr.headRef)) {
      logger.info(
        { prNumber: evt.pr.prNumber, headRef: evt.pr.headRef, triggerType: evt.triggerType },
        "post_pr_gate_superseded_by_definition",
      );
    }
    return triggerResponse(result);
  }

  if (ghEvent === "pull_request") {
    if (!body?.pull_request) {
      return { status: "ignored", reason: "malformed_payload" };
    }
    if (!GATE_ACTIONS.has(body.action)) {
      return { status: "ignored", reason: `action_${body.action}` };
    }
    return dispatchPostPrGateWebhook(buildGateInput(body, ownerRepo));
  }

  return { status: "ignored", reason: `event_${ghEvent}` };
});

function buildGateInput(body: any, ownerRepo: string) {
  const pr = body.pull_request;
  return {
    action: body.action,
    workflowInput: {
      prNumber: pr.number,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      isDraft: !!pr.draft,
      url: pr.html_url,
      ownerRepo,
      provider: "github" as const,
    },
  };
}

function triggerResponse(result: DispatchTriggerResult) {
  if (result.result === "started") {
    return { status: "dispatched", runId: result.runId };
  }
  if (result.result === "at_capacity" || result.result === "error") {
    // Surface a retryable HTTP failure. Received envelopes also have local poll
    // recovery; failures before durable receipt still need provider retry.
    logger.info({ reason: result.result }, "trigger_webhook_retryable_failure");
    throw createError({ statusCode: 503, statusMessage: `trigger_${result.result}` });
  }
  return { status: "ignored", reason: result.result };
}
