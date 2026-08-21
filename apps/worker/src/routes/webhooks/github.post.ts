import {
  defineEventHandler,
  readRawBody,
  getHeader,
  createError,
  type H3Event,
} from "h3";
import { env, getVcsBotLogin } from "../../../env.js";
import { PostgresRunRegistry } from "../../adapters/run-registry/postgres.js";
import { getDb } from "../../db/client.js";
import {
  dispatchTriggerEvent,
  type DispatchTriggerResult,
} from "../../lib/dispatch-trigger.js";
import { verifyGitHubWebhookSignature } from "../../lib/github-webhook-sig.js";
import { recordIngestionFailure } from "../../lib/ingestion-diagnostic.js";
import { logger } from "../../lib/logger.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";
import { isRepoAllowed } from "../../lib/repo-allowlist.js";
import { normalizeGitHubEvents } from "../../lib/trigger-events.js";
import {
  isWorkflowGeneratedPush,
  workflowPushNormalizationOptions,
} from "../../lib/workflow-push-suppression.js";
import {
  gateCheckNameAliases,
  ticketKeyFromBranch,
} from "../../lib/workflow-naming.js";
import { loadPostPrGateConfig } from "../../post-pr-gate/config.js";
import { observeProviderWebhook } from "../../system-health/provider-webhook-observation.js";

const GATE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  if (!env.GITHUB_WEBHOOK_SECRET) {
    observeProviderWebhook("github", "rejected", "secret_not_configured");
    throw createError({
      statusCode: 503,
      statusMessage: "GitHub webhook secret is not configured",
    });
  }

  try {
    verifyGitHubWebhookSignature(
      rawBody,
      getHeader(event, "x-hub-signature-256"),
      env.GITHUB_WEBHOOK_SECRET,
    );
  } catch (err) {
    observeProviderWebhook("github", "rejected", "invalid_signature");
    throw createError({ statusCode: 401, statusMessage: (err as Error).message });
  }
  try {
    const result = await handleVerifiedGitHubWebhook(event, rawBody);
    observeProviderWebhook("github", "accepted", "request_succeeded");
    return result;
  } catch (error) {
    observeProviderWebhook("github", "rejected", "handler_failed");
    throw error;
  }
});

