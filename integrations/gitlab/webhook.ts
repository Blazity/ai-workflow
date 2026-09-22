import { createHash, timingSafeEqual } from "node:crypto";
import type {
  IntegrationContext,
  IntegrationWebhook,
  IntegrationWebhookRequest,
  IntegrationWebhookReception,
  PrTriggerPayload,
  TriggerEvent,
  VcsOpaqueHandle,
} from "@integrations/sdk";
import { isOurOwnVcsComment } from "@integrations/sdk";
import type { manifest } from "./manifest";

type GitLabContext = IntegrationContext<typeof manifest>;

const SUPPORTED_EVENTS = new Set(["Merge Request Hook", "Pipeline Hook", "Note Hook"]);

export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => receiveGitLabWebhook(request, ctx),
};

export async function receiveGitLabWebhook(
  request: IntegrationWebhookRequest,
  ctx: GitLabContext,
): Promise<IntegrationWebhookReception> {
  const secret = ctx.connection.webhookSecret;
  if (!secret) return { kind: "refused", status: 503, reason: "Webhook secret is not configured" };
  if (!sameSecret(request.headers["x-gitlab-token"], secret)) {
    return { kind: "refused", status: 401, reason: "Invalid webhook token" };
  }
  const eventName = request.headers["x-gitlab-event"] ?? "";
  if (!SUPPORTED_EVENTS.has(eventName)) {
    return { kind: "answered", response: { status: 202, body: { status: "ignored", reason: "unsupported_event" } } };
  }
  let body: any;
  try {
    body = request.rawBody ? JSON.parse(request.rawBody) : {};
  } catch {
    return { kind: "answered", response: { status: 202, body: { status: "ignored", reason: "malformed_payload" } } };
  }
  const deliveryId = deliveryIdentity(request);
  if (!deliveryId) {
    return { kind: "answered", response: { status: 202, body: { status: "ignored", reason: "missing_delivery_id" } } };
  }
  const events = normalizeGitLabEvents(eventName, body, {
    deliveryId,
    botLogin: ctx.connection.botLogin,
  });
  const legacyGateInputValue = eventName === "Merge Request Hook" ? legacyGateInput(body) : undefined;
  const legacyGate = legacyGateInputValue
    ? {
        action: legacyGateAction(body),
        // GitLab spells a push to an open merge request `update`.
        headMoved: body?.object_attributes?.action === "update",
        // The account whose action produced this delivery, which is who pushed.
        // The merge request's author is somebody else on every human push to a
        // merge request this product opened.
        pusher: body?.user?.username ?? legacyGateInputValue.author,
        workflowInput: legacyGateInputValue,
      }
    : undefined;
  return {
    kind: "trigger_events",
    events,
    response: { status: 202, body: { status: events.length > 0 ? "accepted" : "ignored" } },
    ...(legacyGate ? { legacyGate } : {}),
  };
}

