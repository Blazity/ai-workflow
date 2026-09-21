import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * The two halves of a check identity, put together the way a run puts them.
 *
 * A failed check reaches core twice: once as a webhook delivery, whose handle
 * the provider's webhook translator mints, and once when the run re-reads the
 * pull request before it starts, whose handle the provider's adapter mints off
 * the API. `bindCurrentPullRequest` keeps the event only when the two compare
 * equal through that provider's own `sameHandle`. If they disagree, every
 * failed check binds to nothing and the autofix path simply never runs, with
 * the trigger recorded as `ignored_stale_head` and no error anywhere.
 *
 * That is what the S10 gate found on the other provider and what this test
 * exists to make impossible here. It is deliberately built from real bytes and
 * real code on both sides: GitHub's own published `check_run` delivery through
 * the real normalizer, and a `GET /repos/.../check-runs` body through the real
 * adapter. Nothing in it constructs a handle by hand, because a test that built
 * the "current" state from the same event it was testing would pass whether or
 * not the mechanism existed.
 */

const mockOctokit = vi.hoisted(() => ({
  pulls: { get: vi.fn() },
  checks: { listForRef: vi.fn() },
  paginate: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({ Octokit: vi.fn(() => mockOctokit) }));
vi.mock("@octokit/auth-app", () => ({ createAppAuth: vi.fn(() => vi.fn()) }));
// `bindCurrentPullRequest` is pure; its module also exports the reader that
// resolves an adapter through the capability, which would drag this deployment's
// environment in. This test builds the adapter itself, on purpose, so the
// resolution path is not what is under test here.
vi.mock("./vcs-runtime.js", () => ({ createRepositoryVCS: vi.fn() }));

const { GitHubAdapter } = await import("../../../../../integrations/github/vcs.js");
const { normalizeGitHubEvents } = await import("../../../../../integrations/github/webhook.js");
const { bindCurrentPullRequest } = await import("./trigger-current-pull-request.js");

const delivery = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../integrations/github/test-fixtures/check-run-completed-failure.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/** A real key, because the credential reader refuses anything that is not one. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function adapter() {
  return new GitHubAdapter({
    credential: { appId: 1, privateKey: privateKey as unknown as string, installationId: 2 },
    owner: "Codertocat",
    repo: "Hello-World",
    baseBranch: "master",
  });
}

/**
 * What `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` answers for the
 * same check the delivery described. Same id, same name, same conclusion: this
 * is the same object seen through the other API, which is the situation a run
 * is actually in.
 */
function checkRunsForHead(app: { slug?: string } | undefined) {
  return [
    {
      id: delivery.check_run.id,
      name: delivery.check_run.name,
      status: "completed",
      conclusion: delivery.check_run.conclusion,
      app,
    },
  ];
}

function pullRequest() {
  return {
    data: {
      number: 2,
      state: "open",
      merged: false,
      head: { sha: delivery.check_run.head_sha, ref: "changes" },
      base: { ref: "master" },
    },
  };
}

describe("a failed GitHub check binds to the pull request it was reported on", () => {
  it("compares the delivered handle with the re-read one through the adapter itself", async () => {
    const [event] = normalizeGitHubEvents("check_run", delivery, { deliveryId: "d1" });
    expect(event?.triggerType).toBe("trigger_pr_checks_failed");

    const vcs = adapter();
    mockOctokit.pulls.get.mockResolvedValue(pullRequest());
    mockOctokit.paginate.mockResolvedValue(checkRunsForHead({ slug: "github-actions" }));
    const current = await vcs.getPRHead(2);

    const bound = bindCurrentPullRequest(event!, current, (left, right) =>
      vcs.sameHandle(left, right),
    );

    expect(bound).not.toBeNull();
    expect(bound?.pr.failedChecks?.map((check) => check.name)).toEqual([
      delivery.check_run.name,
    ]);
  });

  it("still binds when GitHub reports the check run without an app slug", async () => {
    // The published `completed` delivery is exactly this: an `app` object with
    // no `slug` on it. The webhook used to fall back to the sender's login for
    // the handle's owner while the adapter fell back to the empty string, so
    // the two handles never compared equal and the autofix path went silent on
    // every such check.
    const body = JSON.parse(JSON.stringify(delivery));
    delete body.check_run.app.slug;
    const [event] = normalizeGitHubEvents("check_run", body, { deliveryId: "d2" });

    const vcs = adapter();
    mockOctokit.pulls.get.mockResolvedValue(pullRequest());
    mockOctokit.paginate.mockResolvedValue(checkRunsForHead({}));
    const current = await vcs.getPRHead(2);

    expect(
      bindCurrentPullRequest(event!, current, (left, right) => vcs.sameHandle(left, right)),
    ).not.toBeNull();
  });

  it("refuses to bind a check the provider no longer reports as failed", async () => {
    // The positive control's opposite: with the same machinery, a check that
    // now passes must drop the event, so the tests above cannot be passing
    // because `sameHandle` says yes to everything.
    const [event] = normalizeGitHubEvents("check_run", delivery, { deliveryId: "d3" });

    const vcs = adapter();
    mockOctokit.pulls.get.mockResolvedValue(pullRequest());
    mockOctokit.paginate.mockResolvedValue([
      {
        id: delivery.check_run.id,
        name: delivery.check_run.name,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
      },
    ]);
    const current = await vcs.getPRHead(2);

    expect(
      bindCurrentPullRequest(event!, current, (left, right) => vcs.sameHandle(left, right)),
    ).toBeNull();
  });

  it("refuses to bind a different check run that shares the name and conclusion", async () => {
    const [event] = normalizeGitHubEvents("check_run", delivery, { deliveryId: "d4" });

    const vcs = adapter();
    mockOctokit.pulls.get.mockResolvedValue(pullRequest());
    mockOctokit.paginate.mockResolvedValue([
      {
        id: delivery.check_run.id + 1,
        name: delivery.check_run.name,
        status: "completed",
        conclusion: delivery.check_run.conclusion,
        app: { slug: "github-actions" },
      },
    ]);
    const current = await vcs.getPRHead(2);

    expect(
      bindCurrentPullRequest(event!, current, (left, right) => vcs.sameHandle(left, right)),
    ).toBeNull();
  });
});
