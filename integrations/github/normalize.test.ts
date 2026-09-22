import { describe, it, expect } from "vitest";
import {
  normalizeGitHubEvent,
  normalizeGitHubEvents,
} from "./webhook.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "./review-markers.js";

/** A reply exactly as the ledger settler posts it into a review thread. */
function settlerReply(threadId: string): string {
  const marker = `<!-- ai-workflow:ledger:${threadId} --> ${AI_WORKFLOW_COMMENT_MARKER}`;
  return `Addressed in \`deadbeef\`.\nAdded the null check.\n\n${marker}`;
}

/** One of our own notes on a pull request, marker and all. */
const OUR_OWN_NOTE = `Automated fix pushed: 2 files changed.\n\n${AI_WORKFLOW_COMMENT_MARKER}`;

/**
 * What "Quote reply" produces: the body being answered copied line by line
 * behind a `>`, marker included, then the reviewer's own words. Built from the
 * note it quotes, so the fixture cannot drift from what we actually post.
 */
function quoteReply(quoted: string, written: string): string {
  return [
    ...quoted.split("\n").map((line) => (line ? `> ${line}` : ">")),
    "",
    written,
  ].join("\n");
}

const options = {
  botLogin: "blazebot[bot]",
  deliveryId: "github-delivery-1",
};

function githubRepo() {
  return { owner: { login: "acme" }, name: "app", html_url: "https://github.com/acme/app" };
}

function githubPr(overrides: Record<string, any> = {}) {
  return {
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    head: { ref: "blazebot/aiw-1", sha: "abc123" },
    base: { ref: "main" },
    title: "Fix things",
    user: { login: "blazebot[bot]" },
    draft: false,
    ...overrides,
  };
}

