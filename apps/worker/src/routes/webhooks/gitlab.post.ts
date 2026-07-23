import { createHash, randomUUID } from "node:crypto";
import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { env, getConfiguredVcsProviders, getVcsBotLogin } from "../../../env.js";
import { PostgresRunRegistry } from "../../adapters/run-registry/postgres.js";
import { createRepositoryDirectoryForProviders } from "../../adapters/vcs/repository-directory.js";
import { getDb } from "../../db/client.js";
import { ticketKeyFromBranch } from "../../lib/branch-prefix.js";
import {
  dispatchTriggerEvent,
  type DispatchTriggerResult,
} from "../../lib/dispatch-trigger.js";
import {
  type GitLabProject,
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
} from "../../lib/gitlab-webhook.js";
import { logger } from "../../lib/logger.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";
import { isRepoAllowed } from "../../lib/repo-allowlist.js";
import { normalizeGitLabEvent } from "../../lib/trigger-events.js";

const ALLOWED_ACTIONS = new Set(["opened", "update", "reopened"]);

// Context for the AC5 diagnostic id: a safe, quotable handle attached to every
// non-dispatched response and logged once per rejected/errored branch. It is
// either the provider delivery id or a random UUID, never derived from config.
type RejectCtx = { diagnosticId: string; event: string; deliveryId: string };
type IgnoredResponse = { status: "ignored"; reason: string; diagnosticId: string };

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    verifyGitLabWebhookToken(getHeader(event, "x-gitlab-token"), env.GITLAB_WEBHOOK_SECRET!);
  } catch (err) {
    // The payload is untrusted here, but the event-uuid header is a safe
    // provider-minted handle for the diagnostic id.
    const eventUuid = getHeader(event, "x-gitlab-event-uuid")?.trim() ?? "";
    const ctx: RejectCtx = {
      diagnosticId: eventUuid || randomUUID(),
      event: getHeader(event, "x-gitlab-event") ?? "",
      deliveryId: "",
    };
    logIngestionRejected("token_verification_failed", ctx, "warn");
    throw createError({
      statusCode: 401,
      statusMessage: (err as Error).message,
      data: { diagnosticId: ctx.diagnosticId },
    });
  }

  const gitLabEvent = getHeader(event, "x-gitlab-event");
  // Seed the diagnostic id from the raw event uuid before the delivery id is
  // resolved; it is upgraded to the resolved delivery id once available.
  const ctx: RejectCtx = {
    diagnosticId: getHeader(event, "x-gitlab-event-uuid")?.trim() || randomUUID(),
    event: gitLabEvent ?? "",
    deliveryId: "",
  };
  if (
    gitLabEvent !== "Merge Request Hook" &&
    gitLabEvent !== "Pipeline Hook" &&
    gitLabEvent !== "Note Hook"
  ) {
    return ignored("not_supported_event", ctx);
  }
  const deliveryId = resolveGitLabDeliveryId(event, rawBody);
  if (deliveryId) {
    ctx.deliveryId = deliveryId;
    ctx.diagnosticId = deliveryId;
  }
  if (!deliveryId) {
    return ignored("missing_delivery_id", ctx);
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return ignored("malformed_payload", ctx);
  }

  if (
    gitLabEvent === "Note Hook" &&
    (body?.object_attributes?.internal === true ||
      body?.object_attributes?.confidential === true)
  ) {
    return ignored("note_ignored", ctx);
  }

  const localScope = checkLocalProjectScope(body, ctx);
  if (localScope) return localScope;

  const botUsername = getVcsBotLogin("gitlab");
  // A GitLab note is structurally a `commented` review. The dispatcher applies
  // the enabled definition's selector from the exact version it pins.
  const reviewStates = gitLabEvent === "Note Hook"
    ? ["commented"] as const
    : undefined;
  const evt = normalizeGitLabEvent(gitLabEvent, body, {
    deliveryId,
    botUsername,
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
    // claim this MR: no enabled definition, or a non-bot MR the definition
    // ignores (ignored_not_workflow_owned).
    if (
      evt.triggerType === "trigger_pr_created" &&
      (result.result === "no_definition" ||
        result.result === "ignored_not_workflow_owned" ||
        result.result === "ignored_provider")
    ) {
      return dispatchMergeRequestGate(body, ctx);
    }
    if (evt.triggerType === "trigger_pr_created" && ticketKeyFromBranch(evt.pr.headRef)) {
      logger.info(
        { headRef: evt.pr.headRef, triggerType: evt.triggerType },
        "post_pr_gate_superseded_by_definition",
      );
    }
    return triggerResponse(result, ctx);
  }

  if (gitLabEvent === "Merge Request Hook") {
    return dispatchMergeRequestGate(body, ctx);
  }
  if (gitLabEvent === "Note Hook") {
    return ignored("note_ignored", ctx);
  }
  return ignored("pipeline_ignored", ctx);
});

