import type { PrTriggerPayload } from "../workflows/agent-input.js";
import { hasAiWorkflowCommentMarker, vcsLoginsMatch } from "./vcs-bot-identity.js";
import { isManagedGateCheckName } from "./workflow-naming.js";

export {
  GATE_CHECK_NAME_PREFIX,
  LEGACY_GATE_CHECK_NAME_PREFIX,
} from "./workflow-naming.js";

export type PrTriggerType =
  | "trigger_pr_created"
  | "trigger_pr_ready"
  | "trigger_pr_updated"
  | "trigger_pr_checks_failed"
  | "trigger_pr_review"
  | "trigger_pr_merged";

export interface TriggerEvent {
  delivery: {
    provider: "github" | "gitlab";
    producer: string;
    /** Provider event source, such as GitLab's merge_request_event pipeline source. */
    source?: string;
    deliveryId: string;
    /** Stable identity of the human action behind this delivery, used for
     * semantic dedup so one review's fan-out of N webhooks starts one run.
     * Derived here at normalization; a later stage consumes it. */
    semanticKey?: string;
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
  /** Exact head previously published by the workflow for this PR. */
  workflowPublishedHeadSha?: string;
  /** Legacy ownership signal used only when the persisted row has no SHA. */
  workflowOwnedPullRequest?: boolean;
}

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
      const legacyWorkflowPush =
        options.workflowOwnedPullRequest === true &&
        !workflowPublishedPush &&
        !options.workflowPublishedHeadSha &&
        vcsLoginsMatch(body?.sender?.login ?? pr.user?.login, options.botLogin);
      if (workflowPublishedPush || legacyWorkflowPush) return null;
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
    const appSlug = check.app?.slug ?? body?.sender?.login ?? "unknown";
    return {
      delivery: githubDelivery(options.deliveryId, appSlug),
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
            checkRunId: check.id,
            appSlug,
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

export function normalizeGitLabEvent(
  eventName: string,
  body: any,
  options: {
    deliveryId?: string;
    botUsername?: string;
    reviewStates?: readonly string[];
    gateCheckNames?: readonly string[];
    workflowPublishedHeadSha?: string;
    workflowOwnedPullRequest?: boolean;
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
          ...mapGitLabMergeRequest(attrs, project),
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
      const oldHead =
        typeof body?.oldrev === "string"
          ? body.oldrev
          : typeof body?.changes?.last_commit?.previous?.id === "string"
            ? body.changes.last_commit.previous.id
            : undefined;
      const nextHead = attrs.last_commit?.id ?? attrs.sha;
      if (oldHead && nextHead && oldHead !== nextHead) {
        const mapped = mapGitLabMergeRequest(attrs, project, body?.user);
        const workflowPublishedPush =
          typeof options.workflowPublishedHeadSha === "string" &&
          options.workflowPublishedHeadSha.length > 0 &&
          mapped.headSha === options.workflowPublishedHeadSha;
        const legacyWorkflowPush =
          options.workflowOwnedPullRequest === true &&
          !workflowPublishedPush &&
          !options.workflowPublishedHeadSha &&
          vcsLoginsMatch(producer, options.botUsername);
        if (workflowPublishedPush || legacyWorkflowPush) return null;
        return {
          delivery: gitLabDelivery(options.deliveryId, producer),
          triggerType: "trigger_pr_updated",
          pr: mapped,
        };
      }
      const previousDraft =
        body?.changes?.draft?.previous ??
        body?.changes?.work_in_progress?.previous;
      const currentDraft = Boolean(attrs.draft ?? attrs.work_in_progress);
      if (previousDraft === true && !currentDraft) {
        return {
          delivery: gitLabDelivery(options.deliveryId, producer),
          triggerType: "trigger_pr_ready",
          pr: mapGitLabMergeRequest(attrs, project, body?.user),
        };
      }
      return null;
    }
    if (action === "reopen" && !Boolean(attrs.draft ?? attrs.work_in_progress)) {
      return {
        delivery: gitLabDelivery(options.deliveryId, producer),
        triggerType: "trigger_pr_ready",
        pr: mapGitLabMergeRequest(attrs, project, body?.user),
      };
    }
    if (action !== "open") return null;
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
      vcsLoginsMatch(producer, options.botUsername) ||
      attrs.action !== "create" ||
      attrs.noteable_type !== "MergeRequest" ||
      attrs.system === true ||
      attrs.internal === true ||
      attrs.confidential === true ||
      hasAiWorkflowCommentMarker(attrs.note)
    ) {
      return null;
    }
    const allowedStates = options.reviewStates ?? DEFAULT_REVIEW_STATES;
    if (!allowedStates.includes("commented")) return null;
    return {
      delivery: {
        ...gitLabDelivery(options.deliveryId, producer),
        ...(typeof attrs.id === "number" ? { semanticKey: `note:${attrs.id}` } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        ...mapGitLabMergeRequest(mr, project),
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
      ? body.builds.filter(
          (build: any) =>
            build?.status === "failed" &&
            !isGateCheckName(build?.name, options.gateCheckNames ?? []),
        )
      : [];
    if (
      Array.isArray(body?.builds) &&
      body.builds.some((build: any) => build?.status === "failed") &&
      failedBuilds.length === 0
    ) {
      return null;
    }
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
      delivery: {
        ...gitLabDelivery(options.deliveryId, "gitlab-ci"),
        ...(typeof attrs.source === "string" ? { source: attrs.source } : {}),
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        provider: "gitlab",
        repoPath: project.path_with_namespace ?? "",
        ...(project.id !== undefined ? { providerProjectId: project.id } : {}),
        prNumber: mr.iid,
        prUrl: mr.url ?? "",
        headRef: mr.source_branch ?? "",
        // Pipeline Hook merge_request objects do not carry a source-head SHA.
        // Dispatch binds it from the authoritative MR read before acceptance.
        headSha: "",
        baseRef: mr.target_branch ?? "",
        title: mr.title ?? "",
        author: body?.user?.username ?? body?.user?.name ?? "unknown",
        isDraft: false,
        ...(typeof attrs.id === "number" ? { pipelineId: attrs.id } : {}),
        failedChecks,
      },
    };
  }

  return null;
}

export function normalizeGitLabEvents(
  eventName: string,
  body: any,
  options: Parameters<typeof normalizeGitLabEvent>[2] = {},
): TriggerEvent[] {
  const primary = normalizeGitLabEvent(eventName, body, options);
  if (!primary) return [];
  const attrs = body?.object_attributes;
  if (
    eventName === "Merge Request Hook" &&
    attrs?.action === "open" &&
    !Boolean(attrs?.draft ?? attrs?.work_in_progress) &&
    primary.triggerType === "trigger_pr_created"
  ) {
    return [{ ...primary, triggerType: "trigger_pr_ready" }, primary];
  }
  if (
    eventName === "Merge Request Hook" &&
    attrs?.action === "update" &&
    primary.triggerType === "trigger_pr_updated"
  ) {
    const previousDraft =
      body?.changes?.draft?.previous ??
      body?.changes?.work_in_progress?.previous;
    const currentDraft = Boolean(attrs?.draft ?? attrs?.work_in_progress);
    if (previousDraft === true && !currentDraft) {
      return [{ ...primary, triggerType: "trigger_pr_ready" }, primary];
    }
  }
  return [primary];
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

function mapGitLabMergeRequest(attrs: any, project: any, fallbackAuthor?: any): PrTriggerPayload {
  return {
    provider: "gitlab",
    repoPath: project.path_with_namespace ?? "",
    ...(project.id !== undefined ? { providerProjectId: project.id } : {}),
    prNumber: attrs.iid,
    prUrl: gitLabMergeRequestUrl(attrs, project),
    headRef: attrs.source_branch ?? "",
    headSha: attrs.last_commit?.id ?? attrs.diff_head_sha ?? "",
    baseRef: attrs.target_branch ?? "",
    title: attrs.title ?? "",
    author: gitLabMergeRequestAuthor(attrs, fallbackAuthor),
    isDraft: isGitLabDraft(attrs),
  };
}

function gitLabMergeRequestUrl(attrs: any, project: any): string {
  const direct = attrs.url ?? attrs.web_url;
  if (typeof direct === "string" && direct.trim()) return direct;
  const projectUrl = typeof project.web_url === "string" ? project.web_url.replace(/\/+$/, "") : "";
  return projectUrl && attrs.iid != null
    ? `${projectUrl}/-/merge_requests/${attrs.iid}`
    : "";
}

function gitLabMergeRequestAuthor(attrs: any, fallback?: any): string {
  const author = attrs.author;
  if (typeof author?.username === "string" && author.username) return author.username;
  if (typeof author?.name === "string" && author.name) return author.name;
  if (typeof attrs.author_username === "string" && attrs.author_username) {
    return attrs.author_username;
  }
  if (attrs.author_id != null) return String(attrs.author_id);
  return fallback?.username ?? fallback?.name ?? "unknown";
}

export function isGateCheckName(
  name: string,
  gateCheckNames: readonly string[],
): boolean {
  if (typeof name !== "string") return false;
  if (gateCheckNames.includes(name)) return true;
  return isManagedGateCheckName(name);
}

function isGitLabDraft(attrs: any): boolean {
  return (
    attrs.draft === true ||
    attrs.work_in_progress === true ||
    /^(draft|wip):/i.test(attrs.title ?? "")
  );
}
