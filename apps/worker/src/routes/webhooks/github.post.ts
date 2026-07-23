import { randomUUID } from "node:crypto";
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env, getVcsBotLogin } from "../../../env.js";
import { PostgresRunRegistry } from "../../adapters/run-registry/postgres.js";
import { getDb } from "../../db/client.js";
import { ticketKeyFromBranch } from "../../lib/branch-prefix.js";
import {
  dispatchTriggerEvent,
  type DispatchTriggerResult,
} from "../../lib/dispatch-trigger.js";
import { verifyGitHubWebhookSignature } from "../../lib/github-webhook-sig.js";
import { logger } from "../../lib/logger.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";
import { isRepoAllowed } from "../../lib/repo-allowlist.js";
import { normalizeGitHubEvent } from "../../lib/trigger-events.js";
import { loadPostPrGateConfig } from "../../post-pr-gate/config.js";

const GATE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

// Context for the AC5 diagnostic id: a safe, quotable handle attached to every
// non-dispatched response and logged once per rejected/errored branch. It is
// either the provider delivery id or a random UUID, never derived from config.
type RejectCtx = { diagnosticId: string; event: string; deliveryId: string };
type IgnoredResponse = { status: "ignored"; reason: string; diagnosticId: string };

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    verifyGitHubWebhookSignature(
      rawBody,
      getHeader(event, "x-hub-signature-256"),
      env.GITHUB_WEBHOOK_SECRET!,
    );
  } catch (err) {
    // The payload is untrusted here, but the delivery header is a safe
    // provider-minted handle for the diagnostic id.
    const deliveryHeader = getHeader(event, "x-github-delivery")?.trim() ?? "";
    const ctx: RejectCtx = {
      diagnosticId: deliveryHeader || randomUUID(),
      event: getHeader(event, "x-github-event") ?? "",
      deliveryId: deliveryHeader,
    };
    logIngestionRejected("signature_verification_failed", ctx, "warn");
    throw createError({
      statusCode: 401,
      statusMessage: (err as Error).message,
      data: { diagnosticId: ctx.diagnosticId },
    });
  }

  const ghEvent = getHeader(event, "x-github-event") ?? "";
  const deliveryId = getHeader(event, "x-github-delivery")?.trim() ?? "";
  const ctx: RejectCtx = {
    diagnosticId: deliveryId || randomUUID(),
    event: ghEvent,
    deliveryId,
  };
  if (!deliveryId) {
    return ignored("missing_delivery_id", ctx);
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return ignored("malformed_payload", ctx);
  }

  const repo = body?.repository;
  if (!repo) {
    return ignored("malformed_payload", ctx);
  }

  const ownerRepo = `${repo.owner.login}/${repo.name}`;
  if (!isRepoAllowed(ownerRepo)) {
    logger.info({ ownerRepo }, "github_webhook_skipped_repo_not_allowed");
    return ignored("other_repo", ctx);
  }
  if (env.GITHUB_OWNER && env.GITHUB_REPO) {
    const expected = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    // GitHub owner/repo slugs are case-insensitive, so the payload's
    // repo.owner.login ("Blazity") can differ in case from the configured
    // GITHUB_OWNER ("blazity"). Compare case-insensitively or every demo
    // webhook is silently dropped as other_repo.
    if (ownerRepo.toLowerCase() !== expected.toLowerCase()) {
      logger.info({ ownerRepo, expected }, "github_webhook_skipped_other_repo");
      return ignored("other_repo", ctx);
    }
  }

  const config = loadPostPrGateConfig();
  const gateCheckNames = config.postPrGate.steps.map(
    (step) => `blazebot / ${step.name ?? step.uses}`,
  );
  // Normalize every structurally supported review state here. The dispatcher
  // applies provider/state selectors from the same immutable definition
  // snapshot that it pins, avoiding a load-then-deploy race in this route.
  // Comment events (inline diff + PR conversation) can only ever be "commented".
  const botLogin = getVcsBotLogin("github");
  const reviewStates =
    ghEvent === "pull_request_review"
      ? ["changes_requested", "commented"] as const
      : ghEvent === "pull_request_review_comment" || ghEvent === "issue_comment"
        ? ["commented"] as const
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
    return triggerResponse(result, ctx);
  }

  if (ghEvent === "pull_request") {
    if (!body?.pull_request) {
      return ignored("malformed_payload", ctx);
    }
    if (!GATE_ACTIONS.has(body.action)) {
      return ignored(`action_${body.action}`, ctx);
    }
    return dispatchPostPrGateWebhook(buildGateInput(body, ownerRepo));
  }

  return ignored(`event_${ghEvent}`, ctx);
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

// One structured log line per rejected/errored branch, carrying the same
// diagnosticId that the response returns. Payload and secrets are never logged.
function logIngestionRejected(
  reason: string,
  ctx: RejectCtx,
  level: "info" | "warn" = "info",
) {
  logger[level](
    {
      diagnosticId: ctx.diagnosticId,
      provider: "github",
      event: ctx.event,
      reason,
      ...(ctx.deliveryId ? { deliveryId: ctx.deliveryId } : {}),
    },
    "trigger_ingestion_rejected",
  );
}

function ignored(reason: string, ctx: RejectCtx): IgnoredResponse {
  logIngestionRejected(reason, ctx);
  return { status: "ignored", reason, diagnosticId: ctx.diagnosticId };
}

function triggerResponse(result: DispatchTriggerResult, ctx: RejectCtx) {
  if (result.result === "started") {
    return { status: "dispatched", runId: result.runId };
  }
  if (result.result === "at_capacity" || result.result === "error") {
    // Surface a retryable HTTP failure. Received envelopes also have local poll
    // recovery; failures before durable receipt still need provider retry.
    logger.info({ reason: result.result }, "trigger_webhook_retryable_failure");
    logIngestionRejected(result.result, ctx, "warn");
    throw createError({
      statusCode: 503,
      statusMessage: `trigger_${result.result}`,
      data: { diagnosticId: ctx.diagnosticId },
    });
  }
  return ignored(result.result, ctx);
}
