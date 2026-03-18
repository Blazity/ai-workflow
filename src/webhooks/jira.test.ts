import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { parseJiraWebhook, verifyJiraWebhookSignature } from "./jira.js";

const validPayload = {
  user: {
    accountId: "abc123",
    displayName: "Mia Krystof",
  },
  issue: {
    key: "PROJ-42",
  },
  changelog: {
    items: [
      {
        field: "status",
        fieldtype: "jira",
        fromString: "To Do",
        toString: "AI",
      },
    ],
  },
};

describe("verifyJiraWebhookSignature", () => {
  const secret = "test-secret";
  const body = Buffer.from('{"test":true}');
  const validSig =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("returns true for a valid signature", () => {
    expect(verifyJiraWebhookSignature(body, validSig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    expect(verifyJiraWebhookSignature(body, "sha256=bad", secret)).toBe(false);
  });

  it("returns false when signature is undefined", () => {
    expect(verifyJiraWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it("returns false when body has been tampered with", () => {
    const tampered = Buffer.from('{"test":false}');
    expect(verifyJiraWebhookSignature(tampered, validSig, secret)).toBe(false);
  });
});

describe("parseJiraWebhook", () => {
  it("parses a valid status transition payload", () => {
    const result = parseJiraWebhook(validPayload);

    expect(result).toEqual({
      type: "ticket_moved",
      ticketId: "PROJ-42",
      fromColumn: "To Do",
      toColumn: "AI",
      triggeredBy: "Mia Krystof",
      triggeredByAccountId: "abc123",
    });
  });

  it("returns null when changelog has no status change", () => {
    const payload = {
      ...validPayload,
      changelog: {
        items: [
          {
            field: "summary",
            fieldtype: "jira",
            fromString: "Old title",
            toString: "New title",
          },
        ],
      },
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null when changelog is missing", () => {
    const payload = {
      user: validPayload.user,
      issue: validPayload.issue,
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null when changelog items is empty", () => {
    const payload = {
      ...validPayload,
      changelog: { items: [] },
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null for malformed payload (missing issue)", () => {
    const payload = {
      user: validPayload.user,
      changelog: validPayload.changelog,
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("returns null for malformed payload (missing user)", () => {
    const payload = {
      issue: validPayload.issue,
      changelog: validPayload.changelog,
    };

    expect(parseJiraWebhook(payload)).toBeNull();
  });

  it("handles null fromString on initial ticket creation", () => {
    const payload = {
      ...validPayload,
      changelog: {
        items: [
          {
            field: "status",
            fieldtype: "jira",
            fromString: null,
            toString: "AI",
          },
        ],
      },
    };

    const result = parseJiraWebhook(payload);
    expect(result).toEqual({
      type: "ticket_moved",
      ticketId: "PROJ-42",
      fromColumn: "",
      toColumn: "AI",
      triggeredBy: "Mia Krystof",
      triggeredByAccountId: "abc123",
    });
  });

  it("handles multiple changelog items and picks the status one", () => {
    const payload = {
      ...validPayload,
      changelog: {
        items: [
          {
            field: "assignee",
            fieldtype: "jira",
            fromString: "Alice",
            toString: "Bob",
          },
          {
            field: "status",
            fieldtype: "jira",
            fromString: "Backlog",
            toString: "AI In Progress",
          },
        ],
      },
    };

    const result = parseJiraWebhook(payload);
    expect(result).toEqual({
      type: "ticket_moved",
      ticketId: "PROJ-42",
      fromColumn: "Backlog",
      toColumn: "AI In Progress",
      triggeredBy: "Mia Krystof",
      triggeredByAccountId: "abc123",
    });
  });
});