async function dispatchMergeRequestGate(body: any, ctx: RejectCtx) {
  let normalized;
  try {
    normalized = normalizeGitLabMergeRequestEvent(body);
  } catch {
    return ignored("malformed_payload", ctx);
  }

  if (!ALLOWED_ACTIONS.has(normalized.action)) {
    return ignored(`action_${normalized.action}`, ctx);
  }

  const scope = await checkProjectScope(body, ctx);
  if (scope) return scope;

  return dispatchPostPrGateWebhook(normalized);
}

async function checkProjectScope(
  body: any,
  ctx: RejectCtx,
): Promise<IgnoredResponse | null> {
  if (body?.project && !(await gitLabProjectIsAllowed(body.project, ctx))) {
    logger.info(
      { project: body.project, expected: env.GITLAB_PROJECT_ID ?? "configured_gitlab_repositories" },
      "post_pr_gate_gitlab_webhook_skipped_other_project",
    );
    return ignored("other_project", ctx);
  }
  return null;
}

function checkLocalProjectScope(
  body: any,
  ctx: RejectCtx,
): IgnoredResponse | null {
  const project = body?.project as GitLabProject | undefined;
  if (!project) return null;
  const projectPath = project.path_with_namespace;
  const allowed =
    typeof projectPath === "string" &&
    projectPath.length > 0 &&
    isRepoAllowed(projectPath) &&
    (!env.GITLAB_PROJECT_ID ||
      projectMatchesConfiguredId(project, env.GITLAB_PROJECT_ID));
  if (allowed) return null;
  logger.info(
    { project, expected: env.GITLAB_PROJECT_ID ?? "AGENT_ALLOWED_REPOS" },
    "post_pr_gate_gitlab_webhook_skipped_other_project",
  );
  return ignored("other_project", ctx);
}

function resolveGitLabDeliveryId(event: Parameters<typeof getHeader>[0], rawBody: string): string {
  const messageId =
    getHeader(event, "webhook-id")?.trim() ||
    getHeader(event, "idempotency-key")?.trim();
  if (messageId) return messageId;

  const eventUuid = getHeader(event, "x-gitlab-event-uuid")?.trim();
  if (!eventUuid) return "";
  return createHash("sha256")
    .update(`${eventUuid}\0`)
    .update(rawBody)
    .digest("hex");
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
      provider: "gitlab",
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

async function gitLabProjectIsAllowed(
  project: GitLabProject,
  ctx: RejectCtx,
): Promise<boolean> {
  if (!project.path_with_namespace || !isRepoAllowed(project.path_with_namespace)) {
    return false;
  }
  if (env.GITLAB_PROJECT_ID) {
    return projectMatchesConfiguredId(project, env.GITLAB_PROJECT_ID);
  }

  try {
    const gitLabProviders = getConfiguredVcsProviders().filter(
      (provider) => provider.kind === "gitlab",
    );
    if (gitLabProviders.length === 0) return false;
    const repositories = await createRepositoryDirectoryForProviders(gitLabProviders).listRepositories();
    return repositories.some(
      (repo) => repo.provider === "gitlab" && repo.repoPath === project.path_with_namespace,
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, project },
      "post_pr_gate_gitlab_webhook_scope_check_failed_closed",
    );
    logIngestionRejected("gitlab_repository_scope_unavailable", ctx, "warn");
    throw createError({
      statusCode: 503,
      statusMessage: "gitlab_repository_scope_unavailable",
      data: { diagnosticId: ctx.diagnosticId },
    });
  }
}
