import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AI_WORKFLOW_COMMENT_MARKER, type IntegrationWebhookRequest } from "@integrations/sdk";
import { fixture, FULL_HEAD } from "./test-support";
import {
  receiveBitbucketWebhook,
  signatureMatches,
  type BitbucketPullRequestPayload,
  type BitbucketWebhookLookups,
} from "./webhook";

const SECRET = "a-webhook-secret-for-tests";

/**
 * Bitbucket publishes no signed payloads beyond its two test vectors, so the
 * composed payloads are signed here the way "Validating webhook deliveries"
 * says Bitbucket signs them: `sha256=` and the hex HMAC-SHA256 of the raw
 * body with the secret. The vectors themselves are checked against Bitbucket's
 * own signatures below, which is what keeps this helper honest.
 */
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function delivery(eventKey: string, rawBody: string, headers: Record<string, string> = {}): IntegrationWebhookRequest {
  return {
    method: "POST",
    rawBody,
    headers: {
      "x-event-key": eventKey,
      "x-request-uuid": "{b2a6b0c4-0000-4000-8000-000000000001}",
      "x-hub-signature": sign(rawBody),
      ...headers,
    },
    query: {},
  };
}

/** The API lookups the webhook makes: a full hash for the abbreviated one,
 *  and the open pull requests a build status may be about. */
function lookups(open: BitbucketPullRequestPayload[] = []) {
  const asked: string[] = [];
  const value: BitbucketWebhookLookups = {
    async fullHash(repoPath, hash) {
      asked.push(`${repoPath}@${hash}`);
      return hash === "d3022fc0ca3d" ? FULL_HEAD : hash.padEnd(40, "0");
    },
    async openPullRequests(repoPath) {
      asked.push(`open:${repoPath}`);
      return open;
    },
  };
  return { value, asked };
}

function receive(
  request: IntegrationWebhookRequest,
  options: { botLogin?: string; open?: BitbucketPullRequestPayload[]; secret?: string | undefined } = {},
) {
  const { value, asked } = lookups(options.open);
  return receiveBitbucketWebhook(request, {
    webhookSecret: "secret" in options ? options.secret : SECRET,
    botLogin: options.botLogin,
    lookups: value,
  }).then((reception) => ({ reception, asked }));
}

const created = fixture("pullrequest-created.json");
const comment = fixture("pullrequest-comment-created.json");
const status = fixture("repo-commit-status-updated.json");

test("accepts Bitbucket's own published signatures and refuses one changed byte", () => {
  const { vectors } = JSON.parse(fixture("signed-test-vectors.json")) as {
    vectors: Array<{ secret: string; payload: string; signature: string }>;
  };
  assert.equal(vectors.length, 2);
  for (const vector of vectors) {
    assert.equal(signatureMatches(vector.payload, vector.signature, vector.secret), true);
    assert.equal(signatureMatches(`${vector.payload} `, vector.signature, vector.secret), false);
    assert.equal(signatureMatches(vector.payload, vector.signature.replace("sha256=", "sha1="), vector.secret), false);
    assert.equal(signatureMatches(vector.payload, vector.signature, `${vector.secret}x`), false);
  }
});

test("a delivery Bitbucket itself signed passes verification", async () => {
  const { vectors } = JSON.parse(fixture("signed-test-vectors.json")) as {
    vectors: Array<{ secret: string; payload: string; signature: string }>;
  };
  const vector = vectors[1]!;
  const { reception } = await receive(
    delivery("pullrequest:created", vector.payload, { "x-hub-signature": vector.signature }),
    { secret: vector.secret },
  );
  // Verified, and a body with no repository in it starts nothing.
  assert.equal(reception.kind, "trigger_events");
  assert.deepEqual(reception.kind === "trigger_events" && reception.events, []);
});

test("refuses a delivery without a valid signature, and says when no secret is configured", async () => {
  const forged = await receive(delivery("pullrequest:created", created, { "x-hub-signature": sign(`${created} `) }));
  assert.deepEqual(forged.reception, { kind: "refused", status: 401, reason: "Invalid webhook signature" });
  const unsigned = await receive(delivery("pullrequest:created", created, { "x-hub-signature": "" }));
  assert.equal(unsigned.reception.kind === "refused" && unsigned.reception.status, 401);
  const unconfigured = await receive(delivery("pullrequest:created", created), { secret: undefined });
  assert.equal(unconfigured.reception.kind === "refused" && unconfigured.reception.status, 503);
});

