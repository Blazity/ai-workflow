import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StateAdapter } from "chat";

const mockPost = vi.fn().mockResolvedValue({ id: "msg-1" });
const mockChannel = vi.fn().mockReturnValue({ post: mockPost });

vi.mock("chat", () => {
  const MockChat = vi.fn().mockImplementation(function (this: unknown) {
    (this as Record<string, unknown>).channel = mockChannel;
  });
  return { Chat: MockChat };
});

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("ChatSDKMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a notification via channel.post", async () => {
    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {}, state: {} as StateAdapter });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C123ABC");

    await adapter.notify("user-123", "PR ready for review");

    expect(mockChannel).toHaveBeenCalledWith("slack:C123ABC");
    expect(mockPost).toHaveBeenCalledWith("PR ready for review");
  });

  it("sends a ping via channel.post", async () => {
    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {}, state: {} as StateAdapter });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C456DEF");

    await adapter.ping("user-456", "Needs clarification");

    expect(mockChannel).toHaveBeenCalledWith("slack:C456DEF");
    expect(mockPost).toHaveBeenCalledWith("Needs clarification");
  });

  it("does not throw when channel.post fails on notify", async () => {
    mockPost.mockRejectedValueOnce(new Error("channel_not_found"));

    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {}, state: {} as StateAdapter });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C999");

    await expect(adapter.notify("user-123", "test")).resolves.not.toThrow();
  });

  it("does not throw when channel.post fails on ping", async () => {
    mockPost.mockRejectedValueOnce(new Error("channel_not_found"));

    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");
    const { Chat } = await import("chat");
    const chat = new Chat({ userName: "test", adapters: {}, state: {} as StateAdapter });
    const adapter = new ChatSDKMessagingAdapter(chat, "slack", "C999");

    await expect(adapter.ping("user-123", "test")).resolves.not.toThrow();
  });
});
