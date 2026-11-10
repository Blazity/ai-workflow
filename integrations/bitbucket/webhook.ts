import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isOurOwnVcsComment,
  type IntegrationWebhook,
  type IntegrationWebhookReception,
  type IntegrationWebhookRequest,
  type PrTriggerPayload,
  type TriggerEvent,
} from "@integrations/sdk";
import {
  accountLogin,
  failedStatusCheck,
  isOwnAccount,
  statusProducer,
  type BitbucketAccount,
  type BitbucketCommitStatus,
} from "./checks";
import { BITBUCKET_WEB, bitbucketClient, repositoryPath } from "./client";
import type { manifest } from "./manifest";

/**
 * The repository webhook's events this integration acts on, by the
 * `X-Event-Key` Bitbucket sends with each (Event payloads, "HTTP headers").
 */
const SUPPORTED_EVENTS = new Set([
  "pullrequest:created",
  "pullrequest:updated",
  "pullrequest:fulfilled",
  "pullrequest:comment_created",
  "pullrequest:changes_request_created",
  "repo:commit_status_created",
  "repo:commit_status_updated",
]);

const FULL_SHA = /^[0-9a-f]{40}$/u;

/** Open pull requests read to find the ones a failed build status is about. */
const OPEN_PULL_REQUESTS_SCANNED = 50;

export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => {
    const client = bitbucketClient({ http: ctx.http, token: ctx.connection.token });
    return receiveBitbucketWebhook(request, {
      webhookSecret: ctx.connection.webhookSecret,
      botLogin: ctx.connection.botLogin,
      lookups: {
        async fullHash(repoPath, hash) {
          if (FULL_SHA.test(hash)) return hash;
          const commit = await client.json<{ hash?: string }>(
            `${repositoryPath(repoPath)}/commit/${encodeURIComponent(hash)}`,
          );
          if (!commit.hash || !FULL_SHA.test(commit.hash)) {
            throw new Error(`Bitbucket did not return a full hash for commit ${hash} in ${repoPath}`);
          }
          return commit.hash;
        },
        async openPullRequests(repoPath) {
          const page = await client.json<{ values?: BitbucketPullRequestPayload[] }>(
            `${repositoryPath(repoPath)}/pullrequests?state=OPEN&pagelen=${OPEN_PULL_REQUESTS_SCANNED}`,
          );
          return page.values ?? [];
        },
      },
      log: ctx.log,
    });
  },
};

/**
 * The provider calls a delivery needs answered that its payload leaves out.
 * Bitbucket abbreviates the commit hashes on a pull request (`d3022fc0ca3d`)
 * where core compares heads by the full hash, and a build status names a
 * commit but no pull request.
 */
export interface BitbucketWebhookLookups {
  fullHash(repoPath: string, hash: string): Promise<string>;
  openPullRequests(repoPath: string): Promise<BitbucketPullRequestPayload[]>;
}

export interface BitbucketPullRequestPayload {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  draft?: boolean;
  author?: BitbucketAccount;
  source?: { branch?: { name?: string }; commit?: { hash?: string } };
  destination?: { branch?: { name?: string }; commit?: { hash?: string } };
  merge_commit?: { hash?: string } | null;
  updated_on?: string;
  links?: { html?: { href?: string } };
}

/**
 * `X-Hub-Signature` is `sha256=<hex>`: the HMAC-SHA256 of the body exactly as
 * sent, keyed with the webhook's secret (Manage webhooks, "Validating webhook
 * deliveries"). Bitbucket says the method may change; a method this does not
 * know is refused rather than guessed.
 */
