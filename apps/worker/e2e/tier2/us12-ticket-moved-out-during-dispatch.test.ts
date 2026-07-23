import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import { findPR, deleteBranch } from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { postJiraWebhook } from "../helpers/webhook.js";
import { e2eEnv } from "../env.js";

/**
 * US-12: Ticket moved out of AI during dispatch
 *
 * Race: webhook payload says `status = AI`, but by the time the handler fetches
 * the live ticket from Jira, it has already moved to another column. Dispatch
 * must abort cleanly: fetch sees the live status is not AI, unregisters the
 * claim, and returns `not_in_ai_column`. No workflow starts; no resources leak.
 *
 * We reproduce this deterministically by keeping the ticket in Backlog and
 * hand-crafting a webhook payload that lies about the status. The handler
 * signs its own HMAC check with `JIRA_WEBHOOK_SECRET`, then dispatch hits the
 * live-status precheck and bails.
 */
describe("US-12: Ticket moved out of AI during dispatch", () => {
  let ticketKey: string;
  let branchName: string;

  beforeAll(() => {
    if (!e2eEnv.JIRA_WEBHOOK_SECRET) {
      throw new Error(
        "US-12 requires JIRA_WEBHOOK_SECRET in the e2e env (matches deployed config).",
      );
    }
  });

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("aborts dispatch when live ticket status is no longer AI", async () => {
    // 1. Create a ticket and ensure it is NOT in AI — Backlog is the usual
    //    destination for freshly created tickets, but move explicitly to be
    //    defensive against project workflow changes.
    const ticket = await createTestTicket({
      summary: "[E2E] Moved-out-of-AI race guard",
      description: "Ticket never enters AI; webhook lies, dispatch must bail.",
    });
    ticketKey = ticket.ticketKey;
    branchName = `ai-workflow/${ticketKey.toLowerCase()}`;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_BACKLOG);
    expect(await getTicketStatus(ticketKey)).toBe(e2eEnv.COLUMN_BACKLOG);

    // 2. Fire a signed webhook claiming the ticket is in AI. The handler
    //    validates the signature, dispatches, then fetches the live ticket
    //    and sees it is actually in Backlog.
    const { status, body } = await postJiraWebhook({
      ticketKey,
      status: e2eEnv.COLUMN_AI,
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "skipped",
      ticketKey,
      reason: "not_in_ai_column",
    });

    // 3. Claim was released — no Redis entry for this ticket.
    expect(await getRunId(ticketKey)).toBeNull();

    // 4. No PR, no sandbox, ticket still in Backlog.
    expect(await findPR(branchName)).toBeNull();
    expect(await stopSandboxesForTicket(ticketKey)).toBe(0);
    expect(await getTicketStatus(ticketKey)).toBe(e2eEnv.COLUMN_BACKLOG);
  });
});
