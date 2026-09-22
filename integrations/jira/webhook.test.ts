/**
 * What the Jira integration makes of a delivery, against real recorded bytes.
 *
 * This is the provider half only: the signature, Jira's own envelope, which
 * project this connection watches, and who acted. What a ticket moving means
 * for a run is core's and is tested in
 * `apps/worker/src/routes/webhooks/jira-ticket-webhook.characterisation.test.ts`.
 *
 * Every payload is bytes from a real Jira Cloud delivery, with its source URL,
 * its retrieval date and its SHA-256 in the `.source.txt` beside it. The first
 * test re-computes those digests, so a fixture edited to make a test pass
 * fails loudly instead.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webhook } from "./webhook";

const SECRET = "a-shared-secret";

function recorded(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}.json`, import.meta.url), "utf8");
}

function provenance(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}.source.txt`, import.meta.url), "utf8");
}

const FIXTURES = [
  "issue-updated-status-change",
  "issue-updated-no-status-change",
  "issue-created",
  "comment-created",
  "payload-without-issue",
] as const;

const accountId = vi.fn(async () => "99:the-workflow-account");

vi.mock("./issue-tracker", () => ({
  JiraAdapter: class {
    getCurrentUserAccountId() {
      return accountId();
    }
  },
}));

function context(overrides: { projectKey?: string; webhookSecret?: string | undefined } = {}) {
  return {
    connection: {
      baseUrl: "https://zulipp.atlassian.net",
      apiToken: "token",
      projectKey: overrides.projectKey ?? "ABC",
      webhookSecret: "webhookSecret" in overrides ? overrides.webhookSecret : SECRET,
    },
    signal: new AbortController().signal,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    http: { fetch: vi.fn() },
  } as never;
}

function request(name: string, options: { signature?: string | null } = {}) {
  const rawBody = recorded(name);
  const signature =
    options.signature === null
      ? undefined
      : (options.signature ??
        `sha256=${createHmac("sha256", SECRET).update(rawBody, "utf8").digest("hex")}`);
  return {
    method: "POST",
    rawBody,
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-hub-signature": signature } : {}),
    },
    query: {},
  } as never;
}

describe("the Jira integration's webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountId.mockResolvedValue("99:the-workflow-account");
  });

  it("holds each recorded delivery at the bytes its provenance records", () => {
    for (const name of FIXTURES) {
      const digest = createHash("sha256").update(recorded(name)).digest("hex");
      expect(provenance(name), name).toContain(digest);
    }
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
    });

    it("refuses a signature computed with another secret", async () => {
      const rawBody = recorded("issue-updated-status-change");
      const forged = `sha256=${createHmac("sha256", "someone-else").update(rawBody, "utf8").digest("hex")}`;

      const reception = await webhook.receive(
        request("issue-updated-status-change", { signature: forged }),
        context(),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 401 });
    });

    it("refuses a signature header with no algorithm in it", async () => {
      const reception = await webhook.receive(
        request("issue-updated-status-change", { signature: "deadbeef" }),
        context(),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 401 });
    });

    it("refuses rather than throwing when the header names a hash we cannot compute", async () => {
      // The algorithm comes from the sender's own header, which is the known
      // defect this file carries across unchanged. What must not happen either
      // way is an unhandled throw turning a forged request into a 500.
      const reception = await webhook.receive(
        request("issue-updated-status-change", { signature: "not-a-hash=aabb" }),
        context(),
      );

      expect(reception).toMatchObject({ kind: "refused", status: 401 });
    });

    it("never asks the provider anything about a delivery it refused", async () => {
      await webhook.receive(
        request("issue-updated-status-change", { signature: "sha256=00" }),
        context(),
      );

      expect(accountId).not.toHaveBeenCalled();
    });
  });

  describe("what it makes of a verified delivery", () => {
    it("reads the ticket, its status and the status this delivery changed", async () => {
      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [
          {
            // No provider field, deliberately: the subject key a run is
            // claimed under is derived once, in core, from the integration
            // serving the capability. See `TrackerTicketEvent`.
            ticketKey: "TEST-1",
            status: "In Progress",
            statusId: "3",
            statusChange: { id: "3", name: "In Progress" },
          },
        ],
      });
    });

    it("says a status was not changed when the delivery changed something else", async () => {
      const reception = await webhook.receive(
        request("issue-updated-no-status-change"),
        context({ projectKey: "TEST" }),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [{ ticketKey: "TEST-1", status: "To Do", statusChange: null }],
      });
    });

    it("carries a ticket that was just created, which changes no status", async () => {
      const reception = await webhook.receive(
        request("issue-created"),
        context({ projectKey: "BUG" }),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [{ ticketKey: "BUG-15", status: "Open", statusChange: null }],
      });
    });

    it("carries a comment delivery, which names no actor at all", async () => {
      const reception = await webhook.receive(
        request("comment-created"),
        context({ projectKey: "SP" }),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [{ ticketKey: "SP-1", actor: "other" }],
      });
    });

    it("says there is nothing here when the delivery names no ticket", async () => {
      const reception = await webhook.receive(request("payload-without-issue"), context());

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [],
        ignored: { reason: "no_ticket_key" },
      });
    });

    it("says there is nothing here for a project this connection does not watch", async () => {
      const reception = await webhook.receive(
        request("issue-updated-status-change"),
        context({ projectKey: "SOMETHING-ELSE" }),
      );

      expect(reception).toMatchObject({
        kind: "ticket_events",
        events: [],
        ignored: { reason: "wrong_project", ticketKey: "TEST-1" },
      });
    });
  });

  describe("who acted", () => {
    it("reports our own account moving the ticket as self", async () => {
      accountId.mockResolvedValue("99:b8d8a054-2e12-4839-bd5f-5f2b7c5f5e3a");

      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({ events: [{ actor: "self" }] });
    });

    it("reports anybody else as other", async () => {
      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({ events: [{ actor: "other" }] });
    });

    it("reports unknown, not other, when the tracker cannot say who we are", async () => {
      // A token without permission to read its own account. Saying "other"
      // here would be a guess that reads every one of the product's own ticket
      // moves as a person pulling the ticket out, with nothing in any log to
      // say the check had stopped working.
      accountId.mockRejectedValue(new Error("Jira /myself: 401"));

      const reception = await webhook.receive(request("issue-updated-status-change"), context());

      expect(reception).toMatchObject({ events: [{ actor: "unknown" }] });
    });

    it("does not spend a provider request on a delivery that moved nothing", async () => {
      // Asking "was that me" can only change the answer for a real status
      // change, and this runs on the provider's clock.
      await webhook.receive(
        request("issue-updated-no-status-change"),
        context({ projectKey: "TEST" }),
      );

      expect(accountId).not.toHaveBeenCalled();
    });
  });
});