async function handleVerifiedGitHubWebhook(event: H3Event, rawBody: string) {
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

  if (ghEvent === "repository" && body.action === "renamed") {
    return reportRepositoryRename(body, ownerRepo);
  }

  const config = loadPostPrGateConfig();
  const gateCheckNames = config.postPrGate.steps.flatMap(
    (step) => gateCheckNameAliases(step.name ?? step.uses),
  );
  // Normalize every structurally supported review state here. The dispatcher
  // applies provider/state selectors from the same immutable definition
  // snapshot that it pins, avoiding a load-then-deploy race in this route.
  // Comment events (inline diff + PR conversation) can only ever be "commented".
  const botLogin = getVcsBotLogin("github");
  const db = getDb();
  const workflowPushOptions =
    ghEvent === "pull_request" && body.action === "synchronize"
      ? await workflowPushNormalizationOptions({
          db,
          provider: "github",
          repoPath: ownerRepo,
          prNumber: body.pull_request?.number,
        })
      : {};
  if (
    ghEvent === "pull_request" &&
    body.action === "synchronize" &&
    isWorkflowGeneratedPush({
      currentHeadSha: body.pull_request?.head?.sha,
      producer: body?.sender?.login ?? body.pull_request?.user?.login,
      botIdentity: botLogin,
      ...workflowPushOptions,
    })
  ) {
    return { status: "ignored", reason: "workflow_generated_push" };
  }
  const reviewStates =
    ghEvent === "pull_request_review"
      ? ["changes_requested", "commented"] as const
      : ghEvent === "pull_request_review_comment" || ghEvent === "issue_comment"
        ? ["commented"] as const
        : undefined;
  const events = normalizeGitHubEvents(ghEvent, body, {
    gateCheckNames,
    deliveryId,
    botLogin,
    ...workflowPushOptions,
    ...(reviewStates ? { reviewStates } : {}),
  });

  if (events.length > 0) {
    let result: DispatchTriggerResult = { result: "no_definition" };
    let claimedEvent = events[0]!;
    for (const candidate of events) {
      const candidateResult = await dispatchTriggerEvent(candidate, {
        db,
        runRegistry: new PostgresRunRegistry(db),
        maxConcurrentAgents: env.MAX_CONCURRENT_AGENTS,
      });
      result = candidateResult;
      claimedEvent = candidate;
      if (
        candidateResult.result !== "no_definition" &&
        candidateResult.result !== "ignored_not_workflow_owned" &&
        candidateResult.result !== "ignored_provider"
      ) {
        break;
      }
    }

    // The gate keeps running exactly as today whenever the definition did not
    // claim this PR: no enabled definition, or a non-bot PR the definition
    // ignores (ignored_not_workflow_owned).
    if (
      (result.result === "no_definition" ||
        result.result === "ignored_not_workflow_owned" ||
        result.result === "ignored_provider") &&
      ghEvent === "pull_request" &&
      GATE_ACTIONS.has(body.action)
    ) {
      if (!isLegacyGateRepositoryAllowed(ownerRepo)) {
        return { status: "ignored", reason: "other_repo" };
      }
      return dispatchPostPrGateWebhook(buildGateInput(body, ownerRepo));
    }
    if (ticketKeyFromBranch(claimedEvent.pr.headRef)) {
      logger.info(
        { prNumber: claimedEvent.pr.prNumber, headRef: claimedEvent.pr.headRef, triggerType: claimedEvent.triggerType },
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
    if (!isLegacyGateRepositoryAllowed(ownerRepo)) {
      return { status: "ignored", reason: "other_repo" };
    }
    return dispatchPostPrGateWebhook(buildGateInput(body, ownerRepo));
  }

  return { status: "ignored", reason: `event_${ghEvent}` };
}

/**
 * A rename changes `repository.full_name`, the key every definition repository
 * pin is stored under, so a workflow pinned to the old path silently stops
 * seeing that repository's events. Silent loss is the failure mode operators
 * cannot debug, so the rename is surfaced as a diagnostic.
 *
 * Detection only, on purpose: rewriting an operator's pin from a webhook would
 * widen or move a scope nobody asked to change. GitLab's equivalent, the
 * project_rename system hook, is not subscribed, so a GitLab rename stays
 * invisible here.
 */
function reportRepositoryRename(body: any, ownerRepo: string) {
  // The payload carries only the old name, while a pin holds the full path.
  const previousName = body?.changes?.repository?.name?.from;
  const from =
    typeof previousName === "string" && previousName.trim() !== ""
      ? `${ownerRepo.split("/")[0]}/${previousName}`
      : "unknown";
  const to = typeof body.repository?.full_name === "string"
    ? body.repository.full_name
    : ownerRepo;
  const diagnosticId = recordIngestionFailure(
    "trigger_repo_renamed",
    new Error(
      `Repository renamed from ${from} to ${to}. Workflows pinned to the old path stop receiving its events until an operator updates the pin.`,
    ),
    { provider: "github", from, to },
  );
  return { status: "ignored", reason: "repository_renamed", diagnosticId };
}

function isLegacyGateRepositoryAllowed(ownerRepo: string): boolean {
  if (!isRepoAllowed(ownerRepo)) {
    logger.info({ ownerRepo }, "github_webhook_skipped_repo_not_allowed");
    return false;
  }
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO) return true;
  const expected = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const allowed = ownerRepo.toLowerCase() === expected.toLowerCase();
  if (!allowed) {
    logger.info({ ownerRepo, expected }, "github_webhook_skipped_other_repo");
  }
  return allowed;
}

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
    const diagnosticId =
      result.result === "error" ? result.diagnosticId : undefined;
    logger.info(
      { reason: result.result, ...(diagnosticId ? { diagnosticId } : {}) },
      "trigger_webhook_retryable_failure",
    );
    throw createError({
      statusCode: 503,
      statusMessage: `trigger_${result.result}`,
      ...(diagnosticId ? { data: { diagnosticId } } : {}),
    });
  }
  return { status: "ignored", reason: result.result };
}