test("an event it does not act on, or a delivery without its request id, is answered and ignored", async () => {
  const push = await receive(delivery("repo:push", created));
  assert.deepEqual(push.reception, {
    kind: "answered",
    response: { status: 202, body: { status: "ignored", reason: "unsupported_event" } },
  });
  const anonymous = await receive(delivery("pullrequest:created", created, { "x-request-uuid": "" }));
  assert.equal(
    anonymous.reception.kind === "answered" && (anonymous.reception.response.body as { reason: string }).reason,
    "missing_delivery_id",
  );
});

test("a created pull request is ready and created, at its full head, with the post-PR gate input", async () => {
  const { reception, asked } = await receive(delivery("pullrequest:created", created));
  assert.equal(reception.kind, "trigger_events");
  if (reception.kind !== "trigger_events") return;
  assert.deepEqual(
    reception.events.map((event) => [event.triggerType, event.delivery.semanticKey ?? null]),
    [
      ["trigger_pr_ready", "ready:workspace_name/repo_name:1"],
      ["trigger_pr_created", null],
    ],
  );
  const pr = reception.events[1]!.pr;
  assert.equal(pr.provider, "bitbucket");
  assert.equal(pr.repoPath, "workspace_name/repo_name");
  assert.equal(pr.prNumber, 1);
  // Bitbucket abbreviates the hash; core compares heads by the full one.
  assert.equal(pr.headSha, FULL_HEAD);
  assert.deepEqual(asked, ["workspace_name/repo_name@d3022fc0ca3d"]);
  assert.equal(pr.headRef, "branch2");
  assert.equal(pr.baseRef, "main");
  assert.equal(pr.author, "user_name");
  assert.equal(pr.isDraft, false);
  assert.equal(reception.events[1]!.delivery.producer, "user_name");
  assert.equal(reception.legacyGate?.action, "opened");
  assert.equal(reception.legacyGate?.headMoved, false);
  assert.equal(reception.legacyGate?.workflowInput.provider, "bitbucket");
  assert.equal(reception.legacyGate?.workflowInput.headSha, FULL_HEAD);
  assert.equal(reception.legacyGate?.workflowInput.body, "Description of pull request");
});

test("an update is keyed by its head, so an edit that moved nothing never starts a second run", async () => {
  const { reception } = await receive(delivery("pullrequest:updated", created));
  assert.equal(reception.kind, "trigger_events");
  if (reception.kind !== "trigger_events") return;
  assert.deepEqual(
    reception.events.map((event) => [event.triggerType, event.delivery.semanticKey]),
    [
      ["trigger_pr_ready", "ready:workspace_name/repo_name:1"],
      ["trigger_pr_updated", `updated:workspace_name/repo_name:1:${FULL_HEAD}`],
    ],
  );
  assert.equal(reception.legacyGate?.headMoved, true);
  assert.equal(reception.legacyGate?.pusher, "user_name");
});

test("a draft is not ready, and a pull request no longer open starts nothing", async () => {
  const payload = JSON.parse(created);
  payload.pullrequest.draft = true;
  const draft = await receive(delivery("pullrequest:created", JSON.stringify(payload)));
  assert.deepEqual(
    draft.reception.kind === "trigger_events" && draft.reception.events.map((event) => event.triggerType),
    ["trigger_pr_created"],
  );
  payload.pullrequest.state = "DECLINED";
  const declined = await receive(delivery("pullrequest:updated", JSON.stringify(payload)));
  assert.deepEqual(declined.reception.kind === "trigger_events" && declined.reception.events, []);
});

