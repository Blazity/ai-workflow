import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  IntegrationContext,
  IntegrationWebhook,
  IntegrationWebhookRequest,
  IntegrationWebhookReception,
  PrTriggerPayload,
  TriggerEvent,
} from "@integrations/sdk";
import { isManagedGateCheckName, isOurOwnVcsComment } from "@integrations/sdk";
import type { manifest } from "./manifest";
import { checkRunHandle, isTrustedByDefaultCheckProducer } from "./handles";
import { vcsLoginsMatch } from "./review-markers";

type GitHubContext = IntegrationContext<typeof manifest>;

/**
 * What a GitHub delivery to `/webhooks/github` means.
 *
 * The URL and the signature scheme are unchanged from before S11, so nothing at
 * GitHub's end has to be edited for this release. What changed is where the
 * knowledge lives: the signature, the event names, the payload shape and the
 * check-run vocabulary are this package's, and core receives only normalized
 * trigger events.
 *
 * Two things core still decides and this file deliberately does not:
 *
 * - **Whether a push is one of ours.** That needs the ownership record of the
 *   pull request, which lives in core's database. This file emits
 *   `trigger_pr_updated` and core suppresses it in `isWorkflowGeneratedPush`
 *   (`services/publication/workflow-push-suppression.ts`). The one half GitHub
 *   knows on its own, that the sender is the automation account, stays here.
 * - **Whether the repository is enabled.** The catalog is core's.
 */

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out"]);

const GATE_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened"]);

export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => receiveGitHubWebhook(request, ctx),
};

export async function receiveGitHubWebhook(
  request: IntegrationWebhookRequest,
  ctx: GitHubContext,
): Promise<IntegrationWebhookReception> {
  const secret = ctx.connection.webhookSecret;
  if (!secret) {
    return { kind: "refused", status: 503, reason: "GitHub webhook secret is not configured" };
  }
  const signature = verifySignature(
    request.rawBody,
    request.headers["x-hub-signature-256"],
    secret,
  );
  if (signature) return { kind: "refused", status: 401, reason: signature };

  const deliveryId = request.headers["x-github-delivery"]?.trim() ?? "";
  if (!deliveryId) {
    return answered("ignored", "missing_delivery_id");
  }

  let body: any;
  try {
    body = request.rawBody ? JSON.parse(request.rawBody) : {};
  } catch {
    return answered("ignored", "malformed_payload");
  }
  if (!body?.repository) return answered("ignored", "malformed_payload");

  const eventName = request.headers["x-github-event"] ?? "";
  const ownerRepo = repositoryPath(body.repository);

  if (eventName === "repository" && body.action === "renamed") {
    reportRename(ctx, body, ownerRepo);
    return answered("ignored", "repository_renamed");
  }

  const events = normalizeGitHubEvents(eventName, body, {
    deliveryId,
    botLogin: ctx.connection.botLogin,
    ...(reviewStatesFor(eventName) ? { reviewStates: reviewStatesFor(eventName)! } : {}),
  });

  const gate = legacyGate(body, ownerRepo, ctx.connection);
  return {
    kind: "trigger_events",
    events,
    response: { status: 202, body: { status: events.length > 0 ? "accepted" : "ignored" } },
    ...(gate ? { legacyGate: gate } : {}),
  };
}

/** The empty string when the signature is good, the refusal sentence otherwise. */
function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
): string {
  if (!header) return "Missing X-Hub-Signature-256 header";
  const [method, receivedHex] = header.split("=", 2);
  if (method !== "sha256" || !receivedHex) return "Malformed X-Hub-Signature-256 header";
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const received = Buffer.from(receivedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return "Invalid webhook signature";
  }
  return "";
}

/**
 * A rename changes `repository.full_name`, which is the key every definition
 * repository pin is stored under, so a workflow pinned to the old path silently
 * stops seeing that repository's events. Silent loss is the failure mode nobody
 * can debug, so it is said out loud.
 *
 * Detection only, on purpose: rewriting an operator's pin from a webhook would
 * move a scope nobody asked to change.
 */
function reportRename(ctx: GitHubContext, body: any, ownerRepo: string): void {
  // The payload carries only the old short name, while a pin holds the full path.
  const previous = body?.changes?.repository?.name?.from;
  const from =
    typeof previous === "string" && previous.trim() !== ""
      ? `${ownerRepo.split("/")[0]}/${previous}`
      : "unknown";
  const to =
    typeof body.repository?.full_name === "string" ? body.repository.full_name : ownerRepo;
  ctx.log.warn(
    {
      from,
      to,
      message:
        `Repository renamed from ${from} to ${to}. Workflows pinned to the old path stop ` +
        "receiving its events until an operator updates the pin.",
    },
    "trigger_repo_renamed",
  );
}

function answered(
  status: "ignored",
  reason: string,
): IntegrationWebhookReception {
  return { kind: "answered", response: { status: 202, body: { status, reason } } };
}

/**
 * Which review states a delivery may fire a run for.
 *
 * A comment body is untrusted text that a fix agent would hand to a
 * full-permission agent, so "commented" is only ever allowed for the event
 * kinds that can carry nothing else. A review submission defaults to the safe
 * pair the dispatcher then filters again against the enabled node's own `on`
 * parameter.
 */
