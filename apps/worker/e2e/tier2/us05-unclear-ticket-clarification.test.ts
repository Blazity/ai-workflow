import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  getTicketLabels,
  getTicketComments,
  deleteTicket,
} from "../helpers/jira.js";
import { findPR, deleteBranch } from "../helpers/github.js";
import { getRunId, cleanup as registryCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-5: Unclear ticket triggers clarification
 *
 * When a ticket is too vague/subjective to implement, the agent should
 * return status: "clarification_needed", park the run as awaiting (questions
 * live in the dashboard, not in Jira comments), label the ticket
 * needs-clarification, move it to Backlog, and clean up registry/sandbox.
 */
describe("US-05: Unclear ticket triggers clarification", () => {
  let ticketKey: string;
  let branchName: string;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await registryCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("asks clarification questions and moves the ticket to Backlog", async () => {
    // 1. Create a deliberately vague ticket — subjective reference with
    //    no explicit target. This is exactly what the research prompt's
    //    clarity gate is designed to catch.
    const ticket = await createTestTicket({
      summary: "[E2E] Change website color to my favorite color",
      description: [
        "Update the primary brand color across the site to my favorite color.",
        "",
        "My favorite color is not specified anywhere in this ticket.",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // 2. Move to AI column — webhook or cron triggers dispatch
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
    await callCronPoll();

    // 3. Wait for the ticket to land in Backlog — the research phase is
    //    the only phase that runs in this path, so this is much faster
    //    than a full implementation.
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_BACKLOG ? status : null;
      },
      {
        description: `ticket ${ticketKey} → ${e2eEnv.COLUMN_BACKLOG}`,
        timeoutMs: 1_500_000,
      },
    );

    // 4. Questions are no longer posted to Jira: the run parks with the
    //    needs-clarification label and the questions live in the dashboard.
    //    The only comment the workflow posts is the one-time pickup link
    //    to the dashboard ticket view.
    const comments = await getTicketComments(ticketKey);
    const questionComment = comments.find((c) => /^\s*1\.\s/m.test(c.body));
    expect(questionComment).toBeUndefined();
    const pickupComment = comments.find((c) =>
      c.body.includes(`/ticket/${ticketKey}`),
    );
    expect(pickupComment).toBeDefined();
    const labels = await getTicketLabels(ticketKey);
    expect(labels).toContain("needs-clarification");

    // 5. No PR was created — clarification halts before implementation
    const pr = await findPR(branchName);
    expect(pr).toBeNull();

    // 6. Registry entry cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      { description: `Registry clean for ${ticketKey}`, timeoutMs: 30_000 },
    );

    // 7. No sandbox still running for this ticket
    const stopped = await stopSandboxesForTicket(ticketKey);
    expect(stopped).toBe(0);

    // 8. Final status assertion
    const finalStatus = await getTicketStatus(ticketKey);
    expect(finalStatus).toBe(e2eEnv.COLUMN_BACKLOG);
  });
});
