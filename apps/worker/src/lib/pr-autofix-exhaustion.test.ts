import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoopMessagingAdapter } from "../adapters/messaging/noop.js";
import { AI_WORKFLOW_COMMENT_MARKER } from "./vcs-bot-identity.js";

const mocks = vi.hoisted(() => ({
  createAdapters: vi.fn(),
  postPRComment: vi.fn(),
  notifyForTicket: vi.fn(),
}));

vi.mock("./adapters.js", () => ({
  createAdapters: (...args: unknown[]) => mocks.createAdapters(...args),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "./logger.js";
import { announcePrAutofixExhaustion } from "./pr-autofix-exhaustion.js";

const notice = {
  provider: "github" as const,
  repoPath: "acme/api",
  baseRef: "main",
  prNumber: 42,
  prUrl: "https://github.com/acme/api/pull/42",
  ticketKey: "AIW-7",
  subjectKey: "github:acme/api#42",
};

/** The one dispatch that crosses the budget: max spent, this one refused. */
const crossing = { max: 2, allowed: false, attempts: 3 };

function messagingOnly() {
  return { messaging: { notifyForTicket: mocks.notifyForTicket } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.postPRComment.mockResolvedValue({ url: "https://github.com/c/1" });
  mocks.notifyForTicket.mockResolvedValue(undefined);
  mocks.createAdapters.mockReturnValue({
    vcs: { postPRComment: mocks.postPRComment },
    ...messagingOnly(),
  });
});

describe("announcePrAutofixExhaustion", () => {
  it("comments on the pull request and tells Slack on the dispatch that crosses the cap", async () => {
    await announcePrAutofixExhaustion({ ...notice, decision: crossing });

    // The adapter is built for the pull request's own repository, not for the
    // deployment's default one: a trigger can fire on any attached repo.
    expect(mocks.createAdapters).toHaveBeenCalledWith({
      provider: "github",
      repoPath: "acme/api",
      baseBranch: "main",
    });

    expect(mocks.postPRComment).toHaveBeenCalledTimes(1);
    const [prNumber, body] = mocks.postPRComment.mock.calls[0] as [number, string];
    expect(prNumber).toBe(42);
    expect(body).toContain("Automatic fixing has stopped");
    expect(body).toContain("2 times");
    // Everything we post carries the marker so our own comment can never be
    // read back as somebody else's activity on the pull request (AIW-140).
    expect(body).toContain(AI_WORKFLOW_COMMENT_MARKER);

    expect(mocks.notifyForTicket).toHaveBeenCalledTimes(1);
    const [threadKey, event] = mocks.notifyForTicket.mock.calls[0] as [
      string,
      { kind: string; text: string },
    ];
    expect(threadKey).toBe("AIW-7");
    expect(event.kind).toBe("note");
    expect(event.text).toContain("acme/api");
    expect(event.text).toContain("https://github.com/acme/api/pull/42");
  });

  it("says nothing on any dispatch past the crossing", async () => {
    // The tally keeps climbing after the refusal, so max + 1 is the single call
    // that crosses. Everything above it would be a repeat of the same notice.
    await announcePrAutofixExhaustion({
      ...notice,
      decision: { max: 2, allowed: false, attempts: 4 },
    });

    expect(mocks.postPRComment).not.toHaveBeenCalled();
    expect(mocks.notifyForTicket).not.toHaveBeenCalled();
  });

  it("says nothing while the budget still admits dispatches", async () => {
    await announcePrAutofixExhaustion({
      ...notice,
      decision: { max: 2, allowed: true, attempts: 2 },
    });

    expect(mocks.postPRComment).not.toHaveBeenCalled();
    expect(mocks.notifyForTicket).not.toHaveBeenCalled();
  });

  it("says nothing for a cap of zero, which spends nothing and starts nothing", async () => {
    await announcePrAutofixExhaustion({
      ...notice,
      decision: { max: 0, allowed: false, attempts: 0 },
    });

    expect(mocks.postPRComment).not.toHaveBeenCalled();
    expect(mocks.notifyForTicket).not.toHaveBeenCalled();
  });

  it("still tells Slack when the pull request comment fails, and does not throw", async () => {
    mocks.postPRComment.mockRejectedValue(new Error("422 unprocessable"));

    await expect(
      announcePrAutofixExhaustion({ ...notice, decision: crossing }),
    ).resolves.toBeUndefined();

    expect(mocks.notifyForTicket).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "acme/api", prNumber: 42 }),
      "pr_autofix_exhausted_comment_failed",
    );
  });

  it("swallows and logs a Slack failure", async () => {
    mocks.notifyForTicket.mockRejectedValue(new Error("channel_not_found"));

    await expect(
      announcePrAutofixExhaustion({ ...notice, decision: crossing }),
    ).resolves.toBeUndefined();

    expect(mocks.postPRComment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "acme/api", prNumber: 42 }),
      "pr_autofix_exhausted_slack_failed",
    );
  });

  it("swallows and logs a provider that cannot be reached at all", async () => {
    // The repository adapter is built lazily, so an unconfigured provider throws
    // on the property read rather than from the call.
    mocks.createAdapters.mockReturnValue({
      get vcs(): never {
        throw new Error("gitlab is not configured");
      },
      ...messagingOnly(),
    });

    await expect(
      announcePrAutofixExhaustion({ ...notice, decision: crossing }),
    ).resolves.toBeUndefined();

    expect(mocks.notifyForTicket).toHaveBeenCalledTimes(1);
  });

  it("posts the comment and stays quiet when Slack is not configured", async () => {
    mocks.createAdapters.mockReturnValue({
      vcs: { postPRComment: mocks.postPRComment },
      messaging: new NoopMessagingAdapter(),
    });

    await expect(
      announcePrAutofixExhaustion({ ...notice, decision: crossing }),
    ).resolves.toBeUndefined();

    expect(mocks.postPRComment).toHaveBeenCalledTimes(1);
  });

  it("anchors the Slack message on the pull request when there is no ticket", async () => {
    await announcePrAutofixExhaustion({
      ...notice,
      ticketKey: null,
      decision: crossing,
    });

    expect(mocks.notifyForTicket).toHaveBeenCalledWith(
      "github:acme/api#42",
      expect.objectContaining({ kind: "note" }),
    );
  });

  it("keeps the copy singular for a cap of one", async () => {
    await announcePrAutofixExhaustion({
      ...notice,
      decision: { max: 1, allowed: false, attempts: 2 },
    });

    const [, body] = mocks.postPRComment.mock.calls[0] as [number, string];
    expect(body).toContain("1 time,");
    expect(body).not.toContain("1 times");
  });
});