function reviewStatesFor(eventName: string): readonly string[] | undefined {
  if (eventName === "pull_request_review") return ["changes_requested", "commented"];
  if (eventName === "pull_request_review_comment" || eventName === "issue_comment") {
    return ["commented"];
  }
  return undefined;
}

export interface NormalizeGitHubOptions {
  deliveryId?: string;
  botLogin?: string;
  reviewStates?: readonly string[];
}

const DEFAULT_REVIEW_STATES: readonly string[] = ["changes_requested"];

/**
 * One delivery may satisfy more than one trigger contract: a newly opened
 * non-draft pull request is both created and ready. Core consumes these in
 * order and lets exactly one eligible definition claim the delivery.
 */
export function normalizeGitHubEvents(
  eventName: string,
  body: any,
  options: NormalizeGitHubOptions = {},
): TriggerEvent[] {
  const primary = normalizeGitHubEvent(eventName, body, options);
  if (!primary) return [];
  if (
    eventName === "pull_request" &&
    body?.action === "opened" &&
    body?.pull_request?.draft !== true &&
    primary.triggerType === "trigger_pr_created"
  ) {
    return [{ ...primary, triggerType: "trigger_pr_ready" }, primary];
  }
  return [primary];
}

export function normalizeGitHubEvent(
  eventName: string,
  body: any,
  options: NormalizeGitHubOptions = {},
): TriggerEvent | null {
  const repo = body?.repository;
  if (!repo) return null;

  if (eventName === "pull_request") {
    const action = body?.action;
    const pr = body?.pull_request;
    if (!pr) return null;
    const sender = body?.sender?.login ?? pr.user?.login;
    if (action === "closed") {
      if (pr.merged !== true) return null;
      return {
        delivery: delivery(options.deliveryId, sender),
        triggerType: "trigger_pr_merged",
        pr: {
          ...mapPullRequest(pr, repo),
          ...(typeof pr.merge_commit_sha === "string" ? { mergeSha: pr.merge_commit_sha } : {}),
          ...(typeof pr.merged_at === "string" ? { mergedAt: pr.merged_at } : {}),
        },
      };
    }
    if (action === "ready_for_review") {
      return {
        delivery: delivery(options.deliveryId, sender),
        triggerType: "trigger_pr_ready",
        pr: mapPullRequest(pr, repo),
      };
    }
    if (action === "synchronize") {
      // Deliberately not dropped on the sender's name alone. Whether a push is
      // one of ours is `isWorkflowGeneratedPush`
      // (`services/publication/workflow-push-suppression.ts`), which reads the
      // ownership record this package cannot see and treats identity as a
      // backstop to the published head rather than as a rule of its own. A
      // drop here would also silence a push by the automation account to a pull
      // request no run of ours owns.
      return {
        delivery: delivery(options.deliveryId, sender),
        triggerType: "trigger_pr_updated",
        pr: mapPullRequest(pr, repo),
      };
    }
    if (action === "reopened" && pr.draft !== true) {
      return {
        delivery: delivery(options.deliveryId, sender),
        triggerType: "trigger_pr_ready",
        pr: mapPullRequest(pr, repo),
      };
    }
    if (action !== "opened") return null;
    return {
      delivery: delivery(options.deliveryId, sender),
      triggerType: "trigger_pr_created",
      pr: mapPullRequest(pr, repo),
    };
  }

  if (eventName === "check_run") {
    if (body?.action !== "completed") return null;
    const check = body?.check_run;
    if (!check) return null;
    if (!FAILED_CONCLUSIONS.has(check.conclusion)) return null;
    // Our own gate's check. Every configured gate name is built from the
    // SDK's two prefixes (`gateCheckNameAliases` in core), so the prefix rule
    // covers the configured list as well.
    if (isManagedGateCheckName(check.name)) return null;
    if (typeof check.id !== "number") return null;
    const prs = check.pull_requests;
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const prRef = prs[0];
    const prNumber = prRef.number;
    const headSha = prRef.head?.sha ?? check.head_sha ?? "";
    const repoPath = repositoryPath(repo);
    const appSlug = check.app?.slug ?? body?.sender?.login ?? "unknown";
    return {
      delivery: {
        ...delivery(options.deliveryId, appSlug),
        trustedByDefault: isTrustedByDefaultCheckProducer(appSlug),
        // GitHub sends one check_run delivery per failing job, so a commit with
        // five failing jobs fans out into five deliveries. Keying on the
        // commit's verdict rather than the job coalesces that fan-out into one
        // run. The repository is part of the key because the
        // (provider, semanticKey) uniqueness has no repository column and a
        // fork can share a head sha with its upstream. A later push produces a
        // different head sha and so a new key. With an unknown sha the key is
        // left unset rather than degenerating into one that would coalesce
        // every such delivery for this pull request for ever.
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
            // The app's own slug, and not `appSlug`: that falls back to the
            // sender's login, which is right for the producer and the trust
            // decision above and wrong here. The head read mints this handle
            // from `GET /commits/{ref}/check-runs`, which knows no sender, so a
            // check run whose `app` carries no slug would mint two handles that
            // never compare equal, and the autofix path would go silent on it.
            handle: checkRunHandle({ id: check.id, appSlug: check.app?.slug }),
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
    const allowed = options.reviewStates ?? DEFAULT_REVIEW_STATES;
    if (!allowed.includes(review.state)) return null;
    if (vcsLoginsMatch(review.user?.login, options.botLogin)) return null;
    return {
      delivery: {
        ...delivery(options.deliveryId, review.user?.login),
        ...(typeof review.id === "number" ? { semanticKey: `review:${review.id}` } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        ...mapPullRequest(pr, repo),
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
    if (!(options.reviewStates ?? DEFAULT_REVIEW_STATES).includes("commented")) return null;
    if (vcsLoginsMatch(comment.user?.login, options.botLogin)) return null;
    if (comment.user?.type === "Bot") return null;
    if (isOurComment(comment.body)) return null;
    // GitHub wraps inline comments in a review container, so N sibling comments
    // and the review submission that carried them share one semantic key. A
    // reply is its own human action and must never coalesce into the review it
    // hangs off, whose key that submission already consumed.
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
        ...delivery(options.deliveryId, comment.user?.login),
        ...(semanticKey ? { semanticKey } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        ...mapPullRequest(pr, repo),
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
    // `issue.pull_request` is present only when the issue is a pull request
    // conversation; a plain issue comment is not ours to act on.
    if (!comment || !issue?.pull_request) return null;
    if (!(options.reviewStates ?? DEFAULT_REVIEW_STATES).includes("commented")) return null;
    if (vcsLoginsMatch(comment.user?.login, options.botLogin)) return null;
    if (comment.user?.type === "Bot") return null;
    if (isOurComment(comment.body)) return null;
    return {
      delivery: {
        ...delivery(options.deliveryId, comment.user?.login),
        ...(typeof comment.id === "number" ? { semanticKey: `comment:${comment.id}` } : {}),
      },
      triggerType: "trigger_pr_review",
      pr: {
        // An issue_comment carries no pull_request object, so the head facts
        // are unknown here and dispatch binds the authoritative values before
        // acceptance.
        provider: "github",
        repoPath: repositoryPath(repo),
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

/**
 * The input the legacy post-PR gate runs on, when this delivery is one it used
 * to run on.
 *
 * `headMoved` is how core knows whether to ask its ownership record about this
 * delivery before starting the gate: only a push to an existing pull request
 * can be a push of ours. Core must not read `action`, which is GitHub's word.
 */
function legacyGate(
  body: any,
  ownerRepo: string,
  connection: GitHubContext["connection"],
):
  | {
      action: string;
      headMoved: boolean;
      pusher: string;
      workflowInput: {
        prNumber: number;
        headSha: string;
        headRef: string;
        baseRef: string;
        title: string;
        body: string;
        author: string;
        isDraft: boolean;
        url: string;
        ownerRepo: string;
        provider: "github";
      };
    }
  | undefined {
  const pr = body?.pull_request;
  const action = body?.action;
  if (!pr || !GATE_ACTIONS.has(action)) return undefined;
  // A deployment that still names one repository keeps meaning it: a delivery
  // from anywhere else never reaches the legacy gate, exactly as before.
  if (connection.legacyOwner && connection.legacyRepo) {
    const expected = `${connection.legacyOwner}/${connection.legacyRepo}`;
    if (ownerRepo.toLowerCase() !== expected.toLowerCase()) return undefined;
  }
  return {
    action,
    headMoved: action === "synchronize",
    // The account that pushed, which on a pull request we opened is the only
    // thing that tells a human's push from our own.
    pusher: body?.sender?.login ?? pr.user?.login ?? "unknown",
    workflowInput: {
      prNumber: pr.number,
      headSha: pr.head?.sha ?? "",
      headRef: pr.head?.ref ?? "",
      baseRef: pr.base?.ref ?? "",
      title: pr.title ?? "",
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      isDraft: !!pr.draft,
      url: pr.html_url,
      ownerRepo,
      provider: "github" as const,
    },
  };
}

function delivery(deliveryId: string | undefined, producer: string | undefined) {
  return {
    provider: "github",
    producer: producer ?? "unknown",
    deliveryId: deliveryId ?? "",
  };
}

function repositoryPath(repo: any): string {
  return `${repo?.owner?.login}/${repo?.name}`;
}

function mapPullRequest(pr: any, repo: any): PrTriggerPayload {
  return {
    provider: "github",
    repoPath: repositoryPath(repo),
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

/**
 * Ours by what the author wrote, not by a marker anywhere in the body.
 *
 * "Quote reply" copies our marker into a person's own comment, and dropping
 * that person here starts no run at all, so their request goes nowhere with
 * nothing to look at. The rule is the SDK's, shared with core, and it covers
 * every marker family rather than the bot marker alone: our review findings
 * carry no bot marker and still must not fire a trigger.
 */
function isOurComment(body: unknown): boolean {
  return isOurOwnVcsComment(body);
}
