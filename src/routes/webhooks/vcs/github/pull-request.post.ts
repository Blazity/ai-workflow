import { createHmac, timingSafeEqual } from "node:crypto";
import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env } from "../../../../../env.js";
import { loadConfig } from "../../../../lib/workflow-config.js";
import { dispatchReview } from "../../../../lib/dispatch-review.js";
import { logger } from "../../../../lib/logger.js";

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  // 1. Check webhook secret is configured
  if (!env.GITHUB_WEBHOOK_SECRET) {
    throw createError({ statusCode: 503, statusMessage: "review webhook not configured" });
  }

  // 2. Verify HMAC signature
  const sigHeader = getHeader(event, "x-hub-signature-256");
  if (!sigHeader || !sigHeader.startsWith("sha256=")) {
    throw createError({ statusCode: 401, statusMessage: "Missing or malformed X-Hub-Signature-256 header" });
  }

  if (!verifySignature(rawBody, env.GITHUB_WEBHOOK_SECRET, sigHeader)) {
    throw createError({ statusCode: 401, statusMessage: "Invalid webhook signature" });
  }

  // 3. Check event type
  const githubEvent = getHeader(event, "x-github-event");
  if (githubEvent !== "pull_request") {
    logger.info({ githubEvent }, "github_webhook_ignored_wrong_event");
    return { status: "ignored", reason: "wrong_event" };
  }

  // 4. Parse body and check action
  let body: Record<string, any> = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      const deliveryId = getHeader(event, "x-github-delivery");
      logger.warn(
        { deliveryId, error: (err as Error).message },
        "github_webhook_invalid_json",
      );
      throw createError({ statusCode: 400, statusMessage: "invalid JSON payload" });
    }
  }
  const action: string = body.action ?? "";
  const ACCEPTED_ACTIONS = ["opened", "synchronize", "reopened", "labeled"] as const;
  if (!ACCEPTED_ACTIONS.includes(action as (typeof ACCEPTED_ACTIONS)[number])) {
    logger.info({ action }, "github_webhook_ignored_unsupported_action");
    return { status: "ignored", reason: "unsupported_action" };
  }

  // 5. Load workflow config
  let config: Awaited<ReturnType<typeof loadConfig>>["config"];
  try {
    const result = await loadConfig({ requireWebhookSecret: true });
    config = result.config;
  } catch (err) {
    logger.error({ error: (err as Error).message }, "github_webhook_config_load_failed");
    throw createError({ statusCode: 500, statusMessage: "Failed to load workflow config" });
  }

  if (config.review.enabled === false) {
    logger.info({}, "github_webhook_ignored_review_disabled");
    return { status: "ignored", reason: "review_disabled" };
  }

  // 6. Check repo matches expected owner/repo
  const fullName: string = body.repository?.full_name ?? "";
  const expectedFullName = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const normalizedFullName = fullName.trim().toLowerCase();
  const normalizedExpectedFullName = expectedFullName.trim().toLowerCase();
  if (normalizedFullName !== normalizedExpectedFullName) {
    logger.info({ fullName: normalizedFullName, expectedFullName: normalizedExpectedFullName }, "github_webhook_ignored_wrong_repo");
    return { status: "ignored", reason: "wrong_repo" };
  }

  // 7. Apply triggers filter
  if (!config.review.triggers.includes(action as (typeof ACCEPTED_ACTIONS)[number])) {
    logger.info({ action, triggers: config.review.triggers }, "github_webhook_ignored_not_in_triggers");
    return { status: "ignored", reason: "unsupported_action" };
  }

  // 8. Apply scope filter
  const scope = config.review.scope;
  const prLabels: Array<{ name: string }> = body.pull_request?.labels ?? [];
  const headRef: string = body.pull_request?.head?.ref ?? "";

  if (scope.mode === "label") {
    const requiredLabel = scope.label ?? "";
    const hasLabel = prLabels.some((l) => l.name === requiredLabel);
    if (!hasLabel) {
      logger.info({ requiredLabel, prLabels: prLabels.map((l) => l.name) }, "github_webhook_ignored_out_of_scope");
      return { status: "ignored", reason: "out_of_scope" };
    }
  } else if (scope.mode === "branch_prefix") {
    const prefix = scope.branch_prefix ?? "";
    if (!headRef.startsWith(prefix)) {
      logger.info({ prefix, headRef }, "github_webhook_ignored_out_of_scope");
      return { status: "ignored", reason: "out_of_scope" };
    }
  }
  // mode === "all" always passes

  // 9. Validate payload shape before dispatch — malformed payloads (rare past HMAC)
  //    should return 400, not crash with a TypeError → 500.
  const owner: unknown = body.repository?.owner?.login;
  const repo: unknown = body.repository?.name;
  const prNumber: unknown = body.pull_request?.number;
  const headSha: unknown = body.pull_request?.head?.sha;

  if (
    typeof owner !== "string" || !owner ||
    typeof repo !== "string" || !repo ||
    typeof prNumber !== "number" ||
    typeof headSha !== "string" || !headSha
  ) {
    logger.warn(
      { hasOwner: typeof owner === "string", hasRepo: typeof repo === "string", prNumberType: typeof prNumber, hasHeadSha: typeof headSha === "string" },
      "github_webhook_invalid_payload",
    );
    throw createError({ statusCode: 400, statusMessage: "invalid_payload" });
  }

  let runId: string;
  try {
    const result = await dispatchReview({ owner, repo, prNumber, headSha, action });
    runId = result.runId;
  } catch (err) {
    logger.error({ error: (err as Error).message, owner, repo, prNumber }, "github_webhook_dispatch_failed");
    throw createError({ statusCode: 500, statusMessage: "Failed to dispatch review workflow" });
  }

  logger.info({ owner, repo, prNumber, headSha, action, runId }, "github_webhook_dispatched");
  return { status: "dispatched", runId, prNumber, headSha };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verifySignature(rawBody: string, secret: string, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(headerValue);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}
