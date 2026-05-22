import { describe, expect, it } from "vitest";

const deploymentUrl = process.env.BLAZEBOT_DEPLOYMENT_URL;
if (!deploymentUrl) throw new Error("BLAZEBOT_DEPLOYMENT_URL is not set");

describe("US-27: post-pr-gate webhook rejects invalid HMAC", () => {
  it("returns 401 when X-Hub-Signature-256 is missing", async () => {
    const res = await fetch(`${deploymentUrl}/webhooks/github`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-Hub-Signature-256 is invalid", async () => {
    const res = await fetch(`${deploymentUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });
});
