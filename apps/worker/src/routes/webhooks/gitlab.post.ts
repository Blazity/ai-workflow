import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { env, getConfiguredVcsProviders } from "../../../env.js";
import { PostgresRunRegistry } from "../../adapters/run-registry/postgres.js";
import { createRepositoryDirectoryForProviders } from "../../adapters/vcs/repository-directory.js";
import { getDb } from "../../db/client.js";
import { ticketKeyFromBranch } from "../../lib/branch-prefix.js";
import {
  dispatchTriggerEvent,
  resolveEnabledReviewStates,
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
import { normalizeGitLabEvent } from "../../lib/trigger-events.js";

const ALLOWED_ACTIONS = new Set(["opened", "update", "reopened"]);
const REVIEWER_STATE_TIMEOUT_MS = 10_000;

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
  const deliveryId = getHeader(event, "x-gitlab-event-uuid")?.trim() ?? "";
  if (!deliveryId) {
    return { status: "ignored", reason: "missing_delivery_id" };
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  const needsReviewFilter = gitLabEvent === "Note Hook";
  const reviewStates = needsReviewFilter
    ? await resolveEnabledReviewStates(getDb())
    : undefined;
  const botUsername = env.GITLAB_BOT_LOGIN ?? env.VCS_BOT_LOGIN;
  let noteReviewerState: string | undefined;
  let projectChecked = false;
  if (gitLabEvent === "Note Hook" && isEligibleMergeRequestNote(body, botUsername)) {
    const scope = await checkProjectScope(body);
    if (scope) return scope;
    projectChecked = true;
    if (reviewStates?.includes("changes_requested")) {
      try {
        noteReviewerState = await fetchNoteActorReviewerState(body);
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, project: body?.project, mergeRequest: body?.merge_request?.iid },
          "gitlab_note_reviewer_state_enrichment_failed",
        );
        throw createError({
          statusCode: 503,
          statusMessage: "gitlab_reviewer_state_unavailable",
        });
      }
    }
  }
  const evt = normalizeGitLabEvent(gitLabEvent, body, {
    deliveryId,
    botUsername,
    ...(reviewStates ? { reviewStates } : {}),
    ...(noteReviewerState ? { noteReviewerState } : {}),
  });

  if (evt) {
    if (!projectChecked) {
      const scope = await checkProjectScope(body);
      if (scope) return scope;
    }

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
      return dispatchMergeRequestGate(body, true);
    }
    if (evt.triggerType === "trigger_pr_created" && ticketKeyFromBranch(evt.pr.headRef)) {
      logger.info(
        { headRef: evt.pr.headRef, triggerType: evt.triggerType },
        "post_pr_gate_superseded_by_definition",
      );
    }
    return triggerResponse(result);
  }

  if (gitLabEvent === "Merge Request Hook") {
    return dispatchMergeRequestGate(body, false);
  }
  if (gitLabEvent === "Note Hook") {
    return { status: "ignored", reason: "note_ignored" };
  }
  return { status: "ignored", reason: "pipeline_ignored" };
});

async function dispatchMergeRequestGate(body: any, projectChecked: boolean) {
  let normalized;
  try {
    normalized = normalizeGitLabMergeRequestEvent(body);
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  if (!ALLOWED_ACTIONS.has(normalized.action)) {
    return { status: "ignored", reason: `action_${normalized.action}` };
  }

  if (!projectChecked) {
    const scope = await checkProjectScope(body);
    if (scope) return scope;
  }

  return dispatchPostPrGateWebhook(normalized);
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

function isEligibleMergeRequestNote(body: any, botUsername: string | undefined): boolean {
  const attrs = body?.object_attributes;
  const producer = body?.user?.username ?? body?.user?.name;
  return Boolean(
    body?.object_kind === "note" &&
      attrs &&
      body?.merge_request &&
      body?.project &&
      attrs.action === "create" &&
      attrs.noteable_type === "MergeRequest" &&
      attrs.system !== true &&
      (!botUsername || producer !== botUsername),
  );
}

async function fetchNoteActorReviewerState(body: any): Promise<string | undefined> {
  const provider = getConfiguredVcsProviders().find((candidate) => candidate.kind === "gitlab");
  if (!provider) throw new Error("GitLab provider is not configured");
  const projectId = body?.project?.id ?? body?.project?.path_with_namespace;
  const mergeRequestIid = body?.merge_request?.iid;
  if (projectId == null || mergeRequestIid == null) {
    throw new Error("GitLab note is missing project or merge request identity");
  }

  const url =
    `${provider.host.replace(/\/+$/, "")}/api/v4/projects/${encodeURIComponent(String(projectId))}` +
    `/merge_requests/${encodeURIComponent(String(mergeRequestIid))}/reviewers`;
  const response = await fetch(url, {
    headers: { "PRIVATE-TOKEN": provider.token },
    signal: AbortSignal.timeout(REVIEWER_STATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `GitLab reviewer state failed: ${response.status} ${response.statusText}`,
    );
  }
  const reviewers = await response.json();
  if (!Array.isArray(reviewers)) throw new Error("GitLab reviewer state response is malformed");

  const actorId = body?.user?.id;
  const actorUsername = body?.user?.username;
  const actor = reviewers.find((reviewer: any) => {
    const user = reviewer?.user;
    return (
      (actorId != null && user?.id === actorId) ||
      (actorUsername && user?.username === actorUsername)
    );
  });
  return typeof actor?.state === "string" ? actor.state : undefined;
}

function triggerResponse(result: DispatchTriggerResult) {
  if (result.result === "started") {
    return { status: "dispatched", runId: result.runId };
  }
  if (result.result === "at_capacity" || result.result === "error") {
    // PR-trigger webhooks are one-shot: there is no cron re-drive, so a dropped
    // event is lost. Return 503 so GitLab redelivers this delivery later.
    logger.info({ reason: result.result }, "trigger_webhook_will_be_redelivered");
    throw createError({ statusCode: 503, statusMessage: `trigger_${result.result}` });
  }
  return { status: "ignored", reason: result.result };
}

async function gitLabProjectIsAllowed(project: GitLabProject): Promise<boolean> {
  if (env.GITLAB_PROJECT_ID) {
    return projectMatchesConfiguredId(project, env.GITLAB_PROJECT_ID);
  }

  const gitLabProviders = getConfiguredVcsProviders().filter((provider) => provider.kind === "gitlab");
  if (gitLabProviders.length === 0 || !project.path_with_namespace) return false;

  try {
    const repositories = await createRepositoryDirectoryForProviders(gitLabProviders).listRepositories();
    return repositories.some(
      (repo) => repo.provider === "gitlab" && repo.repoPath === project.path_with_namespace,
    );
  } catch (err) {
    // Fail closed: if we cannot confirm the project is in scope, deny the event
    // rather than letting an unverified project through to dispatch/gate.
    logger.warn(
      { err: (err as Error).message, project },
      "post_pr_gate_gitlab_webhook_scope_check_failed_closed",
    );
    return false;
  }
}
