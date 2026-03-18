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

vi.mock("@slack/web-api", () => {
  const MockWebClient = vi.fn().mockImplementation(function (this: unknown) {
    (this as Record<string, unknown>).chat = { postMessage: vi.fn() };
  });
  return { WebClient: MockWebClient };
});

describe("createMessagingAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns SlackMessagingAdapter when token and channel are provided", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { SlackMessagingAdapter } = await import("./slack-messaging.js");

    const adapter = createMessagingAdapter("slack", "xoxb-test", "#general");

    expect(adapter).toBeInstanceOf(SlackMessagingAdapter);
  });

  it("returns NoopMessagingAdapter when SLACK_BOT_TOKEN is missing", async () => {
    const { createMessagingAdapter } = await import("./messaging-factory.js");
    const { NoopMessagingAdapter } = await import("./noop-messaging.js");

    const adapter = createMessagingAdapter("slack", undefined, "#general");

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

    const adapter = createMessagingAdapter("unknown" as "slack", undefined, undefined);

    expect(adapter).toBeInstanceOf(NoopMessagingAdapter);
  });
});
