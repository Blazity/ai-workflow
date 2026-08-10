import { createHash } from "node:crypto";
import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { env, getConfiguredVcsProviders, getVcsBotLogin } from "../../../env.js";
import { PostgresRunRegistry } from "../../adapters/run-registry/postgres.js";
import { createRepositoryDirectoryForProviders } from "../../adapters/vcs/repository-directory.js";
import { getDb } from "../../db/client.js";
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
import { recordIngestionFailure } from "../../lib/ingestion-diagnostic.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";
import { isRepoAllowed } from "../../lib/repo-allowlist.js";
import { normalizeGitLabEvents } from "../../lib/trigger-events.js";
import { workflowPushNormalizationOptions } from "../../lib/workflow-push-suppression.js";
import { ticketKeyFromBranch } from "../../lib/workflow-naming.js";

const ALLOWED_ACTIONS = new Set(["opened", "update", "reopened"]);

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    verifyGitLabWebhookToken(getHeader(event, "x-gitlab-token"), env.GITLAB_WEBHOOK_SECRET!);
  } catch (err) {
    throw createError({ statusCode: 401, statusMessage: (err as Error).message });
  }

  const gitLabEvent = getHeader(event, "x-gitlab-event");
  if (
    gitLabEvent !== "Merge Request Hook" &&
    gitLabEvent !== "Pipeline Hook" &&
    gitLabEvent !== "Note Hook"
  ) {
    return { status: "ignored", reason: "not_supported_event" };
  }
  const deliveryId = resolveGitLabDeliveryId(event, rawBody);
  if (!deliveryId) {
    return { status: "ignored", reason: "missing_delivery_id" };
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  if (
    gitLabEvent === "Note Hook" &&
    (body?.object_attributes?.internal === true ||
      body?.object_attributes?.confidential === true)
  ) {
    return { status: "ignored", reason: "note_ignored" };
  }

  const botUsername = getVcsBotLogin("gitlab");
  const db = getDb();
  const workflowPushOptions =
    gitLabEvent === "Merge Request Hook" && body.object_attributes?.action === "update"
      ? await workflowPushNormalizationOptions({
          db,
          provider: "gitlab",
          repoPath: body.project?.path_with_namespace ?? "",
          prNumber: body.object_attributes?.iid,
        })
      : {};
  // A GitLab note is structurally a `commented` review. The dispatcher applies
  // the enabled definition's selector from the exact version it pins.
  const reviewStates = gitLabEvent === "Note Hook"
    ? ["commented"] as const
    : undefined;
  const events = normalizeGitLabEvents(gitLabEvent, body, {
    deliveryId,
    botUsername,
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
    // claim this MR: no enabled definition, or a non-bot MR the definition
    // ignores (ignored_not_workflow_owned).
    if (
      (result.result === "no_definition" ||
        result.result === "ignored_not_workflow_owned" ||
        result.result === "ignored_provider") &&
      gitLabEvent === "Merge Request Hook" &&
      isLegacyGateAction(body)
    ) {
      return dispatchMergeRequestGate(body);
    }
    if (ticketKeyFromBranch(claimedEvent.pr.headRef)) {
      logger.info(
        { headRef: claimedEvent.pr.headRef, triggerType: claimedEvent.triggerType },
        "post_pr_gate_superseded_by_definition",
      );
    }
    return triggerResponse(result);
  }

  if (gitLabEvent === "Merge Request Hook") {
    return dispatchMergeRequestGate(body);
  }
  if (gitLabEvent === "Note Hook") {
    return { status: "ignored", reason: "note_ignored" };
  }
  return { status: "ignored", reason: "pipeline_ignored" };
});

async function dispatchMergeRequestGate(body: any) {
  let normalized;
  try {
    normalized = normalizeGitLabMergeRequestEvent(body);
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  if (!ALLOWED_ACTIONS.has(normalized.action)) {
    return { status: "ignored", reason: `action_${normalized.action}` };
  }

  const scope = await checkProjectScope(body);
  if (scope) return scope;

  return dispatchPostPrGateWebhook(normalized);
}

function isLegacyGateAction(body: any): boolean {
  try {
    return ALLOWED_ACTIONS.has(normalizeGitLabMergeRequestEvent(body).action);
  } catch {
    return false;
  }
}

async function checkProjectScope(
  body: any,
): Promise<{ status: "ignored"; reason: "other_project" } | null> {
  if (body?.project && !(await gitLabProjectIsAllowed(body.project))) {
    logger.info(
      { project: body.project, expected: env.GITLAB_PROJECT_ID ?? "configured_gitlab_repositories" },
      "post_pr_gate_gitlab_webhook_skipped_other_project",
    );
    return { status: "ignored", reason: "other_project" };
  }
  return null;
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

async function gitLabProjectIsAllowed(project: GitLabProject): Promise<boolean> {
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
    const diagnosticId = recordIngestionFailure(
      "post_pr_gate_gitlab_webhook_scope_check_failed_closed",
      err,
      { project },
    );
    throw createError({
      statusCode: 503,
      statusMessage: "gitlab_repository_scope_unavailable",
      data: { diagnosticId },
    });
  }
}
