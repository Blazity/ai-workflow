import { describe, it, expect } from "vitest";
import { normalizeGitHubEvent, normalizeGitLabEvent } from "./trigger-events.js";

const options = {
  gateCheckNames: ["blazebot / code-hygiene"],
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

  it("maps pull_request reopened to trigger_pr_created", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      { action: "reopened", repository: githubRepo(), pull_request: githubPr() },
      options,
    );
    expect(evt?.triggerType).toBe("trigger_pr_created");
  });

  it("never routes synchronize (stays gate-only)", () => {
    const evt = normalizeGitHubEvent(
      "pull_request",
      { action: "synchronize", repository: githubRepo(), pull_request: githubPr() },
      options,
    );
    expect(evt).toBeNull();
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
          { name: "ci / build", conclusion: "failure", detailsUrl: "https://ci/run/1" },
        ],
      },
    });
  });

  it("ignores a gate check by exact configured name (anti-loop)", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          name: "blazebot / code-hygiene",
          conclusion: "failure",
          pull_requests: [{ number: 7, head: { ref: "blazebot/aiw-1", sha: "x" }, base: { ref: "main" } }],
        },
      },
      options,
    );
    expect(evt).toBeNull();
  });

  it("ignores any gate check by name prefix (anti-loop)", () => {
    const evt = normalizeGitHubEvent(
      "check_run",
      {
        action: "completed",
        repository: githubRepo(),
        check_run: {
          name: "blazebot / some-future-step",
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

  it("ignores unrelated events", () => {
    expect(normalizeGitHubEvent("push", { repository: githubRepo() }, options)).toBeNull();
  });
});

describe("normalizeGitLabEvent", () => {
  function mrPayload(action: string) {
    return {
      object_kind: "merge_request",
      user: { username: "alice" },
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: {
        iid: 42,
        action,
        source_branch: "blazebot/aiw-3",
        target_branch: "main",
        title: "AIW-3",
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
        last_commit: { id: "sha1" },
      },
    };
  }

  it("maps an opened merge request to trigger_pr_created", () => {
    const evt = normalizeGitLabEvent("Merge Request Hook", mrPayload("open"), {
      deliveryId: "gitlab-delivery-1",
    });
    expect(evt).toEqual({
      delivery: {
        provider: "gitlab",
        producer: "alice",
        deliveryId: "gitlab-delivery-1",
      },
      triggerType: "trigger_pr_created",
      pr: {
        provider: "gitlab",
        repoPath: "group/demo",
        prNumber: 42,
        prUrl: "https://gitlab.com/group/demo/-/merge_requests/42",
        headRef: "blazebot/aiw-3",
        headSha: "sha1",
        baseRef: "main",
        title: "AIW-3",
        author: "alice",
        isDraft: false,
      },
    });
  });

  it("does not drop bot-authored merge requests or pipelines globally", () => {
    const botMr = mrPayload("open");
    botMr.user.username = "blazebot";
    expect(
      normalizeGitLabEvent("Merge Request Hook", botMr, { botUsername: "blazebot" })
        ?.triggerType,
    ).toBe("trigger_pr_created");

    expect(
      normalizeGitLabEvent(
        "Pipeline Hook",
        {
          object_kind: "pipeline",
          user: { username: "blazebot" },
          project: { path_with_namespace: "group/demo" },
          object_attributes: { status: "failed", sha: "sha1" },
          merge_request: {
            iid: 42,
            source_branch: "blazebot/aiw-3",
            target_branch: "main",
          },
        },
        { botUsername: "blazebot" },
      )?.triggerType,
    ).toBe("trigger_pr_checks_failed");
  });

  it("never routes a merge request update", () => {
    expect(normalizeGitLabEvent("Merge Request Hook", mrPayload("update"))).toBeNull();
  });

  it("maps a failed pipeline with a merge request to trigger_pr_checks_failed", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      user: { username: "alice" },
      project: { id: 1, path_with_namespace: "group/demo" },
      object_attributes: { status: "failed", sha: "sha1" },
      merge_request: {
        iid: 42,
        source_branch: "blazebot/aiw-3",
        target_branch: "main",
        title: "AIW-3",
        url: "https://gitlab.com/group/demo/-/merge_requests/42",
      },
      builds: [
        { name: "lint", status: "failed" },
        { name: "test", status: "success" },
      ],
    });
    expect(evt?.triggerType).toBe("trigger_pr_checks_failed");
    expect(evt?.delivery.producer).toBe("gitlab-ci");
    expect(evt?.pr.headRef).toBe("blazebot/aiw-3");
    expect(evt?.pr.failedChecks).toEqual([{ name: "lint", conclusion: "failed" }]);
  });

  it("ignores a passing pipeline", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/demo" },
      object_attributes: { status: "success", sha: "sha1" },
      merge_request: { iid: 42, source_branch: "blazebot/aiw-3", target_branch: "main" },
    });
    expect(evt).toBeNull();
  });

  it("ignores a failed pipeline without a merge request", () => {
    const evt = normalizeGitLabEvent("Pipeline Hook", {
      object_kind: "pipeline",
      project: { path_with_namespace: "group/demo" },
      object_attributes: { status: "failed", sha: "sha1" },
    });
    expect(evt).toBeNull();
  });
});
