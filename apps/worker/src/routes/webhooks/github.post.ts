import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { env } from "../../../env.js";
import { verifyGitHubWebhookSignature } from "../../lib/github-webhook-sig.js";
import { logger } from "../../lib/logger.js";
import { dispatchPostPrGateWebhook } from "../../lib/post-pr-gate-dispatch.js";

const ALLOWED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

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

  const ghEvent = getHeader(event, "x-github-event");
  if (ghEvent !== "pull_request") {
    return { status: "ignored", reason: "not_pull_request_event" };
  }

  const body = rawBody ? JSON.parse(rawBody) : {};
  const action = body?.action;
  const pr = body?.pull_request;
  const repo = body?.repository;
  if (!pr || !repo) {
    return { status: "ignored", reason: "malformed_payload" };
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return { status: "ignored", reason: `action_${action}` };
  }

  const ownerRepo = `${repo.owner.login}/${repo.name}`;

  if (env.GITHUB_OWNER && env.GITHUB_REPO) {
    const expected = `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
    if (ownerRepo !== expected) {
      logger.info({ ownerRepo, expected }, "post_pr_gate_webhook_skipped_other_repo");
      return { status: "ignored", reason: "other_repo" };
    }
  }

  const prNumber = pr.number;
  const headSha = pr.head.sha;
  const headRef = pr.head.ref;

  return dispatchPostPrGateWebhook({
    action,
    workflowInput: {
      prNumber,
      headSha,
      headRef,
      baseRef: pr.base.ref,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      isDraft: !!pr.draft,
      url: pr.html_url,
      ownerRepo,
    },
  });
});