test("a merged pull request carries its full merge commit", async () => {
  const payload = JSON.parse(created);
  payload.pullrequest.state = "MERGED";
  payload.pullrequest.merge_commit = { hash: "764413d85e29" };
  const { reception } = await receive(delivery("pullrequest:fulfilled", JSON.stringify(payload)));
  const event = reception.kind === "trigger_events" ? reception.events[0] : undefined;
  assert.equal(event?.triggerType, "trigger_pr_merged");
  assert.equal(event?.pr.mergeSha, "764413d85e29".padEnd(40, "0"));
  assert.equal(reception.kind === "trigger_events" && reception.legacyGate, undefined);
});

test("a person's comment is a review comment about the pull request, not a head", async () => {
  const { reception, asked } = await receive(delivery("pullrequest:comment_created", comment));
  const event = reception.kind === "trigger_events" ? reception.events[0] : undefined;
  assert.equal(event?.triggerType, "trigger_pr_review");
  assert.deepEqual(event?.pr.review, { state: "commented", author: "user_name", body: "Comment text" });
  assert.equal(event?.pr.headSha, "");
  assert.equal(event?.delivery.semanticKey, "comment:workspace_name/repo_name:17");
  assert.deepEqual(asked, []);
});

test("the workflow's own comments start nothing: by the bot account, or by the marker its author wrote", async () => {
  const byBot = await receive(delivery("pullrequest:comment_created", comment), { botLogin: "User Name" });
  assert.deepEqual(byBot.reception.kind === "trigger_events" && byBot.reception.events, []);
  const payload = JSON.parse(comment);
  payload.comment.content.raw = `Automated fix pushed.\n\n${AI_WORKFLOW_COMMENT_MARKER}`;
  const marked = await receive(delivery("pullrequest:comment_created", JSON.stringify(payload)));
  assert.deepEqual(marked.reception.kind === "trigger_events" && marked.reception.events, []);
});

test("a change request is a changes_requested review", async () => {
  const payload = { ...JSON.parse(created), changes_request: { date: "2026-11-10T10:00:00+00:00", user: {} } };
  const { reception } = await receive(delivery("pullrequest:changes_request_created", JSON.stringify(payload)));
  const event = reception.kind === "trigger_events" ? reception.events[0] : undefined;
  assert.deepEqual(event?.pr.review, { state: "changes_requested", author: "user_name", body: "" });
});

test("a failed build status is a failed check on the open pull request whose head it is, trusted by nobody", async () => {
  const head = "9fec847784abb10b2fa567ee63b85bd238955d0e";
  const open = JSON.parse(created).pullrequest as BitbucketPullRequestPayload;
  open.source!.commit!.hash = head.slice(0, 12);
  const other = { ...open, id: 2, source: { ...open.source, commit: { hash: "aaaaaaaaaaaa" } } };
  const { reception } = await receive(delivery("repo:commit_status_updated", status), { open: [open, other] });
  assert.equal(reception.kind, "trigger_events");
  if (reception.kind !== "trigger_events") return;
  assert.equal(reception.events.length, 1);
  const event = reception.events[0]!;
  assert.equal(event.triggerType, "trigger_pr_checks_failed");
  assert.equal(event.pr.prNumber, 1);
  assert.equal(event.pr.headSha, head);
  assert.equal(event.delivery.producer, "mybuildtool");
  assert.equal(event.delivery.trustedByDefault, false);
  assert.deepEqual(event.pr.failedChecks, [
    {
      handle: { kind: "build_status", key: "mybuildtool", commit: head },
      name: "Unit Tests (Python)",
      conclusion: "failed",
      detailsUrl: "https://my-build-tool.com/builds/MY-PROJECT/BUILD-777",
    },
  ]);
});

test("a status that did not fail, or this product's own gate status, is no failed check", async () => {
  const passed = JSON.parse(status);
  passed.commit_status.state = "SUCCESSFUL";
  const success = await receive(delivery("repo:commit_status_updated", JSON.stringify(passed)));
  assert.deepEqual(success.reception.kind === "trigger_events" && success.reception.events, []);
  const gate = JSON.parse(status);
  gate.commit_status.name = "AI Workflow / Review";
  const own = await receive(delivery("repo:commit_status_created", JSON.stringify(gate)));
  assert.deepEqual(own.reception.kind === "trigger_events" && own.reception.events, []);
  assert.deepEqual(own.asked, []);
});