function sameSecret(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function deliveryIdentity(request: IntegrationWebhookRequest): string {
  const direct = request.headers["webhook-id"]?.trim() || request.headers["idempotency-key"]?.trim();
  if (direct) return direct;
  const uuid = request.headers["x-gitlab-event-uuid"]?.trim();
  return uuid
    ? createHash("sha256").update(`${uuid}\0`).update(request.rawBody).digest("hex")
    : "";
}

export function normalizeGitLabEvents(
  eventName: string,
  body: any,
  options: NormalizeGitLabOptions = {},
): TriggerEvent[] {
  const primary = normalizeGitLabEvent(eventName, body, options);
  if (!primary) return [];
  const attrs = body?.object_attributes;
  if (
    eventName === "Merge Request Hook" &&
    attrs?.action === "open" &&
    !(attrs?.draft ?? attrs?.work_in_progress) &&
    primary.triggerType === "trigger_pr_created"
  ) return [{ ...primary, triggerType: "trigger_pr_ready" }, primary];
  if (
    eventName === "Merge Request Hook" &&
    attrs?.action === "update" &&
    primary.triggerType === "trigger_pr_updated" &&
    (body?.changes?.draft?.previous ?? body?.changes?.work_in_progress?.previous) === true &&
    !(attrs?.draft ?? attrs?.work_in_progress)
  ) return [{ ...primary, triggerType: "trigger_pr_ready" }, primary];
  return [primary];
}

/**
 * There is deliberately no option here for the SHA a run published. Whether a
 * push is one of ours is decided by core, which owns the ownership record this
 * integration cannot see, in `isWorkflowGeneratedPush`
 * (`services/publication/workflow-push-suppression.ts`) on the answer this
 * normalizer returns. What stays here is the one thing GitLab knows on its own:
 * the note or push carries the automation account's username.
 */
export interface NormalizeGitLabOptions {
  deliveryId?: string;
  botLogin?: string;
  botUsername?: string;
  reviewStates?: readonly string[];
  gateCheckNames?: readonly string[];
}

export function normalizeGitLabEvent(
  eventName: string,
  body: any,
  options: NormalizeGitLabOptions = {},
): TriggerEvent | null {
  const producer = body?.user?.username ?? body?.user?.name ?? "unknown";
  if (eventName === "Merge Request Hook") {
    if (body?.object_kind !== "merge_request") return null;
    const attrs = body?.object_attributes;
    const project = body?.project;
    if (!attrs || !project || attrs.system === true) return null;
    const pr = mapMergeRequest(attrs, project, body?.user);
    if (attrs.action === "merge") {
      return event(options.deliveryId, producer, "trigger_pr_merged", {
        ...pr,
        ...(typeof attrs.merge_commit_sha === "string" ? { mergeSha: attrs.merge_commit_sha } : {}),
        ...(
          typeof (attrs.merged_at ?? attrs.actioned_at ?? attrs.updated_at) === "string"
            ? { mergedAt: attrs.merged_at ?? attrs.actioned_at ?? attrs.updated_at }
            : {}
        ),
      });
    }
    if (attrs.action === "update") {
      const oldHead = body?.oldrev ?? body?.changes?.last_commit?.previous?.id;
      const nextHead = attrs.last_commit?.id ?? attrs.sha;
      if (oldHead && nextHead && oldHead !== nextHead) {
        // Deliberately not dropped on the pusher's name alone, which is what
        // S10 did here and what the GitHub half never did. Whether a push is
        // one of ours is `isWorkflowGeneratedPush`
        // (`services/publication/workflow-push-suppression.ts`), which reads
        // the ownership record this package cannot see and treats identity as
        // a backstop to the published head rather than as a rule of its own.
        // One rule for both providers, and the one both had before S10.
        return event(options.deliveryId, producer, "trigger_pr_updated", pr);
      }
      if (
        (body?.changes?.draft?.previous ?? body?.changes?.work_in_progress?.previous) === true &&
        !(attrs.draft ?? attrs.work_in_progress)
      ) return event(options.deliveryId, producer, "trigger_pr_ready", pr);
      return null;
    }
    if (attrs.action === "reopen" && !pr.isDraft) {
      return event(options.deliveryId, producer, "trigger_pr_ready", pr);
    }
    if (attrs.action !== "open") return null;
    return event(options.deliveryId, producer, "trigger_pr_created", pr);
  }

  if (eventName === "Note Hook") {
    const attrs = body?.object_attributes;
    const reviewStates = options.reviewStates ?? ["commented"];
    if (
      body?.object_kind !== "note" || !attrs || !body?.merge_request || !body?.project ||
      attrs.action !== "create" || attrs.noteable_type !== "MergeRequest" ||
      attrs.system === true || attrs.internal === true || attrs.confidential === true ||
      !reviewStates.includes("commented") ||
      sameLogin(producer, options.botLogin ?? options.botUsername) ||
      // Ours only when the author wrote the marker, not when they quoted one of
      // ours back at us: the same rule the GitHub comment paths use, and the
      // reason a reviewer's "this still does not work" reply is not silently
      // dropped. It already covers the ledger family, so no second check.
      isOurOwnVcsComment(attrs.note)
    ) return null;
    return {
      ...event(options.deliveryId, producer, "trigger_pr_review", {
        ...mapMergeRequest(body.merge_request, body.project),
        review: { state: "commented", author: producer, body: String(attrs.note ?? "") },
      }),
      delivery: {
        ...delivery(options.deliveryId, producer),
        ...(typeof attrs.id === "number" ? { semanticKey: `note:${attrs.id}` } : {}),
      },
    };
  }

  if (eventName === "Pipeline Hook") {
    const attrs = body?.object_attributes;
    const mr = body?.merge_request;
    const project = body?.project;
    if (body?.object_kind !== "pipeline" || !attrs || !mr || !project || attrs.status !== "failed") return null;
    const failed = Array.isArray(body?.builds)
      ? body.builds.filter((build: any) => build?.status === "failed")
      : [];
    const configuredGateNames = new Set(options.gateCheckNames ?? []);
    const external = failed.filter((build: any) => {
      const name = String(build?.name ?? "");
      return !configuredGateNames.has(name) &&
        !name.startsWith("AI Workflow / ") &&
        !name.startsWith("blazebot / ");
    });
    if (failed.length > 0 && external.length === 0) return null;
    const checks = external.length > 0
      ? external.map((build: any) => ({
          handle: gitLabHandle({ kind: "job", container: attrs.id ?? null, id: build.id ?? null }),
          name: String(build.name ?? "job"),
          conclusion: String(build.status),
        }))
      : [{
          handle: gitLabHandle({ kind: "aggregate", id: attrs.id ?? null }),
          name: "pipeline",
          conclusion: "failed",
        }];
    return {
      delivery: {
        ...delivery(options.deliveryId, "gitlab-ci"),
        trustedByDefault: attrs.source === "merge_request_event",
        ...(typeof attrs.source === "string" ? { source: attrs.source } : {}),
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...mapMergeRequest(mr, project, body?.user),
        headSha: attrs.sha ?? mr.last_commit?.id ?? mr.diff_head_sha ?? "",
        failedChecks: checks,
      },
    };
  }
  return null;
}

function gitLabHandle(value: Readonly<Record<string, string | number | null>>): VcsOpaqueHandle {
  return value as unknown as VcsOpaqueHandle;
}

function event(
  deliveryId: string | undefined,
  producer: string,
  triggerType: TriggerEvent["triggerType"],
  pr: PrTriggerPayload,
): TriggerEvent {
  return { delivery: delivery(deliveryId, producer), triggerType, pr };
}

function delivery(deliveryId: string | undefined, producer: string) {
  return { provider: "gitlab", producer, deliveryId: deliveryId ?? "" };
}

function mapMergeRequest(attrs: any, project: any, fallback?: any): PrTriggerPayload {
  const projectUrl = typeof project.web_url === "string" ? project.web_url.replace(/\/+$/u, "") : "";
  return {
    provider: "gitlab",
    repoPath: project.path_with_namespace ?? "",
    ...(project.id !== undefined ? { providerProjectId: project.id } : {}),
    prNumber: attrs.iid,
    prUrl: attrs.url ?? attrs.web_url ?? (projectUrl && attrs.iid != null ? `${projectUrl}/-/merge_requests/${attrs.iid}` : ""),
    headRef: attrs.source_branch ?? "",
    headSha: attrs.last_commit?.id ?? attrs.diff_head_sha ?? "",
    baseRef: attrs.target_branch ?? "",
    title: attrs.title ?? "",
    author:
      attrs.author?.username ??
      attrs.author_username ??
      (attrs.author_id == null ? undefined : String(attrs.author_id)) ??
      fallback?.username ??
      "unknown",
    isDraft: Boolean(attrs.draft ?? attrs.work_in_progress) || /^(draft|wip):/iu.test(attrs.title ?? ""),
  };
}

function legacyGateInput(body: any) {
  const attrs = body?.object_attributes;
  const action = attrs?.action === "open" ? "opened" : attrs?.action === "reopen" ? "reopened" : attrs?.action;
  if (!attrs || !body?.project || !["opened", "reopened", "update"].includes(action)) return;
  const pr = mapMergeRequest(attrs, body.project, body.user);
  if (!pr.prNumber || !pr.headSha || !pr.headRef || !pr.baseRef || !pr.prUrl || !pr.repoPath) return;
  return {
    prNumber: pr.prNumber,
    headSha: pr.headSha,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    title: pr.title,
    body: attrs.description ?? "",
    author: pr.author,
    isDraft: pr.isDraft,
    url: pr.prUrl,
    ownerRepo: pr.repoPath,
    provider: "gitlab" as const,
  };
}

function legacyGateAction(body: any): string {
  const action = body?.object_attributes?.action;
  return action === "open" ? "opened" : action === "reopen" ? "reopened" : String(action ?? "");
}

function sameLogin(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
}