export function signatureMatches(rawBody: string, header: string | undefined, secret: string): boolean {
  const match = /^sha256=([0-9a-f]{64})$/iu.exec(header?.trim() ?? "");
  if (!match) return false;
  const sent = Buffer.from(match[1]!.toLowerCase(), "hex");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export async function receiveBitbucketWebhook(
  request: IntegrationWebhookRequest,
  options: {
    webhookSecret: string | undefined;
    botLogin: string | undefined;
    lookups: BitbucketWebhookLookups;
    log?: { info(fields: Record<string, unknown>, event: string): void };
  },
): Promise<IntegrationWebhookReception> {
  if (!options.webhookSecret) {
    return { kind: "refused", status: 503, reason: "Webhook secret is not configured" };
  }
  if (!signatureMatches(request.rawBody, request.headers["x-hub-signature"], options.webhookSecret)) {
    return { kind: "refused", status: 401, reason: "Invalid webhook signature" };
  }
  const eventKey = request.headers["x-event-key"] ?? "";
  if (!SUPPORTED_EVENTS.has(eventKey)) return ignored("unsupported_event");
  let body: any;
  try {
    body = request.rawBody ? JSON.parse(request.rawBody) : {};
  } catch {
    return ignored("malformed_payload");
  }
  // The same request UUID on every retry of one delivery (Event payloads,
  // "HTTP headers": X-Attempt-Number counts the attempts).
  const deliveryId = request.headers["x-request-uuid"]?.trim() ?? "";
  if (!deliveryId) return ignored("missing_delivery_id");

  const events = await normalizeBitbucketEvents(eventKey, body, {
    deliveryId,
    botLogin: options.botLogin,
    lookups: options.lookups,
  });
  const gate =
    eventKey === "pullrequest:created" || eventKey === "pullrequest:updated"
      ? legacyGateOf(eventKey, body, events, options.botLogin)
      : undefined;
  return {
    kind: "trigger_events",
    events,
    response: { status: 202, body: { status: events.length > 0 ? "accepted" : "ignored" } },
    ...(gate ? { legacyGate: gate } : {}),
  };
}

function ignored(reason: string): IntegrationWebhookReception {
  return { kind: "answered", response: { status: 202, body: { status: "ignored", reason } } };
}

/**
 * Bitbucket's events as the trigger contract. What Bitbucket cannot say in a
 * payload is handled so that a duplicate never starts a second run:
 *
 * - `pullrequest:updated` fires for a push to the source branch and for an edit
 *   of the title or description alike, and carries no previous head. The
 *   update is keyed by its head (`semanticKey`), so only the first delivery
 *   for a head becomes a trigger.
 * - It carries no previous draft state either. "Ready" is keyed by the pull
 *   request, so it fires once, on the first delivery that shows the pull
 *   request open and not a draft.
 */
async function normalizeBitbucketEvents(
  eventKey: string,
  body: any,
  options: { deliveryId: string; botLogin?: string | undefined; lookups: BitbucketWebhookLookups },
): Promise<TriggerEvent[]> {
  const repository = body?.repository;
  const repoPath: unknown = repository?.full_name;
  if (typeof repoPath !== "string" || !repoPath.includes("/")) return [];
  const actor: BitbucketAccount | undefined = body?.actor;
  const producer = accountLogin(actor, options.botLogin);

  if (eventKey.startsWith("repo:commit_status_")) {
    return commitStatusEvents(body?.commit_status, repoPath, options);
  }

  const pr: BitbucketPullRequestPayload | undefined = body?.pullrequest;
  if (!pr || typeof pr.id !== "number") return [];
  const delivery = (semanticKey?: string) => ({
    provider: "bitbucket",
    producer,
    deliveryId: options.deliveryId,
    ...(semanticKey ? { semanticKey } : {}),
  });

  if (eventKey === "pullrequest:comment_created") {
    const comment = body?.comment;
    const text = comment?.content?.raw;
    if (
      !comment ||
      comment.deleted === true ||
      comment.pending === true ||
      isOwnAccount(comment.user ?? actor, { botLogin: options.botLogin }) ||
      // Ours only when the author wrote the marker, not when they quoted one
      // of ours back: the rule the GitHub and GitLab comment paths use.
      isOurOwnVcsComment(text)
    ) {
      return [];
    }
    return [
      {
        delivery: delivery(typeof comment.id === "number" ? `comment:${repoPath}:${comment.id}` : undefined),
        triggerType: "trigger_pr_review",
        pr: {
          ...mapPullRequest(pr, repoPath, "", options.botLogin),
          review: { state: "commented", author: producer, body: String(text ?? "") },
        },
      },
    ];
  }

  if (eventKey === "pullrequest:changes_request_created") {
    if (isOwnAccount(actor, { botLogin: options.botLogin })) return [];
    const at = typeof body?.changes_request?.date === "string" ? body.changes_request.date : "";
    return [
      {
        delivery: delivery(at ? `changes_request:${repoPath}:${pr.id}:${actor?.uuid ?? producer}:${at}` : undefined),
        triggerType: "trigger_pr_review",
        pr: {
          ...mapPullRequest(pr, repoPath, "", options.botLogin),
          // A change request carries no text: what to change is in the comments.
          review: { state: "changes_requested", author: producer, body: "" },
        },
      },
    ];
  }

  const shortHead = pr.source?.commit?.hash;
  if (!shortHead) return [];
  const headSha = await options.lookups.fullHash(repoPath, shortHead);
  const payload = mapPullRequest(pr, repoPath, headSha, options.botLogin);

  if (eventKey === "pullrequest:fulfilled") {
    const mergeHash = pr.merge_commit?.hash;
    const mergeSha = mergeHash ? await options.lookups.fullHash(repoPath, mergeHash) : undefined;
    return [
      {
        delivery: delivery(),
        triggerType: "trigger_pr_merged",
        pr: {
          ...payload,
          ...(mergeSha ? { mergeSha } : {}),
          ...(typeof pr.updated_on === "string" ? { mergedAt: pr.updated_on } : {}),
        },
      },
    ];
  }

  if (pr.state !== "OPEN") return [];
  const ready: TriggerEvent[] = payload.isDraft
    ? []
    : [{ delivery: delivery(`ready:${repoPath}:${pr.id}`), triggerType: "trigger_pr_ready", pr: payload }];
  if (eventKey === "pullrequest:created") {
    return [...ready, { delivery: delivery(), triggerType: "trigger_pr_created", pr: payload }];
  }
  if (eventKey === "pullrequest:updated") {
    return [
      ...ready,
      {
        delivery: delivery(`updated:${repoPath}:${pr.id}:${headSha}`),
        triggerType: "trigger_pr_updated",
        pr: payload,
      },
    ];
  }
  return [];
}

/**
 * A failed build status, as a failed check on every open pull request whose
 * head is that commit. The status names its commit in `links.commit.href` and
 * no pull request, so the open pull requests are read (the first
 * `OPEN_PULL_REQUESTS_SCANNED`) and matched by head.
 */
async function commitStatusEvents(
  status: (BitbucketCommitStatus & { links?: { commit?: { href?: string } } }) | undefined,
  repoPath: string,
  options: { deliveryId: string; botLogin?: string | undefined; lookups: BitbucketWebhookLookups },
): Promise<TriggerEvent[]> {
  if (!status) return [];
  const commit = status.links?.commit?.href?.split("/").pop() ?? "";
  if (!FULL_SHA.test(commit)) return [];
  const check = failedStatusCheck(status, commit);
  if (!check) return [];
  const pullRequests = await options.lookups.openPullRequests(repoPath);
  return pullRequests
    .filter((pr) => {
      const head = pr.source?.commit?.hash;
      return typeof pr.id === "number" && typeof head === "string" && head.length >= 7 && commit.startsWith(head);
    })
    .map((pr) => ({
      delivery: {
        provider: "bitbucket",
        producer: statusProducer(status),
        // Anybody with write access can post a status under any key, so none
        // is trusted until a workflow names its producer.
        trustedByDefault: false,
        deliveryId: options.deliveryId,
        semanticKey: `checks:${repoPath}:${pr.id}:${commit}`,
      },
      triggerType: "trigger_pr_checks_failed" as const,
      pr: { ...mapPullRequest(pr, repoPath, commit, options.botLogin), failedChecks: [check] },
    }));
}

function mapPullRequest(
  pr: BitbucketPullRequestPayload,
  repoPath: string,
  headSha: string,
  botLogin: string | undefined,
): PrTriggerPayload {
  return {
    provider: "bitbucket",
    repoPath,
    prNumber: pr.id!,
    prUrl: pr.links?.html?.href ?? `${BITBUCKET_WEB}/${repoPath}/pull-requests/${pr.id}`,
    headRef: pr.source?.branch?.name ?? "",
    headSha,
    baseRef: pr.destination?.branch?.name ?? "",
    title: pr.title ?? "",
    author: accountLogin(pr.author, botLogin),
    isDraft: pr.draft === true,
  };
}

/** The post-PR gate's input for an opened or updated pull request. */
function legacyGateOf(
  eventKey: string,
  body: any,
  events: readonly TriggerEvent[],
  botLogin: string | undefined,
): NonNullable<Extract<IntegrationWebhookReception, { kind: "trigger_events" }>["legacyGate"]> | undefined {
  const pr = events.find((event) => event.triggerType !== "trigger_pr_ready")?.pr;
  if (!pr || !pr.prNumber || !pr.headSha || !pr.headRef || !pr.baseRef || !pr.prUrl) return undefined;
  const opened = eventKey === "pullrequest:created";
  return {
    action: opened ? "opened" : "updated",
    // An update may be a push or an edit; Bitbucket does not say which. Read
    // as a push, core checks whether the head is one this product published
    // before it starts the gate, which is the safe direction.
    headMoved: !opened,
    pusher: accountLogin(body?.actor, botLogin),
    workflowInput: {
      prNumber: pr.prNumber,
      headSha: pr.headSha,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      title: pr.title,
      body: String(body?.pullrequest?.description ?? ""),
      author: pr.author,
      isDraft: pr.isDraft,
      url: pr.prUrl,
      ownerRepo: pr.repoPath,
      provider: "bitbucket",
    },
  };
}
