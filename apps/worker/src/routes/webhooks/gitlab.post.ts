import { createError, defineEventHandler, getHeader, readRawBody } from "h3";
import { env, getConfiguredVcsProviders } from "../../../env.js";
import { createRepositoryDirectoryForProviders } from "../../adapters/vcs/repository-directory.js";
import {
  type GitLabProject,
  normalizeGitLabMergeRequestEvent,
  projectMatchesConfiguredId,
  verifyGitLabWebhookToken,
} from "../../lib/gitlab-webhook.js";
import { logger } from "../../lib/logger.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";

const ALLOWED_ACTIONS = new Set(["opened", "update", "reopened"]);

export default defineEventHandler(async (event) => {
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  try {
    verifyGitLabWebhookToken(getHeader(event, "x-gitlab-token"), env.GITLAB_WEBHOOK_SECRET!);
  } catch (err) {
    throw createError({ statusCode: 401, statusMessage: (err as Error).message });
  }

  const gitLabEvent = getHeader(event, "x-gitlab-event");
  if (gitLabEvent !== "Merge Request Hook") {
    return { status: "ignored", reason: "not_merge_request_event" };
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  if (body?.project && !(await gitLabProjectIsAllowed(body.project))) {
    logger.info(
      { project: body.project, expected: env.GITLAB_PROJECT_ID ?? "configured_gitlab_repositories" },
      "post_pr_gate_gitlab_webhook_skipped_other_project",
    );
    return { status: "ignored", reason: "other_project" };
  }

  let normalized;
  try {
    normalized = normalizeGitLabMergeRequestEvent(body);
  } catch {
    return { status: "ignored", reason: "malformed_payload" };
  }

  if (!ALLOWED_ACTIONS.has(normalized.action)) {
    return { status: "ignored", reason: `action_${normalized.action}` };
  }

  return dispatchPostPrGateWebhook(normalized);
});

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
    logger.warn(
      { err: (err as Error).message, project },
      "post_pr_gate_gitlab_webhook_scope_check_failed_closed",
    );
    return false;
  }
}
