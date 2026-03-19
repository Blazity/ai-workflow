import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWarn = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

vi.mock("chat", () => {
  const MockChat = vi.fn().mockImplementation(function (this: unknown) {
    (this as Record<string, unknown>).channel = vi.fn().mockReturnValue({
      post: vi.fn(),
    });
  });
  return { Chat: MockChat };
});

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn().mockReturnValue({ type: "slack-adapter" }),
}));

describe("createMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ChatSDKMessagingAdapter when token and channel are provided", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { ChatSDKMessagingAdapter } = await import("./chatsdk-messaging.js");

    const adapter = createMessagingAdapter("slack", "xoxb-test", "C123ABC");

    expect(adapter).toBeInstanceOf(ChatSDKMessagingAdapter);
  });

  it("passes bot token to createSlackAdapter", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { createSlackAdapter } = await import("@chat-adapter/slack");

    createMessagingAdapter("slack", "xoxb-test", "C123ABC");

    expect(createSlackAdapter).toHaveBeenCalledWith({
      botToken: "xoxb-test",
    });
  });

  it("returns NoopMessagingAdapter when SLACK_BOT_TOKEN is missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", undefined, "C123ABC");

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_BOT_TOKEN"),
    );
  });

  it("returns NoopMessagingAdapter when SLACK_DEFAULT_CHANNEL is missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", "xoxb-test", undefined);

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining("SLACK_DEFAULT_CHANNEL"),
    );
  });

  it("returns NoopMessagingAdapter when both credentials are missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", undefined, undefined);

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
  });

  it("returns NoopMessagingAdapter for unknown messaging kind", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter(
      "unknown" as "slack",
      undefined,
      undefined,
    );

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
  });
});
