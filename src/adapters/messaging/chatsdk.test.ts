import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatSDKAdapter } from "./chatsdk.js";

const mockPost = vi.fn();
const mockChannel = vi.fn(() => ({ post: mockPost }));

vi.mock("chat", () => ({
  Chat: vi.fn(() => ({ channel: mockChannel })),
}));

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn(() => ({})),
}));

describe("ChatSDKAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ id: "msg-1" });
  });

  it("sends notification to configured channel", async () => {
    const adapter = new ChatSDKAdapter({
      slackToken: "xoxb-test",
      channelId: "C123",
      botName: "blazebot",
    });

    await adapter.notify("PR ready for review");

    expect(mockChannel).toHaveBeenCalledWith("slack:C123");
    expect(mockPost).toHaveBeenCalledWith("PR ready for review");
  });

  it("does not throw on notification failure", async () => {
    mockPost.mockRejectedValueOnce(new Error("Slack API down"));

    const adapter = new ChatSDKAdapter({
      slackToken: "xoxb-test",
      channelId: "C123",
      botName: "blazebot",
    });

    await expect(adapter.notify("test")).resolves.not.toThrow();
  });
});
