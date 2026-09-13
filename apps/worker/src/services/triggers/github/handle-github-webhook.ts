/**
 * What a GitHub delivery means, decided in one place.
 *
 * The route above holds the raw bytes, the four headers GitHub signs with, and
 * the translation of a refusal into an HTTP status. Everything that follows,
 * the secret check, the signature check on those exact bytes, the rename
 * diagnostic, the workflow-generated push suppression, the definition dispatch
 * and the fall back to the legacy post-PR gate, is one ordered decision and
 * lives here.
 */
import type { SettingsSnapshot } from "@shared/contracts";
import { createConnectedPostgresRunRegistry } from "../../../db/repositories/active-runs.js";
import { verifyGitHubWebhookSignature } from "../../../infra/github-webhook-sig.js";
import { logger } from "../../../infra/logger.js";
import { loadPostPrGateConfig } from "../../../post-pr-gate/config.js";
import {
  dispatchPostPrGateWebhook,
  dispatchTriggerEvent,
  isRepositoryDispatchable,
  normalizeGitHubEvents,
  recordIngestionFailure,
  type DispatchTriggerResult,
} from "../../dispatch/index.js";
import type { RepositoryCatalogSnapshot } from "../../repository-catalog/index.js";
import {
  isWorkflowGeneratedPush,
  connectedWorkflowPushNormalizationOptions,
} from "../../publication/index.js";
import {
  gateCheckNameAliases,
  ticketKeyFromBranch,
} from "../../../engine/support/workflow-naming.js";
import { githubWebhookSettings, maxConcurrentAgents } from "../../settings/index.js";
import { observeProviderWebhook } from "../../system/index.js";
import { getVcsBotLogin } from "../../vcs/index.js";
import { TriggerHttpError } from "../../../infra/trigger-http-error.js";

const GATE_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/** One delivery, as the transport captured it. */
export type GitHubWebhookRequest = {
  /** The exact bytes the signature covers, before anything parses them. */
  rawBody: string;
  signatureHeader?: string;
  /** `x-github-event`, the empty string when the header is absent. */
  eventName: string;
  /** `x-github-delivery`, trimmed; the empty string when the header is absent. */
  deliveryId: string;
  /**
   * The deployment's settings, on demand.
   *
   * A thunk rather than a value: this endpoint is public, and a delivery with a
   * bad signature must cost nothing but the HMAC. Verification below reads the
   * secret from the environment and answers 401 without ever calling this; only
   * the verified path, which is already writing to the database, loads it. The
   * ingress memoises the load on the event, so calling it more than once in a
   * request is still one query.
   */
  loadSettings: () => Promise<SettingsSnapshot>;
  /**
   * The repository catalog, on demand, for the same reason `loadSettings` is a
   * thunk: a delivery with a bad signature must cost the HMAC and nothing else,
   * so neither store is touched before verification. The ingress memoises the
   * load on the event, so every candidate event of one delivery and the legacy
   * gate below them all judge against the same snapshot.
   */
  loadRepositoryCatalog: () => Promise<RepositoryCatalogSnapshot>;
};

export async function handleGitHubWebhook(request: GitHubWebhookRequest) {
  const secret = githubWebhookSettings().secret;
  if (!secret) {
    observeProviderWebhook("github", "rejected", "secret_not_configured");
    throw new TriggerHttpError(503, "GitHub webhook secret is not configured");
  }

  try {
    verifyGitHubWebhookSignature(request.rawBody, request.signatureHeader, secret);
  } catch (err) {
    observeProviderWebhook("github", "rejected", "invalid_signature");
    throw new TriggerHttpError(401, (err as Error).message);
  }

  try {
    const result = await handleVerifiedGitHubWebhook(request);
    observeProviderWebhook("github", "accepted", "request_succeeded");
    return result;
  } catch (error) {
    observeProviderWebhook("github", "rejected", "handler_failed");
    throw error;
  }
}

async function handleVerifiedGitHubWebhook(request: GitHubWebhookRequest) {
  const ghEvent = request.eventName;
  const deliveryId = request.deliveryId;
  if (!deliveryId) {
    return { status: "ignored", reason: "missing_delivery_id" };
  }

  let body;
  try {
    body = request.rawBody ? JSON.parse(request.rawBody) : {};
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
  const workflowPushOptions =
    ghEvent === "pull_request" && body.action === "synchronize"
      ? await connectedWorkflowPushNormalizationOptions({
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
    // Two independent reads at one point, so one round trip rather than two:
    // neither decides anything about the other.
    const [settings, repositoryCatalog] = await Promise.all([
      request.loadSettings(),
      request.loadRepositoryCatalog(),
    ]);
    let result: DispatchTriggerResult = { result: "no_definition" };
    let claimedEvent = events[0]!;
    for (const candidate of events) {
      const candidateResult = await dispatchTriggerEvent(candidate, {
        runRegistry: createConnectedPostgresRunRegistry(),
        maxConcurrentAgents: maxConcurrentAgents(settings),
        repositoryCatalog,
      });
      result = candidateResult;
      claimedEvent = candidate;
      if (
        candidateResult.result !== "no_definition" &&
        candidateResult.result !== "ignored_not_workflow_owned" &&
        candidateResult.result !== "ignored_provider" &&
        candidateResult.result !== "ignored_repository_not_enabled"
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
        result.result === "ignored_provider" ||
        result.result === "ignored_repository_not_enabled") &&
      ghEvent === "pull_request" &&
      GATE_ACTIONS.has(body.action)
    ) {
      if (!isLegacyGateRepositoryAllowed(ownerRepo, repositoryCatalog)) {
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
    if (
      !isLegacyGateRepositoryAllowed(ownerRepo, await request.loadRepositoryCatalog())
    ) {
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

function isLegacyGateRepositoryAllowed(
  ownerRepo: string,
  repositoryCatalog: RepositoryCatalogSnapshot,
): boolean {
  if (!isRepositoryDispatchable(repositoryCatalog, { provider: "github", path: ownerRepo })) {
    // Provider and path, because that pair is the catalog key an operator has to
    // find on the Repositories page to answer this.
    logger.info(
      { provider: "github", repoPath: ownerRepo },
      "github_webhook_skipped_repo_not_enabled_in_catalog",
    );
    return false;
  }
  const { owner, repo } = githubWebhookSettings();
  if (!owner || !repo) return true;
  const expected = `${owner}/${repo}`;
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
    throw new TriggerHttpError(
      503,
      `trigger_${result.result}`,
      diagnosticId ? { diagnosticId } : undefined,
    );
  }
  return { status: "ignored", reason: result.result };
}
