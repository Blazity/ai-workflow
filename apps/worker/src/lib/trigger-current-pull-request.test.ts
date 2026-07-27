import { describe, expect, it, vi } from "vitest";
import type { PullRequestHead } from "../adapters/vcs/types.js";

// bindCurrentPullRequest is a pure function, but the module also imports
// createRepositoryVCS (-> env.js). Mock the runtime so the import chain never
// validates environment variables during this unit test.
vi.mock("./vcs-runtime.js", () => ({
  createRepositoryVCS: vi.fn(),
}));

const { bindCurrentPullRequest } = await import("./trigger-current-pull-request.js");
type TriggerEvent = import("./trigger-events.js").TriggerEvent;

function reviewEvent(overrides: Partial<TriggerEvent["pr"]> = {}): TriggerEvent {
  return {
    delivery: { provider: "github", producer: "human", deliveryId: "d1" },
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
      author: "human",
      isDraft: false,
      review: { state: "commented", author: "human", body: "please fix" },
      ...overrides,
    },
  };
}

const openHead: PullRequestHead = {
  headSha: "live-sha",
  headRef: "blazebot/aiw-1",
  baseRef: "main",
  state: "open",
};

describe("bindCurrentPullRequest", () => {
  it("adopts the current head, branch and base for a review with empty facts", () => {
    const bound = bindCurrentPullRequest(reviewEvent(), openHead);

    expect(bound).not.toBeNull();
    expect(bound?.pr.headSha).toBe("live-sha");
    expect(bound?.pr.baseRef).toBe("main");
    // headRef feeds the agent's checkout branch, so it must be rehydrated too.
    expect(bound?.pr.headRef).toBe("blazebot/aiw-1");
  });

  it("rejects a review when neither the event nor the provider knows the branch", () => {
    // Fail closed: dispatching would hand the agent an empty branch to check out.
    const bound = bindCurrentPullRequest(reviewEvent(), { ...openHead, headRef: undefined });

    expect(bound).toBeNull();
  });

  it("prefers the event's own branch over the provider read", () => {
    const bound = bindCurrentPullRequest(reviewEvent({ headRef: "from-payload" }), openHead);

    expect(bound?.pr.headRef).toBe("from-payload");
  });

  it("keeps a non-empty matching head/base for a review", () => {
    const bound = bindCurrentPullRequest(
      reviewEvent({ headSha: "live-sha", baseRef: "main" }),
      openHead,
    );

    expect(bound?.pr.headSha).toBe("live-sha");
    expect(bound?.pr.baseRef).toBe("main");
  });

  it("rejects a review whose non-empty head no longer matches the current head", () => {
    const bound = bindCurrentPullRequest(
      reviewEvent({ headSha: "stale-sha", baseRef: "main" }),
      openHead,
    );

    expect(bound).toBeNull();
  });

  it("rejects a review on a PR that is no longer open", () => {
    const bound = bindCurrentPullRequest(reviewEvent(), { ...openHead, state: "merged" });

    expect(bound).toBeNull();
  });

  it("still rejects a non-review trigger that carries an empty base ref", () => {
    const event: TriggerEvent = {
      delivery: { provider: "github", producer: "bot", deliveryId: "d2" },
      triggerType: "trigger_pr_created",
      pr: { ...reviewEvent().pr, baseRef: "", headSha: "live-sha", review: undefined },
    };

    expect(bindCurrentPullRequest(event, openHead)).toBeNull();
  });
});
