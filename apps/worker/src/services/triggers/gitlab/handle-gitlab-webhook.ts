/**
 * What a GitLab delivery means, decided in one place.
 *
 * The route above holds the raw bytes, the headers a delivery is identified by,
 * and the translation of a refusal into an HTTP status. The token check, the
 * delivery-id derivation, the note and workflow-push suppressions, the
 * definition dispatch and the legacy merge-request gate are one ordered
 * decision and live here.
 */
import { createHash } from "node:crypto";

import type { SettingsSnapshot } from "@shared/contracts";
import { createConnectedPostgresRunRegistry } from "../../../db/repositories/active-runs.js";
import { createRepositoryDirectoryForProviders } from "../../../adapters/vcs/repository-directory.js";
import { logger } from "../../../infra/logger.js";
import {
  dispatchPostPrGateWebhook,
  dispatchTriggerEvent,
  isRepoAllowed,
  normalizeGitLabEvents,
  recordIngestionFailure,
  type DispatchTriggerResult,
} from "../../dispatch/index.js";
import {
  isWorkflowGeneratedPush,
  connectedWorkflowPushNormalizationOptions,
} from "../../publication/index.js";
import { ticketKeyFromBranch } from "../../../engine/support/workflow-naming.js";
import {
  configuredVcsProviders,
  gitlabWebhookSettings,
  maxConcurrentAgents,
} from "../../settings/index.js";
import { observeProviderWebhook } from "../../system/index.js";
import {
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
  type GitLabProject,
} from "../../vcs/index.js";
import { getVcsBotLogin } from "../../vcs/index.js";
import { TriggerHttpError } from "../../../infra/trigger-http-error.js";

const ALLOWED_ACTIONS = new Set(["opened", "update", "reopened"]);

/** One delivery, as the transport captured it. */
export type GitLabWebhookRequest = {
  /** The exact bytes, before anything parses them. */
  rawBody: string;
  tokenHeader?: string;
  /** `x-gitlab-event`, absent when the header is not sent. */
  eventName?: string;
  /** `webhook-id`, the first choice of delivery identity. */
  messageId?: string;
  /** `idempotency-key`, the second choice. */
  idempotencyKey?: string;
  /** `x-gitlab-event-uuid`, which only identifies a delivery with the body. */
  eventUuid?: string;
  /**
   * The deployment's settings, on demand.
   *
   * A thunk rather than a value: this endpoint is public, and a delivery with
   * the wrong token must cost nothing but the comparison. The token check below
   * reads the secret from the environment and answers 401 without ever calling
   * this; only the verified path, which is already writing to the database,
   * loads it. The ingress memoises the load on the event, so calling it more
   * than once in a request is still one query.
   */
  loadSettings: () => Promise<SettingsSnapshot>;
};

export async function handleGitLabWebhook(request: GitLabWebhookRequest) {
  // GITLAB_WEBHOOK_SECRET is optional in the schema, and a non-null assertion
  // used to turn an unset variable into the literal string "undefined". Every
  // delivery then failed the comparison, so "nobody configured the secret" and
  // "the secret drifted from the one GitLab sends" were byte-identical 401s.
  // They need different answers, so they get different statuses.
  const gitLabWebhookSecret = gitlabWebhookSettings().secret;
  if (!gitLabWebhookSecret) {
    logger.error({}, "gitlab_webhook_secret_not_configured");
    observeProviderWebhook("gitlab", "rejected", "secret_not_configured");
    throw new TriggerHttpError(503, "GitLab webhook secret is not configured");
  }

  try {
    verifyGitLabWebhookToken(request.tokenHeader, gitLabWebhookSecret);
  } catch (err) {
    observeProviderWebhook("gitlab", "rejected", "invalid_token");
    throw new TriggerHttpError(401, (err as Error).message);
  }

  try {
    const result = await handleVerifiedGitLabWebhook(request);
    observeProviderWebhook("gitlab", "accepted", "request_succeeded");
    return result;
  } catch (error) {
    observeProviderWebhook("gitlab", "rejected", "handler_failed");
    throw error;
  }
}

async function handleVerifiedGitLabWebhook(request: GitLabWebhookRequest) {
  const gitLabEvent = request.eventName;
  if (
    gitLabEvent !== "Merge Request Hook" &&
    gitLabEvent !== "Pipeline Hook" &&
    gitLabEvent !== "Note Hook"
  ) {
    return { status: "ignored", reason: "not_supported_event" };
  }
  const deliveryId = resolveGitLabDeliveryId(request);
  if (!deliveryId) {
    return { status: "ignored", reason: "missing_delivery_id" };
  }

  let body;
  try {
    body = request.rawBody ? JSON.parse(request.rawBody) : {};
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
  const workflowPushOptions =
    gitLabEvent === "Merge Request Hook" && body.object_attributes?.action === "update"
      ? await connectedWorkflowPushNormalizationOptions({
          provider: "gitlab",
          repoPath: body.project?.path_with_namespace ?? "",
          prNumber: body.object_attributes?.iid,
        })
      : {};
  if (
    gitLabEvent === "Merge Request Hook" &&
    body.object_attributes?.action === "update" &&
    isWorkflowGeneratedPush({
      currentHeadSha:
        body.object_attributes?.last_commit?.id ?? body.object_attributes?.sha,
      producer: body?.user?.username ?? body?.user_username,
      botIdentity: botUsername,
      ...workflowPushOptions,
    })
  ) {
    return { status: "ignored", reason: "workflow_generated_push" };
  }
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
    const settings = await request.loadSettings();
    let result: DispatchTriggerResult = { result: "no_definition" };
    let claimedEvent = events[0]!;
    for (const candidate of events) {
      const candidateResult = await dispatchTriggerEvent(candidate, {
        runRegistry: createConnectedPostgresRunRegistry(),
        maxConcurrentAgents: maxConcurrentAgents(settings),
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
}

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
      {
        project: body.project,
        expected: gitlabWebhookSettings().projectId ?? "configured_gitlab_repositories",
      },
      "post_pr_gate_gitlab_webhook_skipped_other_project",
    );
    return { status: "ignored", reason: "other_project" };
  }
  return null;
}

function resolveGitLabDeliveryId(request: GitLabWebhookRequest): string {
  const messageId = request.messageId?.trim() || request.idempotencyKey?.trim();
  if (messageId) return messageId;

  const eventUuid = request.eventUuid?.trim();
  if (!eventUuid) return "";
  return createHash("sha256")
    .update(`${eventUuid}\0`)
    .update(request.rawBody)
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
    throw new TriggerHttpError(
      503,
      `trigger_${result.result}`,
      diagnosticId ? { diagnosticId } : undefined,
    );
  }
  return { status: "ignored", reason: result.result };
}

async function gitLabProjectIsAllowed(project: GitLabProject): Promise<boolean> {
  if (!project.path_with_namespace || !isRepoAllowed(project.path_with_namespace)) {
    return false;
  }
  const configuredProjectId = gitlabWebhookSettings().projectId;
  if (configuredProjectId) {
    return projectMatchesConfiguredId(project, configuredProjectId);
  }

  try {
    const gitLabProviders = configuredVcsProviders().filter(
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
    throw new TriggerHttpError(503, "gitlab_repository_scope_unavailable", { diagnosticId });
  }
}
