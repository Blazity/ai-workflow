import type { PrTriggerPayload } from "../workflows/agent-input.js";

export type PrTriggerType =
  | "trigger_pr_created"
  | "trigger_pr_checks_failed"
  | "trigger_pr_review"
  | "trigger_pr_merged";

export interface TriggerEvent {
  delivery: {
    provider: "github" | "gitlab";
    producer: string;
    deliveryId: string;
  };
  triggerType: PrTriggerType;
  pr: PrTriggerPayload;
}

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
}

export const GATE_CHECK_NAME_PREFIX = "blazebot / ";

export const DEFAULT_REVIEW_STATES: readonly string[] = ["changes_requested"];

const GITHUB_FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
]);

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
    if (action !== "opened" && action !== "reopened") return null;
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
    const prs = check.pull_requests;
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const prRef = prs[0];
    const prNumber = prRef.number;
    return {
      delivery: githubDelivery(
        options.deliveryId,
        check.app?.slug ?? body?.sender?.login ?? "unknown",
      ),
      triggerType: "trigger_pr_checks_failed",
      pr: {
        provider: "github",
        repoPath: `${repo.owner.login}/${repo.name}`,
        prNumber,
        prUrl: `${repo.html_url}/pull/${prNumber}`,
        headRef: prRef.head?.ref ?? "",
        headSha: prRef.head?.sha ?? check.head_sha ?? "",
        baseRef: prRef.base?.ref ?? "",
        title: "",
        author: "unknown",
        isDraft: false,
        failedChecks: [
          {
            name: check.name,
            conclusion: check.conclusion,
            ...(check.details_url ? { detailsUrl: check.details_url } : {}),
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
    if (options.botLogin && review.user?.login === options.botLogin) return null;
    return {
      delivery: githubDelivery(options.deliveryId, review.user?.login),
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

  return null;
}

export function normalizeGitLabEvent(
  eventName: string,
  body: any,
  options: {
    deliveryId?: string;
    botUsername?: string;
    reviewStates?: readonly string[];
  } = {},
): TriggerEvent | null {
  const producer = body?.user?.username ?? body?.user?.name ?? "unknown";
  if (eventName === "Merge Request Hook") {
    if (body?.object_kind !== "merge_request") return null;
    const attrs = body?.object_attributes;
    const project = body?.project;
    if (!attrs || !project) return null;
    const action = attrs.action;
    if (attrs.system === true) return null;
    if (action === "merge") {
      return {
        delivery: gitLabDelivery(options.deliveryId, producer),
        triggerType: "trigger_pr_merged",
        pr: {
          ...mapGitLabMergeRequest(attrs, project, body?.user),
          ...(typeof attrs.merge_commit_sha === "string"
            ? { mergeSha: attrs.merge_commit_sha }
            : {}),
          ...(typeof attrs.merged_at === "string"
            ? { mergedAt: attrs.merged_at }
            : typeof attrs.actioned_at === "string"
              ? { mergedAt: attrs.actioned_at }
              : typeof attrs.updated_at === "string"
                ? { mergedAt: attrs.updated_at }
                : {}),
        },
      };
    }
    if (action === "update") {
      if (options.botUsername && producer === options.botUsername) return null;
      const allowedStates = options.reviewStates ?? DEFAULT_REVIEW_STATES;
      const reviewer = changedGitLabReviewer(body?.reviewers, body?.changes?.reviewers, body?.user);
      if (reviewer?.state === "requested_changes" && allowedStates.includes("changes_requested")) {
        return {
          delivery: gitLabDelivery(options.deliveryId, producer),
          triggerType: "trigger_pr_review",
          pr: {
            ...mapGitLabMergeRequest(attrs, project, body?.user),
            review: { state: "changes_requested", author: producer, body: "" },
          },
        };
      }
      return null;
    }
    if (action !== "open" && action !== "reopen") return null;
    return {
      delivery: gitLabDelivery(options.deliveryId, producer),
      triggerType: "trigger_pr_created",
      pr: mapGitLabMergeRequest(attrs, project, body?.user),
    };
  }

  if (eventName === "Note Hook") {
    if (body?.object_kind !== "note") return null;
    const attrs = body?.object_attributes;
    const mr = body?.merge_request;
    const project = body?.project;
    if (!attrs || !mr || !project) return null;
    if (
      (options.botUsername && producer === options.botUsername) ||
      attrs.action !== "create" ||
      attrs.noteable_type !== "MergeRequest" ||
      attrs.system === true ||
      !(options.reviewStates ?? DEFAULT_REVIEW_STATES).includes("commented")
    ) {
      return null;
    }
    return {
      delivery: gitLabDelivery(options.deliveryId, producer),
      triggerType: "trigger_pr_review",
      pr: {
        ...mapGitLabMergeRequest(mr, project, body?.user),
        review: {
          state: "commented",
          author: producer,
          body: typeof attrs.note === "string" ? attrs.note : "",
        },
      },
    };
  }

  if (eventName === "Pipeline Hook") {
    if (body?.object_kind !== "pipeline") return null;
    const attrs = body?.object_attributes;
    const mr = body?.merge_request;
    const project = body?.project;
    if (!attrs || !mr || !project) return null;
    if (attrs.status !== "failed") return null;
    const failedBuilds = Array.isArray(body?.builds)
      ? body.builds.filter((build: any) => build?.status === "failed")
      : [];
    const failedChecks =
      failedBuilds.length > 0
        ? failedBuilds.map((build: any) => ({
            name: build.name,
            conclusion: build.status,
          }))
        : [{ name: "pipeline", conclusion: "failed" }];
    return {
      // The authenticated Pipeline Hook is the GitLab CI producer. body.user
      // is merely the human/bot that initiated it and must not define trust.
      delivery: gitLabDelivery(options.deliveryId, "gitlab-ci"),
      triggerType: "trigger_pr_checks_failed",
      pr: {
        provider: "gitlab",
        repoPath: project.path_with_namespace ?? "",
        prNumber: mr.iid,
        prUrl: mr.url ?? "",
        headRef: mr.source_branch ?? "",
        headSha: attrs.sha ?? mr.last_commit?.id ?? "",
        baseRef: mr.target_branch ?? "",
        title: mr.title ?? "",
        author: body?.user?.username ?? body?.user?.name ?? "unknown",
        isDraft: false,
        failedChecks,
      },
    };
  }

  return null;
}

function githubDelivery(deliveryId: string | undefined, producer: string | undefined) {
  return { provider: "github" as const, producer: producer ?? "unknown", deliveryId: deliveryId ?? "" };
}

function gitLabDelivery(deliveryId: string | undefined, producer: string) {
  return { provider: "gitlab" as const, producer, deliveryId: deliveryId ?? "" };
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

function mapGitLabMergeRequest(attrs: any, project: any, user: any): PrTriggerPayload {
  return {
    provider: "gitlab",
    repoPath: project.path_with_namespace ?? "",
    prNumber: attrs.iid,
    prUrl: attrs.url ?? "",
    headRef: attrs.source_branch ?? "",
    headSha: attrs.last_commit?.id ?? attrs.diff_head_sha ?? "",
    baseRef: attrs.target_branch ?? "",
    title: attrs.title ?? "",
    author: user?.username ?? user?.name ?? "unknown",
    isDraft: isGitLabDraft(attrs),
  };
}

function matchingGitLabReviewer(reviewers: unknown, user: any): any | null {
  if (!Array.isArray(reviewers)) return null;
  const username = user?.username;
  const userId = user?.id;
  return (
    reviewers.find(
      (reviewer: any) =>
        (username && reviewer?.username === username) ||
        (userId != null && reviewer?.id === userId),
    ) ?? null
  );
}

function changedGitLabReviewer(reviewers: unknown, changes: unknown, user: any): any | null {
  const current = matchingGitLabReviewer(reviewers, user);
  if (!current || current.state !== "requested_changes") return null;

  let previousReviewers: unknown;
  let currentReviewers: unknown;
  if (Array.isArray(changes) && changes.length === 2) {
    [previousReviewers, currentReviewers] = changes;
  } else if (changes && typeof changes === "object") {
    previousReviewers = (changes as any).previous;
    currentReviewers = (changes as any).current;
  } else {
    return null;
  }
  const changedCurrent = matchingGitLabReviewer(currentReviewers, user);
  const changedPrevious = matchingGitLabReviewer(previousReviewers, user);
  return changedCurrent?.state === "requested_changes" &&
    changedPrevious?.state !== "requested_changes"
    ? current
    : null;
}

function isGateCheckName(
  name: string,
  gateCheckNames: readonly string[],
): boolean {
  if (typeof name !== "string") return false;
  if (gateCheckNames.includes(name)) return true;
  return name.startsWith(GATE_CHECK_NAME_PREFIX);
}

function isGitLabDraft(attrs: any): boolean {
  return (
    attrs.draft === true ||
    attrs.work_in_progress === true ||
    /^(draft|wip):/i.test(attrs.title ?? "")
  );
}
