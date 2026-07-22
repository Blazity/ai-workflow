import { describe, it, expect, vi, beforeEach } from "vitest";
import { ThreadImpl } from "chat";
import { ChatSDKAdapter } from "./chatsdk.js";
import type { ThreadStore } from "../run-registry/types.js";

const mockChannelPost = vi.fn();
const mockThreadPost = vi.fn();
const mockEditMessage = vi.fn();

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
  createSlackAdapter: vi.fn(() => ({
    name: "slack",
    editMessage: mockEditMessage,
  })),
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
    mockEditMessage.mockResolvedValue({ ts: "1700000000.000111" });
  });

  it("first event — posts status as parent and details as a thread reply", async () => {
    const store = createThreadStore();
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "started" });

    expect(mockChannelPost).toHaveBeenCalledWith(
      `:hourglass_flowing_sand: ${JIRA_LINK} STATUS: in progress`,
    );
    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(store.setParent).toHaveBeenCalledWith("AWT-42", "1700000000.000111");
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:hourglass_flowing_sand: Task ${JIRA_LINK} started`,
    );
    expect(ThreadImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "slack:C123:1700000000.000111",
        channelId: "slack:C123",
        isDM: false,
      }),
    );
  });

  it("subsequent event — edits the parent status and posts details to the thread", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "needs_clarification",
      usageReport: "u",
    });

    expect(mockEditMessage).toHaveBeenCalledWith(
      "slack:C123",
      "1700000000.000111",
      `:question: ${JIRA_LINK} STATUS: needs clarification`,
    );
    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(store.setParent).not.toHaveBeenCalled();
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:question: Task ${JIRA_LINK} needs clarification\nu`,
    );
  });

  it("pr_ready — status header includes the PR link inline", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "pr_ready",
      pr: { url: "https://github.com/o/r/pull/7", number: 7 },
      usageReport: "Total: $0.10",
    });

    expect(mockEditMessage).toHaveBeenCalledWith(
      "slack:C123",
      "1700000000.000111",
      `:white_check_mark: ${JIRA_LINK} STATUS: PR ready (<https://github.com/o/r/pull/7|#7>)`,
    );
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:white_check_mark: Task ${JIRA_LINK} PR ready for review — <https://github.com/o/r/pull/7|#7>\nTotal: $0.10`,
    );
  });

  it("failed — status header includes the failed phase", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "failed",
      phase: "impl",
      reason: "boom",
    });

    expect(mockEditMessage).toHaveBeenCalledWith(
      "slack:C123",
      "1700000000.000111",
      `:warning: ${JIRA_LINK} STATUS: failed (impl)`,
    );
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:warning: Task ${JIRA_LINK} failed: impl — boom`,
    );
  });

  it("parent deleted on Slack — clears mapping, re-posts a new parent, and threads the detail", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockEditMessage.mockRejectedValueOnce(
      Object.assign(new Error("gone"), {
        code: "slack_webapi_platform_error",
        data: { error: "message_not_found" },
      }),
    );
    mockChannelPost.mockResolvedValueOnce({ id: "1700000000.000999" });
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "started" });

    expect(store.clearParent).toHaveBeenCalledWith("AWT-42");
    expect(mockChannelPost).toHaveBeenCalledWith(
      `:hourglass_flowing_sand: ${JIRA_LINK} STATUS: in progress`,
    );
    expect(store.setParent).toHaveBeenCalledWith("AWT-42", "1700000000.000999");
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:hourglass_flowing_sand: Task ${JIRA_LINK} started`,
    );
  });

  it("non-missing-parent edit error — keeps the parent, still threads the detail", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockEditMessage.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { code: "rate_limited" }),
    );
    const adapter = createAdapter(store);

    await expect(
      adapter.notifyForTicket("AWT-42", {
        kind: "needs_clarification",
      }),
    ).resolves.not.toThrow();

    expect(store.clearParent).not.toHaveBeenCalled();
    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(store.setParent).not.toHaveBeenCalled();
    // Detail still lands in the thread under the existing parent.
    expect(mockThreadPost).toHaveBeenCalledWith(
      `:question: Task ${JIRA_LINK} needs clarification`,
    );
  });

  it("parent post fails on first event — swallows error, no parent recorded, no thread reply attempted as reply", async () => {
    const store = createThreadStore();
    mockChannelPost.mockRejectedValueOnce(new Error("Slack API down"));
    const adapter = createAdapter(store);

    await expect(
      adapter.notifyForTicket("AWT-42", { kind: "started" }),
    ).resolves.not.toThrow();

    expect(store.setParent).not.toHaveBeenCalled();
    // With no parent, detail falls back to a top-level orphan post.
    expect(mockChannelPost).toHaveBeenCalledTimes(2);
    expect(mockChannelPost).toHaveBeenLastCalledWith(
      `:hourglass_flowing_sand: Task ${JIRA_LINK} started`,
    );
    expect(mockThreadPost).not.toHaveBeenCalled();
  });

  it("thread reply fails because parent vanished mid-flight — clears mapping and posts detail top-level", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    mockThreadPost.mockRejectedValueOnce(
      Object.assign(new Error("gone"), {
        code: "slack_webapi_platform_error",
        data: { error: "thread_not_found" },
      }),
    );
    mockChannelPost.mockResolvedValueOnce({ id: "1700000000.000777" });
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "canceled",
      reason: "left AI column",
    });

    expect(mockEditMessage).toHaveBeenCalled();
    expect(store.clearParent).toHaveBeenCalledWith("AWT-42");
    expect(mockChannelPost).toHaveBeenCalledWith(
      `:no_entry: Task ${JIRA_LINK} canceled: left AI column`,
    );
  });

  it("note — posts the raw message as a thread reply WITHOUT editing the top-level status", async () => {
    const store = createThreadStore();
    store.getParent.mockResolvedValueOnce("1700000000.000111");
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", {
      kind: "note",
      text: "Deploy to staging is done",
    });

    // A standalone message never overwrites the status line or re-anchors the parent.
    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(mockChannelPost).not.toHaveBeenCalled();
    expect(store.setParent).not.toHaveBeenCalled();
    // Just the user's message, no system head/emoji.
    expect(mockThreadPost).toHaveBeenCalledWith("Deploy to staging is done");
  });

  it("note — falls back to a top-level post when no thread parent exists yet", async () => {
    const store = createThreadStore(); // getParent resolves null
    const adapter = createAdapter(store);

    await adapter.notifyForTicket("AWT-42", { kind: "note", text: "Heads up" });

    expect(mockEditMessage).not.toHaveBeenCalled();
    expect(mockThreadPost).not.toHaveBeenCalled();
    expect(mockChannelPost).toHaveBeenCalledWith("Heads up");
  });
});