describe("normalizeGitHubEvent", () => {
  it("maps pull_request opened to trigger_pr_created", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      { action: "opened", repository: githubRepo(), pull_request: githubPr() },
      options,
    );
    expect(evt).toEqual({
      delivery: {
        provider: "github",
        producer: "blazebot[bot]",
        deliveryId: "github-delivery-1",
      },
      triggerType: "trigger_pr_created",
      pr: {
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        headRef: "blazebot/aiw-1",
        headSha: "abc123",
        baseRef: "main",
        title: "Fix things",
        author: "blazebot[bot]",
        isDraft: false,
      },
    });
  });

  it("offers ready before created for one non-draft open delivery", () => {
    expect(
      normalizeGitHubEvents(
        "pull_request",
        { action: "opened", repository: githubRepo(), pull_request: githubPr() },
        options,
      ).map((event) => event.triggerType),
    ).toEqual(["trigger_pr_ready", "trigger_pr_created"]);
  });

  it("maps a non-draft reopened pull request to trigger_pr_ready", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      { action: "reopened", repository: githubRepo(), pull_request: githubPr() },
      options,
    );
    expect(evt?.triggerType).toBe("trigger_pr_ready");
  });

  it("maps a merged pull request to trigger_pr_merged with merge metadata", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      {
        action: "closed",
        repository: githubRepo(),
        pull_request: githubPr({
          merged: true,
          merge_commit_sha: "merge123",
          merged_at: "2026-07-17T10:00:00Z",
        }),
      },
      options,
    );

    expect(evt?.triggerType).toBe("trigger_pr_merged");
    expect(evt?.pr).toMatchObject({
      headSha: "abc123",
      mergeSha: "merge123",
      mergedAt: "2026-07-17T10:00:00Z",
    });
  });

  it("ignores a closed pull request that was not merged", () => {
    expect(
      normalizeGitHubEvent(
        "pull_request",
        { action: "closed", repository: githubRepo(), pull_request: githubPr({ merged: false }) },
        options,
      ),
    ).toBeNull();
  });

  it("maps a changed head to trigger_pr_updated", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      { action: "synchronize", repository: githubRepo(), pull_request: githubPr() },
      options,
    );
    expect(evt?.triggerType).toBe("trigger_pr_updated");
  });

  it("passes the draft flag through", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      { action: "opened", repository: githubRepo(), pull_request: githubPr({ draft: true }) },
      options,
    );
    expect(evt?.pr.isDraft).toBe(true);
  });

  it("maps a failed check_run to trigger_pr_checks_failed", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          id: 101,
          app: { slug: "github-actions" },
          name: "ci / build",
          conclusion: "failure",
          details_url: "https://ci/run/1",
          head_sha: "abc123",
          pull_requests: [
            { number: 7, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
          ],
        },
      },
      options,
    );
    expect(evt).toEqual({
      delivery: {
        provider: "github",
        producer: "github-actions",
        deliveryId: "github-delivery-1",
        trustedByDefault: true,
        semanticKey: "checks:acme/app:7:abc123",
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        headRef: "blazebot/aiw-1",
        headSha: "abc123",
        baseRef: "main",
        title: "",
        author: "unknown",
        isDraft: false,
        failedChecks: [
          {
            name: "ci / build",
            conclusion: "failure",
            detailsUrl: "https://ci/run/1",
            handle: { id: 101, owner: "github-actions" },
          },
        ],
      },
    });
  });

  it("gives two failing check_run deliveries for different jobs on the same PR and head sha the same semantic key", () => {
    const buildCheckRun = (checkRunId: number, name: string) =>
      normalizeGitHubEvent(
        "check_run",
        {
          action: "completed",
          repository: githubRepo(),
          check_run: {
            id: checkRunId,
            app: { slug: "github-actions" },
            name,
            conclusion: "failure",
            head_sha: "abc123",
            pull_requests: [
              { number: 7, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
            ],
          },
        },
        options,
      );
    const first = buildCheckRun(101, "ci / build");
    const second = buildCheckRun(102, "ci / lint");
    expect(first?.delivery.semanticKey).toBe("checks:acme/app:7:abc123");
    expect(second?.delivery.semanticKey).toBe(first?.delivery.semanticKey);
  });

  it("gives a check_run delivery on a different head sha a different semantic key", () => {
    const buildCheckRun = (sha: string) =>
      normalizeGitHubEvent(
        "check_run",
        {
          action: "completed",
          repository: githubRepo(),
          check_run: {
            id: 101,
            app: { slug: "github-actions" },
            name: "ci / build",
            conclusion: "failure",
            head_sha: sha,
            pull_requests: [{ number: 7, head: { ref: "blazebot/aiw-1", sha }, base: { ref: "main" } }],
          },
        },
        options,
      );
    const beforePush = buildCheckRun("abc123");
    const afterPush = buildCheckRun("def456");
    expect(afterPush?.delivery.semanticKey).not.toBe(beforePush?.delivery.semanticKey);
  });

  it("gives two different pull requests that share a head sha different semantic keys", () => {
    const buildCheckRun = (prNumber: number) =>
      normalizeGitHubEvent(
        "check_run",
        {
          action: "completed",
          repository: githubRepo(),
          check_run: {
            id: 101,
            app: { slug: "github-actions" },
            name: "ci / build",
            conclusion: "failure",
            head_sha: "abc123",
            pull_requests: [
              { number: prNumber, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
            ],
          },
        },
        options,
      );
    const prSeven = buildCheckRun(7);
    const prEight = buildCheckRun(8);
    expect(prSeven?.delivery.semanticKey).not.toBe(prEight?.delivery.semanticKey);
  });

  it("gives two repositories with the same PR number and head sha different semantic keys", () => {
    // A fork or mirror shares commits with its upstream, so the same head sha
    // under the same PR number across two repositories is ordinary, not a
    // hash collision. The (provider, semanticKey) uniqueness constraint has
    // no repository column, so the repository must be folded into the key.
    const otherRepo = {
      owner: { login: "acme" },
      name: "app-mirror",
      html_url: "https://github.com/acme/app-mirror",
    };
    const buildCheckRun = (repository: ReturnType<typeof githubRepo>) =>
      normalizeGitHubEvent(
        "check_run",
        {
          action: "completed",
          repository,
          check_run: {
            id: 101,
            app: { slug: "github-actions" },
            name: "ci / build",
            conclusion: "failure",
            head_sha: "abc123",
            pull_requests: [
              { number: 7, head: { ref: "blazebot/aiw-1", sha: "abc123" }, base: { ref: "main" } },
            ],
          },
        },
        options,
      );
    const upstream = buildCheckRun(githubRepo());
    const fork = buildCheckRun(otherRepo);
    expect(upstream?.delivery.semanticKey).not.toBe(fork?.delivery.semanticKey);
  });

  it("does not set a semantic key when the check_run carries no head sha", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          id: 101,
          app: { slug: "github-actions" },
          name: "ci / build",
          conclusion: "failure",
          pull_requests: [{ number: 7, head: { ref: "blazebot/aiw-1" }, base: { ref: "main" } }],
        },
      },
      options,
    );
    expect(evt?.delivery.semanticKey).toBeUndefined();
  });

  it("ignores a managed check by either name prefix (anti-loop)", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          name: "AI Workflow / code-hygiene",
          conclusion: "failure",
          pull_requests: [{ number: 7, head: { ref: "blazebot/aiw-1", sha: "x" }, base: { ref: "main" } }],
        },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it.each([
    "AI Workflow / some-future-step",
    "blazebot / some-future-step",
  ])("ignores a managed %s check by either name prefix (anti-loop)", (name) => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          name,
          conclusion: "timed_out",
          pull_requests: [{ number: 7, head: { ref: "blazebot/aiw-1", sha: "x" }, base: { ref: "main" } }],
        },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("ignores a successful check_run", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          name: "ci / build",
          conclusion: "success",
          pull_requests: [{ number: 7, head: { ref: "blazebot/aiw-1", sha: "x" }, base: { ref: "main" } }],
        },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("ignores a failed check_run with no attached pull requests", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: { name: "ci / build", conclusion: "failure", pull_requests: [] },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("maps a changes_requested review to trigger_pr_review", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "changes_requested", user: { login: "human" }, body: "please fix" },
      },
      options,
    );
    expect(evt?.triggerType).toBe("trigger_pr_review");
    expect(evt?.pr.review).toEqual({
      state: "changes_requested",
      author: "human",
      body: "please fix",
    });
  });

  it("drops a commented review by default (untrusted body needs opt-in)", () => {
    // Default reviewStates is ["changes_requested"] only: a drive-by "commented"
    // review carries an untrusted body that must not reach fix_agent unless an
    // operator explicitly opts in.
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "commented", user: { login: "human" }, body: "drive-by" },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("maps a commented review when reviewStates opts into it", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "commented", user: { login: "human" }, body: "" },
      },
      { ...options, reviewStates: ["changes_requested", "commented"] },
    );
    expect(evt?.pr.review?.state).toBe("commented");
  });

  it("drops a changes_requested review when reviewStates excludes it", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "changes_requested", user: { login: "human" }, body: "x" },
      },
      { ...options, reviewStates: ["commented"] },
    );
    expect(evt).toBeNull();
  });

  it("ignores an approved review", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "approved", user: { login: "human" }, body: "" },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("ignores a review authored by the bot itself", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "changes_requested", user: { login: "blazebot[bot]" }, body: "self" },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("matches GitHub bot identities after trimming and case normalization", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { state: "changes_requested", user: { login: "github-app[bot]" }, body: "self" },
      },
      { ...options, botLogin: "  GitHub-App[Bot]  " },
    );
    expect(evt).toBeNull();
  });

  it("adds a semantic key derived from the review id", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review",
      {
        action: "submitted",
        repository: githubRepo(),
        pull_request: githubPr(),
        review: { id: 321, state: "changes_requested", user: { login: "human" }, body: "please fix" },
      },
      options,
    );
    expect(evt?.delivery.semanticKey).toBe("review:321");
  });

  const commentOptions = { ...options, reviewStates: ["commented"] as const };

  it("maps a pull_request_review_comment created to a commented review", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review_comment",
      {
        action: "created",
        repository: githubRepo(),
        pull_request: githubPr({ user: { login: "human" } }),
        comment: {
          id: 555,
          pull_request_review_id: 999,
          user: { login: "human", type: "User" },
          body: "please fix the null check",
        },
      },
      commentOptions,
    );
    expect(evt).toEqual({
      delivery: {
        provider: "github",
        producer: "human",
        deliveryId: "github-delivery-1",
        semanticKey: "review:999",
      },
      triggerType: "trigger_pr_review",
      pr: {
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        headRef: "blazebot/aiw-1",
        headSha: "abc123",
        baseRef: "main",
        title: "Fix things",
        author: "human",
        isDraft: false,
        review: {
          state: "commented",
          author: "human",
          body: "please fix the null check",
        },
      },
    });
  });

  it("falls back to comment:<id> when the review-comment has no parent review id", () => {
    const evt = normalizeGitHubEvent(
      "pull_request_review_comment",
      {
        action: "created",
        repository: githubRepo(),
        pull_request: githubPr(),
        comment: { id: 555, user: { login: "human", type: "User" }, body: "x" },
      },
      commentOptions,
    );
    expect(evt?.delivery.semanticKey).toBe("comment:555");
  });

  it("keys a reply on the comment, not the review it hangs off", () => {
    // A reply may reuse its thread's pull_request_review_id. Keying it on that
    // review would coalesce it into the already-consumed submission and drop
    // the reply silently, so replies always get their own key.
    const evt = normalizeGitHubEvent(
      "pull_request_review_comment",
      {
        action: "created",
        repository: githubRepo(),
        pull_request: githubPr(),
        comment: {
          id: 777,
          in_reply_to_id: 555,
          pull_request_review_id: 999,
          user: { login: "human", type: "User" },
          body: "still broken",
        },
      },
      commentOptions,
    );
    expect(evt?.delivery.semanticKey).toBe("comment:777");
  });

  it("ignores non-created review-comment actions", () => {
    for (const action of ["edited", "deleted"]) {
      expect(
        normalizeGitHubEvent(
          "pull_request_review_comment",
          {
            action,
            repository: githubRepo(),
            pull_request: githubPr(),
            comment: { id: 1, user: { login: "human", type: "User" }, body: "x" },
          },
          commentOptions,
        ),
      ).toBeNull();
    }
  });

  it("drops a review-comment authored by the bot itself", () => {
    expect(
      normalizeGitHubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          repository: githubRepo(),
          pull_request: githubPr(),
          comment: { id: 1, user: { login: "blazebot[bot]", type: "User" }, body: "self" },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("drops a review-comment from any Bot-type account", () => {
    expect(
      normalizeGitHubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          repository: githubRepo(),
          pull_request: githubPr(),
          comment: { id: 1, user: { login: "dependabot", type: "Bot" }, body: "ci noise" },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("drops a review-comment carrying the AI Workflow marker", () => {
    expect(
      normalizeGitHubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          repository: githubRepo(),
          pull_request: githubPr(),
          comment: {
            id: 1,
            user: { login: "human", type: "User" },
            body: `looks good ${AI_WORKFLOW_COMMENT_MARKER}`,
          },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("starts a run for a reviewer who quoted one of our notes to ask for a change", () => {
    // The reviewer pressed "Quote reply" on our run summary and typed a
    // request under it, so their comment carries our marker without their
    // having written it. Dropping it here is the worst version of this whole
    // problem: no run, no comment, no failure, nothing for them to open, and
    // they are right to conclude they were ignored.
    const evt = normalizeGitHubEvent(
      "pull_request_review_comment",
      {
        action: "created",
        repository: githubRepo(),
        pull_request: githubPr({ user: { login: "human" } }),
        comment: {
          id: 1,
          user: { login: "piotr", type: "User" },
          body: quoteReply(OUR_OWN_NOTE, "This did not fix it. The button is still dead."),
        },
      },
      commentOptions,
    );

    expect(evt?.triggerType).toBe("trigger_pr_review");
    expect(evt?.pr.review?.author).toBe("piotr");
  });

  it("still drops one of our own notes that quotes a reviewer", () => {
    // The mirror, and the echo protection AIW-140 added: our marker sits on a
    // line of its own however much the note quotes, so it is still ours and
    // still fires nothing.
    expect(
      normalizeGitHubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          repository: githubRepo(),
          pull_request: githubPr(),
          comment: {
            id: 1,
            user: { login: "human", type: "User" },
            body: `> The button is still dead.\n\nFixed in a1b2c3d.\n\n${AI_WORKFLOW_COMMENT_MARKER}`,
          },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("drops a review-comment that is the ledger settler's own thread reply", () => {
    // Without this the ledger would drive itself: every reply it posts into a
    // thread would arrive back as trigger_pr_review and start another run.
    expect(
      normalizeGitHubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          repository: githubRepo(),
          pull_request: githubPr(),
          comment: {
            id: 1,
            in_reply_to_id: 99,
            user: { login: "human", type: "User" },
            body: settlerReply("PRRT_kwDOabc"),
          },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("drops a review-comment when reviewStates is not opted into commented", () => {
    expect(
      normalizeGitHubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          repository: githubRepo(),
          pull_request: githubPr(),
          comment: { id: 1, user: { login: "human", type: "User" }, body: "x" },
        },
        options,
      ),
    ).toBeNull();
  });

  it("maps an issue_comment on a PR to a commented review", () => {
    const evt = normalizeGitHubEvent(
      "issue_comment",
      {
        action: "created",
        repository: githubRepo(),
        issue: {
          number: 7,
          title: "Fix things",
          user: { login: "author-person" },
          pull_request: { html_url: "https://github.com/acme/app/pull/7" },
        },
        comment: { id: 777, user: { login: "human", type: "User" }, body: "conversation feedback" },
      },
      commentOptions,
    );
    expect(evt).toEqual({
      delivery: {
        provider: "github",
        producer: "human",
        deliveryId: "github-delivery-1",
        semanticKey: "comment:777",
      },
      triggerType: "trigger_pr_review",
      pr: {
        provider: "github",
        repoPath: "acme/app",
        prNumber: 7,
        prUrl: "https://github.com/acme/app/pull/7",
        headRef: "",
        headSha: "",
        baseRef: "",
        title: "Fix things",
        author: "author-person",
        isDraft: false,
        review: {
          state: "commented",
          author: "human",
          body: "conversation feedback",
        },
      },
    });
  });

  it("derives the PR url from the repo when issue.pull_request omits html_url", () => {
    const evt = normalizeGitHubEvent(
      "issue_comment",
      {
        action: "created",
        repository: githubRepo(),
        issue: { number: 7, title: "t", user: { login: "a" }, pull_request: {} },
        comment: { id: 1, user: { login: "human", type: "User" }, body: "x" },
      },
      commentOptions,
    );
    expect(evt?.pr.prUrl).toBe("https://github.com/acme/app/pull/7");
  });

  it("ignores an issue_comment on a plain issue (no pull_request)", () => {
    expect(
      normalizeGitHubEvent(
        "issue_comment",
        {
          action: "created",
          repository: githubRepo(),
          issue: { number: 7, title: "bug", user: { login: "author-person" } },
          comment: { id: 1, user: { login: "human", type: "User" }, body: "x" },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("ignores non-created issue_comment actions", () => {
    for (const action of ["edited", "deleted"]) {
      expect(
        normalizeGitHubEvent(
          "issue_comment",
          {
            action,
            repository: githubRepo(),
            issue: { number: 7, title: "t", user: { login: "a" }, pull_request: {} },
            comment: { id: 1, user: { login: "human", type: "User" }, body: "x" },
          },
          commentOptions,
        ),
      ).toBeNull();
    }
  });

  it("drops an issue_comment authored by the bot itself", () => {
    expect(
      normalizeGitHubEvent(
        "issue_comment",
        {
          action: "created",
          repository: githubRepo(),
          issue: { number: 7, title: "t", user: { login: "a" }, pull_request: {} },
          comment: { id: 1, user: { login: "blazebot[bot]", type: "User" }, body: "self" },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("drops an issue_comment from any Bot-type account", () => {
    expect(
      normalizeGitHubEvent(
        "issue_comment",
        {
          action: "created",
          repository: githubRepo(),
          issue: { number: 7, title: "t", user: { login: "a" }, pull_request: {} },
          comment: { id: 1, user: { login: "dependabot", type: "Bot" }, body: "ci noise" },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("drops an issue_comment carrying the AI Workflow marker", () => {
    expect(
      normalizeGitHubEvent(
        "issue_comment",
        {
          action: "created",
          repository: githubRepo(),
          issue: { number: 7, title: "t", user: { login: "a" }, pull_request: {} },
          comment: {
            id: 1,
            user: { login: "human", type: "User" },
            body: `looks good ${AI_WORKFLOW_COMMENT_MARKER}`,
          },
        },
        commentOptions,
      ),
    ).toBeNull();
  });

  it("starts a run for a conversation comment quoting one of our notes", () => {
    const evt = normalizeGitHubEvent(
      "issue_comment",
      {
        action: "created",
        repository: githubRepo(),
        issue: {
          number: 7,
          title: "Fix things",
          user: { login: "author-person" },
          pull_request: { html_url: "https://github.com/acme/app/pull/7" },
        },
        comment: {
          id: 778,
          user: { login: "piotr", type: "User" },
          body: quoteReply(OUR_OWN_NOTE, "Reopening: the mobile case is untouched."),
        },
      },
      commentOptions,
    );

    expect(evt?.triggerType).toBe("trigger_pr_review");
    expect(evt?.pr.review?.author).toBe("piotr");
  });

  it("drops an issue_comment when reviewStates is not opted into commented", () => {
    expect(
      normalizeGitHubEvent(
        "issue_comment",
        {
          action: "created",
          repository: githubRepo(),
          issue: { number: 7, title: "t", user: { login: "a" }, pull_request: {} },
          comment: { id: 1, user: { login: "human", type: "User" }, body: "x" },
        },
        options,
      ),
    ).toBeNull();
  });

  it("ignores unrelated events", () => {
    expect(normalizeGitHubEvent("push", { repository: githubRepo() }, options)).toBeNull();
  });
});
