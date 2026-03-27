import { describe, it, expect } from "vitest";
import { sendJiraWebhook, makeIgnorePayload } from "../helpers/webhook.js";

describe("webhook ignore", () => {
  it("ignores non-status-change events", async () => {
    const payload = makeIgnorePayload("FAKE-999");
    const { status, body } = await sendJiraWebhook(payload);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("ignored");
  });
});
