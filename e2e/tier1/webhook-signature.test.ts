import { describe, it, expect } from "vitest";
import { sendJiraWebhook, makeDispatchPayload } from "../helpers/webhook.js";
import { e2eEnv } from "../env.js";

describe("webhook signature validation", () => {
  const payload = makeDispatchPayload("FAKE-1");

  it("accepts a valid signature", async () => {
    const { status } = await sendJiraWebhook(payload);
    // The ticket doesn't exist in Jira, so dispatch may fail,
    // but the signature was accepted (not 401)
    expect(status).not.toBe(401);
  });

  it("rejects an invalid signature", async () => {
    const { status } = await sendJiraWebhook(payload, {
      invalidSignature: true,
    });
    expect(status).toBe(401);
  });

  it("rejects a missing signature", async () => {
    const { status } = await sendJiraWebhook(payload, {
      omitSignature: true,
    });
    expect(status).toBe(401);
  });

  it("rejects an empty body", async () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const bypass = e2eEnv.VERCEL_AUTOMATION_BYPASS_SECRET;
    if (bypass) {
      headers["x-vercel-protection-bypass"] = bypass;
    }
    const res = await fetch(`${e2eEnv.E2E_BASE_URL}/webhooks/jira`, {
      method: "POST",
      headers,
    });
    expect(res.status).toBe(400);
  });
});
