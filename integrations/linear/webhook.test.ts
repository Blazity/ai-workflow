/**
 * What the Linear integration makes of a delivery, against real recorded bytes.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webhook } from "./webhook";

const SECRET = "a-shared-linear-secret";

function recorded(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}.json`, import.meta.url), "utf8");
}

const accountId = vi.fn(async () => "viewer-account-id");

vi.mock("./issue-tracker", () => ({
  LinearAdapter: class {
    getCurrentUserAccountId() {
      return accountId();
    }
  },
}));

function context(overrides: { projectKey?: string; webhookSecret?: string | undefined } = {}) {
  return {
    connection: {
      apiToken: "lin_api_key_test",
      projectKey: overrides.projectKey ?? "CUK",
      webhookSecret: "webhookSecret" in overrides ? overrides.webhookSecret : SECRET,
    },
    signal: new AbortController().signal,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { fetch: vi.fn() },
  } as never;
}

function request(nameOrBody: string, options: { signature?: string | null; isRaw?: boolean } = {}) {
  const rawBody = options.isRaw ? nameOrBody : recorded(nameOrBody);
  const hasSignatureHeader = options.signature !== null;
  const signature =
    options.signature === null
      ? undefined
      : (options.signature ??
        createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex"));
  return {
    method: "POST",
    rawBody,
    headers: {
      "content-type": "application/json",
      ...(hasSignatureHeader && signature !== undefined ? { "linear-signature": signature } : {}),
    },
    query: {},
  } as never;
}

describe("the Linear integration's webhook", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1792618983427);
    vi.clearAllMocks();
    accountId.mockResolvedValue("viewer-account-id");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("verifying who sent it", () => {
    it("refuses with 503 and tells the operator what to add when no secret is set", async () => {
      const reception = await webhook.receive(
        request("issue-updated-status-change"),
        context({ webhookSecret: undefined }),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 503 });
      expect(reception.kind === "refused" && reception.reason).toContain("secret");
    });

    it("refuses an unsigned delivery", async () => {
      const reception = await webhook.receive(
        request("issue-updated-status-change", { signature: null }),
        context(),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 401 });
      expect(reception.kind === "refused" && reception.reason).toContain("no signature");
    });

    it("refuses a signature computed with another secret", async () => {
      const rawBody = recorded("issue-updated-status-change");
      const forged = createHmac("sha256", "someone-else").update(rawBody, "utf8").digest("hex");

      const reception = await webhook.receive(
        request("issue-updated-status-change", { signature: forged }),
        context(),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 401 });
      expect(reception.kind === "refused" && reception.reason).toContain("did not match");
    });

    it("refuses an empty signature", async () => {
      const reception = await webhook.receive(
        request("issue-updated-status-change", { signature: "" }),
        context(),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 401 });
      expect(reception.kind === "refused" && reception.reason).toContain("no signature");
    });

    it("refuses a delivery whose timestamp is outside the 60-second window", async () => {
      const stalePayload = JSON.stringify({
        action: "update",
        type: "Issue",
        webhookTimestamp: 1792618983427 - 120_000,
        data: { identifier: "CUK-16", team: { key: "CUK" } },
      });

      const reception = await webhook.receive(
        request(stalePayload, { isRaw: true }),
        context(),
      );

      expect(reception).toEqual({
        kind: "refused",
        status: 401,
        reason: "The delivery timestamp is outside the accepted window.",
      });
    });

    it("never asks the provider anything about a delivery it refused", async () => {
      await webhook.receive(
        request("issue-updated-status-change", { signature: "deadbeef" }),
        context(),
      );

      expect(accountId).not.toHaveBeenCalled();
    });
  });

  describe("what it makes of a verified delivery", () => {
    it("reads the issue, its status and the status this delivery changed", async () => {
      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [
          {
            ticketKey: "CUK-16",
            status: "In Progress",
            statusId: "75a9e150-4a59-4864-b7be-6a7bb43e08b8",
            statusChange: {
              id: "75a9e150-4a59-4864-b7be-6a7bb43e08b8",
              name: "In Progress",
            },
          },
        ],
      });
    });

    it("carries a comment delivery with actor 'other' without querying the provider", async () => {
      const reception = await webhook.receive(request("comment-created"), context());

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [
          {
            ticketKey: "CUK-16",
            status: null,
            statusChange: null,
            actor: "other",
          },
        ],
      });
      expect(accountId).not.toHaveBeenCalled();
    });

    it("handles unparseable json body", async () => {
      const reception = await webhook.receive(
        request("invalid json payload", { isRaw: true }),
        context(),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [],
        ignored: { reason: "unparseable_body" },
      });
    });

    it("ignores payloads with no ticket key", async () => {
      const emptyIssuePayload = JSON.stringify({
        action: "update",
        type: "Issue",
        webhookTimestamp: 1792618983427,
        data: { id: "123", team: { key: "CUK" } },
      });

      const reception = await webhook.receive(
        request(emptyIssuePayload, { isRaw: true }),
        context(),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [],
        ignored: { reason: "no_ticket_key" },
      });
    });

    it("ignores deliveries for a team this connection does not watch", async () => {
      const reception = await webhook.receive(
        request("issue-updated-status-change"),
        context({ projectKey: "OTHER" }),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [],
        ignored: { reason: "wrong_project", ticketKey: "CUK-16" },
      });
    });
  });

  describe("who acted", () => {
    it("reports our own account moving the ticket as self", async () => {
      accountId.mockResolvedValue("9269b25b-5b9a-464c-85f1-be8d77a186e7");

      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({ events: [{ actor: "self" }] });
    });

    it("reports anybody else as other", async () => {
      accountId.mockResolvedValue("some-other-user-id");

      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({ events: [{ actor: "other" }] });
    });

    it("reports unknown when the tracker cannot say who we are", async () => {
      accountId.mockRejectedValue(new Error("Linear viewer: 401"));

      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({ events: [{ actor: "unknown" }] });
    });
  });
});
