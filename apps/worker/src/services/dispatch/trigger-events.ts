import type { PrTriggerPayload, TriggerEvent } from "@shared/contracts";
import type { VcsOpaqueHandle } from "@integrations/sdk";
import { hasAiWorkflowCommentMarker, vcsLoginsMatch } from "../../adapters/vcs/vcs-bot-identity.js";
import { isManagedGateCheckName } from "../../engine/support/workflow-naming.js";

export type { TriggerEvent } from "@shared/contracts";

export interface NormalizeGitHubOptions {
  gateCheckNames: readonly string[];
  botLogin?: string;
  deliveryId?: string;
  /**
   * Review states (from the enabled trigger_pr_review node's `on` param) that
   * may fire a run. Defaults to the safe ["changes_requested"] only: a
   * "commented" review carries an untrusted body that fix_agent would hand to a
   * full-permission agent, so it must be opted into explicitly.
   */
  reviewStates?: readonly string[];
  /** Exact head previously published by the workflow for this PR. */
  workflowPublishedHeadSha?: string;
  /** Legacy ownership signal used only when the persisted row has no SHA. */
  workflowOwnedPullRequest?: boolean;
}

const DEFAULT_REVIEW_STATES: readonly string[] = ["changes_requested"];

const GITHUB_FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
]);

/** Preserve trust for delivery envelopes recorded before the explicit bit existed. */
export function isLegacyTrustedCheckDelivery(
  delivery: Pick<TriggerEvent["delivery"], "producer" | "source">,
): boolean {
  return (
    delivery.producer === "github-actions" ||
    delivery.source === "merge_request_event"
  );
}

