import { describe, it, expect, vi, beforeEach } from "vitest";
import { ThreadImpl } from "chat";
import { ChatSDKAdapter } from "./chatsdk.js";
import type { ThreadStore } from "../run-registry/types.js";

const mockChannelPost = vi.fn();
const mockThreadPost = vi.fn();

vi.mock("chat", () => {
  return {
    Chat: vi.fn(() => ({
      channel: vi.fn((id: string) => ({
        id,
        post: mockChannelPost,
      })),
    })),
    ThreadImpl: vi.fn().mockImplementation((cfg: { id: string }) => ({
      id: cfg.id,
      post: mockThreadPost,
    })),
  };
});

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn(() => ({ name: "slack" })),
}));

function createThreadStore(): ThreadStore & {
  getParent: ReturnType<typeof vi.fn>;
  setParent: ReturnType<typeof vi.fn>;
  clearParent: ReturnType<typeof vi.fn>;
} {
  return {
    getParent: vi.fn().mockResolvedValue(null),
    setParent: vi.fn().mockResolvedValue(undefined),
    clearParent: vi.fn().mockResolvedValue(undefined),
  };
}

function createAdapter(threadStore: ThreadStore) {
  return new ChatSDKAdapter({
    slackToken: "xoxb-test",
    channelId: "C123",
    botName: "blazebot",
    jiraBaseUrl: "https://jira.example.com",
    threadStore,
  });
}

const JIRA_LINK = "<https://jira.example.com/browse/AWT-42|AWT-42>";

describe("ChatSDKAdapter.notifyForTicket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelPost.mockResolvedValue({ id: "1700000000.000111" });
    mockThreadPost.mockResolvedValue({ id: "1700000000.000222" });
  });

  it("started with no parent — posts top-level and records the parent", async () => {
    const store = createThreadStore();
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "started" });

    expect(mockChannelPost).toHaveBeenCalledWith(
      `:hourglass_flowing_sand: Task ${JIRA_LINK} started`,
    );
    expect(mockThreadPost).not.toHaveBeenCalled();
    expect(store.setParent).toHaveBeenCalledWith("AWT-42", "1700000000.000111");
  });

  it("subsequent event with parent set — posts as thread reply, does not setParent", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "needs_clarification",
      usageReport: "u",
    });

    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:question: Task ${JIRA_LINK} needs clarification\nu`,
    );
    expect(ThreadImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "slack:C123:1700000000.000111",
        channelId: "slack:C123",
        isDM: false,
      }),
    );
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("non-started event with no parent — posts top-level, does NOT setParent (orphan stays orphan)", async () => {
    const store = createThreadStore();
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "canceled",
      reason: "left AI column",
    });

    expect(mockChannelPost).toHaveBeenCalledWith(
      `:no_entry: Task ${JIRA_LINK} canceled: left AI column`,
    );
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("parent deleted on Slack — clears mapping, retries top-level, re-records on started", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    // Realistic Slack WebAPIPlatformError shape: code is the SDK sentinel,
    // and the actionable Slack API error string lives on data.error.
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("thread gone"), {
        code: "slack_webapi_platform_error",
        data: { error: "thread_not_found" },
      }),
    );
    mockChannelPost.mockResolvedValueOnce({ id: "1700000000.000999" });
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "started" });

    expect(mockThreadPost).toHaveBeenCalledTimes(1);
    expect(store.clearParent).toHaveBeenCalledWith("AWT-42");
    expect(mockChannelPost).toHaveBeenCalledTimes(1);
    // Because the event is `started`, the new top-level message becomes the parent.
    expect(store.setParent).toHaveBeenCalledWith("AWT-42", "1700000000.000999");
  });

  it("parent deleted on Slack for non-started event — clears + retries, does not re-anchor", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { code: "message_not_found" }),
    );
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "failed",
      phase: "impl",
      reason: "boom",
    });

    expect(store.clearParent).toHaveBeenCalledWith("AWT-42");
    expect(mockChannelPost).toHaveBeenCalledWith(
      `:warning: Task ${JIRA_LINK} failed: impl — boom`,
    );
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("non-missing-parent error — does not retry, does not throw", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { code: "rate_limited" }),
    );
    const adapter = createAdapter(store);

    await expect(
      adapter.notifyForTicket("AWT-42", { kind: "started" }),
    ).resolves.not.toThrow();
    expect(store.clearParent).not.toHaveBeenCalled();
    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("top-level post failure — swallows error, no parent recorded", async () => {
    const store = createThreadStore();
    mockChannelPost.mockRejectedValueOnce(new Error("Slack API down"));
    const adapter = createAdapter(store);

    await expect(
      adapter.notifyForTicket("AWT-42", { kind: "started" }),
    ).resolves.not.toThrow();
    expect(store.setParent).not.toHaveBeenCalled();
  });

  it("pr_ready — formats with PR link inline", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "pr_ready",
      pr: { url: "https://github.com/o/r/pull/7", number: 7 },
      usageReport: "Total: $0.10",
    });

    expect(mockThreadPost).toHaveBeenCalledWith(
      `:white_check_mark: Task ${JIRA_LINK} PR ready for review — <https://github.com/o/r/pull/7|#7>\nTotal: $0.10`,
    );
  });
});
