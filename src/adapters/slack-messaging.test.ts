import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@slack/web-api", () => {
  const MockWebClient = vi.fn().mockImplementation(function (this: unknown) {
    (this as Record<string, unknown>).chat = { postMessage: mockPostMessage };
  });
  return { WebClient: MockWebClient };
});

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("SlackMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a notification via chat.postMessage", async () => {
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#general");

    await adapter.notify("user-123", "PR ready for review");

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "#general",
      text: "PR ready for review",
    });
  });

  it("sends a ping via chat.postMessage", async () => {
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#alerts");

    await adapter.ping("user-456", "Needs clarification");

    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: "#alerts",
      text: "Needs clarification",
    });
  });

  it("does not throw when Slack API fails on notify", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("channel_not_found"));

    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#gone");

    await expect(adapter.notify("user-123", "test")).resolves.not.toThrow();
  });

  it("does not throw when Slack API fails on ping", async () => {
    mockPostMessage.mockRejectedValueOnce(new Error("channel_not_found"));

    const { SlackMessagingAdapter } = await import("./slack-messaging.js");
    const adapter = new SlackMessagingAdapter("xoxb-test", "#gone");

    await expect(adapter.ping("user-123", "test")).resolves.not.toThrow();
  });

  it("initializes WebClient with the provided token", async () => {
    const { WebClient } = await import("@slack/web-api");
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");

    new SlackMessagingAdapter("xoxb-my-token", "#ch");

    expect(WebClient).toHaveBeenCalledWith("xoxb-my-token");
  });
});
