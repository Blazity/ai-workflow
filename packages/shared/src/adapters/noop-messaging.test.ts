import { describe, it, expect } from "vitest";
import { NoopMessagingAdapter } from "./noop-messaging.js";

describe("NoopMessagingAdapter", () => {
  it("implements MessagingAdapter interface", () => {
    const adapter = new NoopMessagingAdapter();
    expect(typeof adapter.notify).toBe("function");
    expect(typeof adapter.ping).toBe("function");
  });

  it("notify resolves without doing anything", async () => {
    const adapter = new NoopMessagingAdapter();
    await expect(adapter.notify("user", "message")).resolves.toBeUndefined();
  });

  it("ping resolves without doing anything", async () => {
    const adapter = new NoopMessagingAdapter();
    await expect(adapter.ping("user", "message")).resolves.toBeUndefined();
  });
});
