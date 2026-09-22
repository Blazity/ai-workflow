import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationContext } from "@integrations/sdk";
import type { manifest } from "./manifest";
import { manifest as declared } from "./manifest";
import { receiveGitHubWebhook } from "./webhook";

/**
 * Real bytes, never bytes this package produced.
 *
 * Each file is one recorded GitHub delivery, downloaded verbatim; the
 * `.source.txt` beside it carries the URL, the pinned revision, the date and
 * the digest. The first test below pins the digest as well, so a fixture
 * quietly reshaped to make an assertion pass fails loudly instead.
 */
function recorded(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}.json`, import.meta.url), "utf8");
}

const payload = {
  opened: recorded("pull-request-opened"),
  synchronize: recorded("pull-request-synchronize"),
  closed: recorded("pull-request-closed"),
  checkRunSuccess: recorded("check-run-completed"),
  checkRunFailure: recorded("check-run-completed-failure"),
  reviewSubmitted: recorded("pull-request-review-submitted"),
  reviewComment: recorded("pull-request-review-comment-created"),
  issueComment: recorded("issue-comment-created"),
  renamed: recorded("repository-renamed"),
};

const SECRET = "webhook-secret";

const warn = vi.fn();

function ctx(
  overrides: Partial<Record<string, unknown>> = {},
): IntegrationContext<typeof manifest> {
  return {
    connection: {
      appId: 1,
      installationId: 2,
      privateKey: "key",
      webhookSecret: SECRET,
      botLogin: undefined,
      legacyOwner: undefined,
      legacyRepo: undefined,
      legacyBotLogin: undefined,
      ...overrides,
    },
    http: { fetch },
    log: { debug() {}, info() {}, warn, error() {} },
    signal: AbortSignal.timeout(1_000),
  } as unknown as IntegrationContext<typeof manifest>;
}

function signature(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

async function receive(
  eventName: string,
  rawBody: string,
  options: { connection?: Partial<Record<string, unknown>>; signatureHeader?: string } = {},
) {
  return receiveGitHubWebhook(
    {
      method: "POST",
      rawBody,
      headers: {
        "x-github-event": eventName,
        "x-github-delivery": "4c5f2a80-9b1e-11ee-8c90-0242ac120002",
        "x-hub-signature-256": options.signatureHeader ?? signature(rawBody),
      },
      query: {},
    },
    ctx(options.connection),
  );
}

describe("the recorded GitHub payloads", () => {
  it("are the bytes that were downloaded, unedited", () => {
    const digests = Object.fromEntries(
      Object.entries(payload).map(([name, bytes]) => [
        name,
        createHash("sha256").update(bytes).digest("hex"),
      ]),
    );
    expect(digests).toEqual({
      opened: "d34772e6b4b912586626b71101fd7e9f529943866c895dcb3381ec476003e834",
      synchronize: "f44e3cd19cbaab487e59bfe89ce571661927247c229ccd051238c73f5c014792",
      closed: "938c4ee2271312ff3ce6821bb485a46e414e6ba3c202ca2d8611dd8ebc3128f9",
      checkRunSuccess: "0c8bef19e50e4c66848fe3c109efdf1ccc70429ce9d866beb7c2898af0950aae",
      checkRunFailure: "b50b42ab09c80b3ec5b14c52cde65dd96fc3378d5477d58b13a08c596912771f",
      reviewSubmitted: "3a2b94e3a7a3a9842987f0de9e9475be270986ad94109eb0af59c97e95936658",
      reviewComment: "3fc2e5b79685badc42ead3525f2f6335b5732cd1bed6cc6607679d5c7fbac39b",
      issueComment: "d68665d981f7bcbdaf1d9475a192926a541fdfcb0f371e0cac21dee6cf61e992",
      renamed: "6ba2ed56cf24f20f4f120cc385fce45af4a2688c91e0faaeb03ae04a8dca605d",
    });
  });
});

describe("normalizing a real delivery from its raw bytes", () => {
  it("reads an opened pull request as both ready and created", async () => {
    const result = await receive("pull_request", payload.opened);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events.map((event) => event.triggerType)).toEqual([
      "trigger_pr_ready",
      "trigger_pr_created",
    ]);
    expect(result.events[1]?.pr).toMatchObject({
      provider: "github",
      repoPath: "Codertocat/Hello-World",
      prNumber: 2,
      headRef: "changes",
      headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
      baseRef: "master",
      isDraft: false,
      prUrl: "https://github.com/Codertocat/Hello-World/pull/2",
    });
    expect(result.events[0]?.delivery).toMatchObject({
      provider: "github",
      producer: "Codertocat",
      deliveryId: "4c5f2a80-9b1e-11ee-8c90-0242ac120002",
    });
  });

  it("offers the legacy gate an opened delivery and says the head did not move", async () => {
    const result = await receive("pull_request", payload.opened);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.legacyGate).toMatchObject({
      action: "opened",
      headMoved: false,
      workflowInput: {
        ownerRepo: "Codertocat/Hello-World",
        prNumber: 2,
        headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
        provider: "github",
      },
    });
  });

  it("reads a push to an existing pull request, and tells core the head moved", async () => {
    const result = await receive("pull_request", payload.synchronize);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events.map((event) => event.triggerType)).toEqual(["trigger_pr_updated"]);
    // The head this event carries is what core compares against the sha a run
    // published, so it must be the new one, never the `before`.
    expect(result.events[0]?.pr.headSha).toBe("ec26c3e57ca3a959ca5aad62de7213c562f8c821");
    expect(result.legacyGate?.headMoved).toBe(true);
  });

  it("hands a push by the automation account on, for core to decide about", async () => {
    // Whose push it is cannot be decided here: it takes the ownership record of
    // the pull request, which core holds. This package must therefore emit the
    // event and carry the sender, and `isWorkflowGeneratedPush` drops it. A
    // drop here on the name alone would also silence a push by that account to
    // a pull request no run of ours owns, which is what this asserts.
    const body = JSON.parse(payload.synchronize);
    body.sender.login = "Codertocat[bot]";
    const result = await receive("pull_request", JSON.stringify(body), {
      connection: { botLogin: "codertocat" },
    });
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events.map((event) => event.triggerType)).toEqual(["trigger_pr_updated"]);
    expect(result.events[0]?.delivery.producer).toBe("Codertocat[bot]");
  });

  it("ignores a review the automation account submitted, which needs no record", async () => {
    // The other half of the same question, and the half this package can answer
    // on its own: a comment or review by the automation account is ours by its
    // author alone, with no ownership record involved.
    const body = JSON.parse(payload.reviewSubmitted);
    body.review.user.login = "Codertocat[bot]";
    const result = await receive("pull_request_review", JSON.stringify(body), {
      connection: { botLogin: "codertocat" },
    });
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events).toEqual([]);
  });

  it("still reads a review by a person whose name merely starts the same", async () => {
    const body = JSON.parse(payload.reviewSubmitted);
    body.review.user.login = "codertocat-jr";
    const result = await receive("pull_request_review", JSON.stringify(body), {
      connection: { botLogin: "codertocat" },
    });
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events.map((event) => event.triggerType)).toEqual(["trigger_pr_review"]);
  });

  it("ignores a pull request that closed without merging", async () => {
    const result = await receive("pull_request", payload.closed);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events).toEqual([]);
  });

  it("reads the merged variant of those same bytes as merged, with its merge sha", async () => {
    // The published example closed without merging. Only the two fields GitHub
    // sets on a merge are changed, so everything else is still the real payload.
    const body = JSON.parse(payload.closed);
    body.pull_request.merged = true;
    body.pull_request.merged_at = "2019-05-15T15:20:40Z";
    const result = await receive("pull_request", JSON.stringify(body));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]).toMatchObject({
      triggerType: "trigger_pr_merged",
      pr: {
        mergeSha: "c4295bd74fb0f4fda03689c3df3f2803b658fd85",
        mergedAt: "2019-05-15T15:20:40Z",
      },
    });
  });

  it("ignores a check run that passed", async () => {
    const result = await receive("check_run", payload.checkRunSuccess);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events).toEqual([]);
  });

  it("reads a failed check run as the autofix trigger, keyed on the commit", async () => {
    const result = await receive("check_run", payload.checkRunFailure);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    const event = result.events[0];
    expect(event?.triggerType).toBe("trigger_pr_checks_failed");
    expect(event?.pr).toMatchObject({
      repoPath: "Codertocat/Hello-World",
      prNumber: 2,
      headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
      headRef: "changes",
      baseRef: "master",
    });
    expect(event?.pr.failedChecks?.[0]).toMatchObject({
      name: "Octocoders-linter",
      conclusion: "failure",
      handle: { id: 128620228, owner: "github-actions" },
    });
    // One delivery per failing job, so the key is the commit's verdict.
    expect(event?.delivery.semanticKey).toBe(
      "checks:Codertocat/Hello-World:2:ec26c3e57ca3a959ca5aad62de7213c562f8c821",
    );
    expect(event?.delivery.trustedByDefault).toBe(true);
  });

  it("does not trust a failed check reported by an app that is not the runner", async () => {
    const body = JSON.parse(payload.checkRunFailure);
    body.check_run.app.slug = "some-other-app";
    const result = await receive("check_run", JSON.stringify(body));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]?.delivery.trustedByDefault).toBe(false);
  });

  it("ignores a failed check the post-PR gate created itself", async () => {
    const body = JSON.parse(payload.checkRunFailure);
    body.check_run.name = "AI Workflow / typecheck";
    const result = await receive("check_run", JSON.stringify(body));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events).toEqual([]);
  });

  it("reads a submitted review, keyed on the review so its comments cannot fan out", async () => {
    const result = await receive("pull_request_review", payload.reviewSubmitted);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]).toMatchObject({
      triggerType: "trigger_pr_review",
      delivery: { semanticKey: "review:237895671" },
      pr: { prNumber: 2, review: { state: "commented", author: "Codertocat" } },
    });
  });

  it("reads an inline review comment under its review's key", async () => {
    const result = await receive("pull_request_review_comment", payload.reviewComment);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]).toMatchObject({
      triggerType: "trigger_pr_review",
      delivery: { semanticKey: "review:237895671" },
      pr: {
        review: {
          state: "commented",
          body: "Maybe you should use more emoji on this line.",
        },
      },
    });
  });

  it("gives a reply its own key, so it never coalesces into the review it hangs off", async () => {
    const body = JSON.parse(payload.reviewComment);
    body.comment.in_reply_to_id = 284312629;
    const result = await receive("pull_request_review_comment", JSON.stringify(body));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]?.delivery.semanticKey).toBe("comment:284312630");
  });

  it("ignores a comment this deployment wrote", async () => {
    const body = JSON.parse(payload.reviewComment);
    body.comment.body = "Done.\n\n<!-- ai-workflow:bot -->";
    const result = await receive("pull_request_review_comment", JSON.stringify(body));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events).toEqual([]);
  });

  it("ignores a comment on a plain issue, which this published delivery is", async () => {
    const result = await receive("issue_comment", payload.issueComment);
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events).toEqual([]);
  });

  it("reads a comment on a pull request conversation, head facts left for dispatch", async () => {
    // No published example carries `issue.pull_request`, which is the one field
    // that separates a pull request conversation from an issue, so it is added
    // here in GitHub's own shape and nothing else is touched.
    const body = JSON.parse(payload.issueComment);
    body.issue.pull_request = {
      url: "https://api.github.com/repos/Codertocat/Hello-World/pulls/1",
      html_url: "https://github.com/Codertocat/Hello-World/pull/1",
      diff_url: "https://github.com/Codertocat/Hello-World/pull/1.diff",
      patch_url: "https://github.com/Codertocat/Hello-World/pull/1.patch",
    };
    const result = await receive("issue_comment", JSON.stringify(body));
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.events[0]).toMatchObject({
      triggerType: "trigger_pr_review",
      delivery: { semanticKey: "comment:492700400" },
      pr: {
        prNumber: 1,
        prUrl: "https://github.com/Codertocat/Hello-World/pull/1",
        headSha: "",
        headRef: "",
        review: { state: "commented", author: "Codertocat" },
      },
    });
  });

  it("says a rename happened rather than losing it silently", async () => {
    warn.mockClear();
    const result = await receive("repository", payload.renamed);
    expect(result).toEqual({
      kind: "answered",
      response: { status: 202, body: { status: "ignored", reason: "repository_renamed" } },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Octocoders/Hello-World",
        to: "Octocoders/Hello-World",
      }),
      "trigger_repo_renamed",
    );
  });
});

describe("what a delivery has to prove before anything parses it", () => {
  it("refuses a body whose signature does not match, before reading it", async () => {
    const result = await receive("pull_request", payload.opened, {
      signatureHeader: signature(payload.opened, "another-secret"),
    });
    expect(result).toEqual({
      kind: "refused",
      status: 401,
      reason: "Invalid webhook signature",
    });
  });

  it("refuses a body signed over different bytes", async () => {
    const result = await receive("pull_request", payload.opened, {
      signatureHeader: signature(payload.synchronize),
    });
    expect(result).toEqual({
      kind: "refused",
      status: 401,
      reason: "Invalid webhook signature",
    });
  });

  it("refuses a delivery with no signature at all", async () => {
    const result = await receive("pull_request", payload.opened, { signatureHeader: "" });
    expect(result).toEqual({
      kind: "refused",
      status: 401,
      reason: "Missing X-Hub-Signature-256 header",
    });
  });

  it("says so when this deployment has no secret, rather than accepting anything", async () => {
    const result = await receiveGitHubWebhook(
      {
        method: "POST",
        rawBody: payload.opened,
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "d",
          "x-hub-signature-256": signature(payload.opened),
        },
        query: {},
      },
      ctx({ webhookSecret: undefined }),
    );
    expect(result).toEqual({
      kind: "refused",
      status: 503,
      reason: "GitHub webhook secret is not configured",
    });
  });

  it("ignores a verified delivery that carries no delivery id", async () => {
    const result = await receiveGitHubWebhook(
      {
        method: "POST",
        rawBody: payload.opened,
        headers: {
          "x-github-event": "pull_request",
          "x-hub-signature-256": signature(payload.opened),
        },
        query: {},
      },
      ctx(),
    );
    expect(result).toEqual({
      kind: "answered",
      response: { status: 202, body: { status: "ignored", reason: "missing_delivery_id" } },
    });
  });
});

describe("a deployment that still names one repository", () => {
  it("keeps the legacy gate off every other repository", async () => {
    const result = await receive("pull_request", payload.opened, {
      connection: { legacyOwner: "Codertocat", legacyRepo: "Some-Other-Repo" },
    });
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.legacyGate).toBeUndefined();
    // The definition path is unaffected: the catalog decides that, not this.
    expect(result.events).toHaveLength(2);
  });

  it("still offers the gate its own repository, whatever the case", async () => {
    const result = await receive("pull_request", payload.opened, {
      connection: { legacyOwner: "codertocat", legacyRepo: "hello-world" },
    });
    expect(result.kind).toBe("trigger_events");
    if (result.kind !== "trigger_events") return;
    expect(result.legacyGate?.workflowInput.ownerRepo).toBe("Codertocat/Hello-World");
  });
});

describe("the review states the manifest declares", () => {
  it("are exactly the states a delivery reports a review in", async () => {
    // Core refuses a review trigger whose states none of its providers report,
    // from this declaration alone. A state reported but not declared would be
    // refused though it works; one declared but never reported would be
    // accepted and never start a run.
    const changesRequested = JSON.parse(payload.reviewSubmitted);
    changesRequested.review.state = "changes_requested";
    const deliveries: Array<[string, string]> = [
      ["pull_request_review", payload.reviewSubmitted],
      ["pull_request_review", JSON.stringify(changesRequested)],
      ["pull_request_review_comment", payload.reviewComment],
      ["issue_comment", payload.issueComment],
    ];
    const reported = new Set<string>();
    for (const [eventName, body] of deliveries) {
      const result = await receive(eventName, body);
      if (result.kind !== "trigger_events") continue;
      for (const event of result.events) {
        if (event.pr.review) reported.add(event.pr.review.state);
      }
    }

    expect([...reported].sort()).toEqual([...declared.webhook.reviewStates].sort());
  });
});
