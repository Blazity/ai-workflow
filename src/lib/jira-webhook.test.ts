import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyJiraWebhookSignature,
  parseJiraWebhookEvent,
} from "./jira-webhook.js";

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyJiraWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const body = JSON.stringify({ webhookEvent: "jira:issue_updated" });

  it("returns true for a valid signature", () => {
    const signature = sign(body, secret);
    expect(verifyJiraWebhookSignature(body, signature, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const signature = sign(body, secret);
    const tampered = signature.slice(0, -4) + "dead";
    expect(verifyJiraWebhookSignature(body, tampered, secret)).toBe(false);
  });

  it("returns false when the signature header is undefined", () => {
    expect(verifyJiraWebhookSignature(body, undefined, secret)).toBe(false);
  });
});

describe("parseJiraWebhookEvent", () => {
  const targetColumn = "AI";

  function makePayload(overrides: Record<string, any> = {}) {
    return {
      webhookEvent: "jira:issue_updated",
      issue: { key: "PROJ-42" },
      changelog: {
        items: [{ field: "status", fromString: "To Do", toString: "AI" }],
      },
      ...overrides,
    };
  }

  it("returns relevant: true for a status change to the target column", () => {
    const result = parseJiraWebhookEvent(makePayload(), targetColumn);
    expect(result).toEqual({ ticketKey: "PROJ-42", relevant: true });
  });

  it("returns relevant: false for non-status field changes", () => {
    const payload = makePayload({
      changelog: {
        items: [
          { field: "summary", fromString: "Old title", toString: "New title" },
        ],
      },
    });
    const result = parseJiraWebhookEvent(payload, targetColumn);
    expect(result).toEqual({ ticketKey: "PROJ-42", relevant: false });
  });

  it("returns relevant: false for a status change to a different column", () => {
    const payload = makePayload({
      changelog: {
        items: [
          { field: "status", fromString: "To Do", toString: "In Progress" },
        ],
      },
    });
    const result = parseJiraWebhookEvent(payload, targetColumn);
    expect(result).toEqual({ ticketKey: "PROJ-42", relevant: false });
  });

  it("returns relevant: false for non-issue events", () => {
    const payload = makePayload({ webhookEvent: "jira:worklog_updated" });
    const result = parseJiraWebhookEvent(payload, targetColumn);
    expect(result).toEqual({ ticketKey: "PROJ-42", relevant: false });
  });

  it("returns relevant: false when no changelog is present", () => {
    const payload = makePayload({ changelog: undefined });
    const result = parseJiraWebhookEvent(payload, targetColumn);
    expect(result).toEqual({ ticketKey: "PROJ-42", relevant: false });
  });
});