export function normalizeGitHubEvent(
  eventName: string,
  body: any,
  options: NormalizeGitHubOptions,
): TriggerEvent | null {
  const repo = body?.repository;
  if (!repo) return null;

  if (eventName === "pull_request") {
    const action = body?.action;
    const pr = body?.pull_request;
    if (!pr) return null;
    if (action === "closed") {
      if (pr.merged !== true) return null;
      return {
        delivery: githubDelivery(options.deliveryId, body?.sender?.login ?? pr.user?.login),
        triggerType: "trigger_pr_merged",
        pr: {
          ...mapGitHubPullRequest(pr, repo),
          ...(typeof pr.merge_commit_sha === "string" ? { mergeSha: pr.merge_commit_sha } : {}),
          ...(typeof pr.merged_at === "string" ? { mergedAt: pr.merged_at } : {}),
        },
      };
    }
    if (action === "ready_for_review") {
      return {
        delivery: githubDelivery(options.deliveryId, body?.sender?.login ?? pr.user?.login),
        triggerType: "trigger_pr_ready",
        pr: mapGitHubPullRequest(pr, repo),
      };
    }
    if (action === "synchronize") {
      const mapped = mapGitHubPullRequest(pr, repo);
      const workflowPublishedPush =
        typeof options.workflowPublishedHeadSha === "string" &&
        options.workflowPublishedHeadSha.length > 0 &&
        mapped.headSha === options.workflowPublishedHeadSha;
      // Identity is a backstop for the sha match, not an alternative to it: a
      // recorded sha that lags the event (a push whose registration never
      // landed, or a run from before registration existed) used to disable this
      // branch outright, which left the workflow's own push looking foreign and
      // superseding the run that made it.
      const botIdentityPush =
        options.workflowOwnedPullRequest === true &&
        !workflowPublishedPush &&
        vcsLoginsMatch(body?.sender?.login ?? pr.user?.login, options.botLogin);
      if (workflowPublishedPush || botIdentityPush) return null;
      return {
        delivery: githubDelivery(options.deliveryId, body?.sender?.login ?? pr.user?.login),
        triggerType: "trigger_pr_updated",
        pr: mapped,
      };
    }
    if (action === "reopened" && pr.draft !== true) {
      return {
        delivery: githubDelivery(options.deliveryId, body?.sender?.login ?? pr.user?.login),
        triggerType: "trigger_pr_ready",
        pr: mapGitHubPullRequest(pr, repo),
      };
    }
    if (action !== "opened") return null;
    return {
      delivery: githubDelivery(options.deliveryId, body?.sender?.login ?? pr.user?.login),
      triggerType: "trigger_pr_created",
      pr: mapGitHubPullRequest(pr, repo),
    };
  }

  if (eventName === "check_run") {
    if (body?.action !== "completed") return null;
    const check = body?.check_run;
    if (!check) return null;
    if (!GITHUB_FAILED_CONCLUSIONS.has(check.conclusion)) return null;
    if (isGateCheckName(check.name, options.gateCheckNames)) return null;
    if (typeof check.id !== "number") return null;
    const prs = check.pull_requests;
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const prRef = prs[0];
    const prNumber = prRef.number;
    const headSha = prRef.head?.sha ?? check.head_sha ?? "";
    const repoPath = `${repo.owner.login}/${repo.name}`;
    const appSlug = check.app?.slug ?? body?.sender?.login ?? "unknown";
    return {
      delivery: {
        ...githubDelivery(options.deliveryId, appSlug),
        trustedByDefault: appSlug === "github-actions",
        // GitHub sends one check_run webhook per failing job, so a commit with
        // five failing jobs fans out into five deliveries. Key on the commit's
        // CI verdict, not the job, so that fan-out coalesces into one run. The
        // repository is part of the key because the (provider, semanticKey)
        // uniqueness constraint has no repository column, and a fork or
        // mirror can share a head sha with its upstream. A later push
        // produces a different head sha and therefore a new key. Leave the
        // key unset when the sha is unknown, rather than degenerate to a
        // trailing empty segment that would coalesce every such delivery for
        // this repo and PR number forever.
        ...(headSha ? { semanticKey: `checks:${repoPath}:${prNumber}:${headSha}` } : {}),
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        provider: "github",
        repoPath,
        prNumber,
        prUrl: `${repo.html_url}/pull/${prNumber}`,
        headRef: prRef.head?.ref ?? "",
        headSha,
        baseRef: prRef.base?.ref ?? "",
        title: "",
        author: "unknown",
        isDraft: false,
        failedChecks: [
          {
            name: check.name,
            conclusion: check.conclusion,
            ...(check.details_url ? { detailsUrl: check.details_url } : {}),
            handle: githubHandle({ id: check.id, owner: appSlug }),
          },
        ],
      },
    };
  }

  if (eventName === "pull_request_review") {
    if (body?.action !== "submitted") return null;
    const review = body?.review;
    const pr = body?.pull_request;
    if (!review || !pr) return null;
    const allowedStates = options.reviewStates ?? DEFAULT_REVIEW_STATES;
    if (!allowedStates.includes(review.state)) return null;
    if (vcsLoginsMatch(review.user?.login, options.botLogin)) return null;
    return {
      delivery: {
        ...githubDelivery(options.deliveryId, review.user?.login),
        ...(typeof review.id === "number" ? { semanticKey: `review:${review.id}` } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        ...mapGitHubPullRequest(pr, repo),
        review: {
          state: review.state as "changes_requested" | "commented",
          author: review.user?.login ?? "unknown",
          body: review.body ?? "",
        },
      },
    };
  }

  if (eventName === "pull_request_review_comment") {
    if (body?.action !== "created") return null;
    const comment = body?.comment;
    const pr = body?.pull_request;
    if (!comment || !pr) return null;
    const allowedStates = options.reviewStates ?? DEFAULT_REVIEW_STATES;
    if (!allowedStates.includes("commented")) return null;
    if (vcsLoginsMatch(comment.user?.login, options.botLogin)) return null;
    if (comment.user?.type === "Bot") return null;
    if (hasAiWorkflowCommentMarker(comment.body)) return null;
    // GitHub wraps inline comments in a review container, so the N sibling
    // comments and their parent review submission share one semantic key.
    // A reply is its own human action and must never coalesce into the review
    // it hangs off, whose key was already consumed by that submission.
    const semanticKey =
      typeof comment.in_reply_to_id === "number" && typeof comment.id === "number"
        ? `comment:${comment.id}`
        : typeof comment.pull_request_review_id === "number"
          ? `review:${comment.pull_request_review_id}`
          : typeof comment.id === "number"
            ? `comment:${comment.id}`
            : undefined;
    return {
      delivery: {
        ...githubDelivery(options.deliveryId, comment.user?.login),
        ...(semanticKey ? { semanticKey } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        ...mapGitHubPullRequest(pr, repo),
        review: {
          state: "commented",
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
        },
      },
    };
  }

  if (eventName === "issue_comment") {
    if (body?.action !== "created") return null;
    const comment = body?.comment;
    const issue = body?.issue;
    // issue.pull_request is only present when the issue is a PR conversation.
    if (!comment || !issue?.pull_request) return null;
    const allowedStates = options.reviewStates ?? DEFAULT_REVIEW_STATES;
    if (!allowedStates.includes("commented")) return null;
    if (vcsLoginsMatch(comment.user?.login, options.botLogin)) return null;
    if (comment.user?.type === "Bot") return null;
    if (hasAiWorkflowCommentMarker(comment.body)) return null;
    const semanticKey =
      typeof comment.id === "number" ? `comment:${comment.id}` : undefined;
    return {
      delivery: {
        ...githubDelivery(options.deliveryId, comment.user?.login),
        ...(semanticKey ? { semanticKey } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        // issue_comment carries no pull_request object, so head facts are
        // unknown here. Dispatch binds the authoritative values before
        // acceptance, mirroring the GitLab Pipeline Hook empty-head pattern.
        provider: "github",
        repoPath: `${repo.owner.login}/${repo.name}`,
        prNumber: issue.number,
        prUrl: issue.pull_request.html_url ?? `${repo.html_url}/pull/${issue.number}`,
        headRef: "",
        headSha: "",
        baseRef: "",
        title: issue.title ?? "",
        author: issue.user?.login ?? "unknown",
        isDraft: false,
        review: {
          state: "commented",
          author: comment.user?.login ?? "unknown",
          body: comment.body ?? "",
        },
      },
    };
  }

  return null;
}

function githubHandle(value: { id: number; owner: string }): VcsOpaqueHandle {
  return value as unknown as VcsOpaqueHandle;
}

/** One provider delivery may satisfy more than one trigger contract (a newly
 * opened non-draft PR is both created and ready). The coordinator consumes
 * these in priority order and lets exactly one eligible definition claim it. */
export function normalizeGitHubEvents(
  eventName: string,
  body: any,
  options: NormalizeGitHubOptions,
): TriggerEvent[] {
  const primary = normalizeGitHubEvent(eventName, body, options);
  if (!primary) return [];
  if (
    eventName === "pull_request" &&
    body?.action === "opened" &&
    body?.pull_request?.draft !== true &&
    primary.triggerType === "trigger_pr_created"
  ) {
    return [
      {
        ...primary,
        triggerType: "trigger_pr_ready",
      },
      primary,
    ];
  }
  return [primary];
}

function githubDelivery(deliveryId: string | undefined, producer: string | undefined) {
  return { provider: "github" as const, producer: producer ?? "unknown", deliveryId: deliveryId ?? "" };
}

function mapGitHubPullRequest(pr: any, repo: any): PrTriggerPayload {
  return {
    provider: "github",
    repoPath: `${repo.owner.login}/${repo.name}`,
    prNumber: pr.number,
    prUrl: pr.html_url,
    headRef: pr.head?.ref ?? "",
    headSha: pr.head?.sha ?? "",
    baseRef: pr.base?.ref ?? "",
    title: pr.title ?? "",
    author: pr.user?.login ?? "unknown",
    isDraft: !!pr.draft,
  };
}

export function isGateCheckName(
  name: string,
  gateCheckNames: readonly string[],
): boolean {
  if (typeof name !== "string") return false;
  if (gateCheckNames.includes(name)) return true;
  return isManagedGateCheckName(name);
}
