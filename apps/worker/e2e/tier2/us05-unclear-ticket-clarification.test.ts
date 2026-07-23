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
 * return status: "clarification_needed" and park the run as awaiting: post a
 * numbered clarification-questions comment (plus the one-time pickup link) to
 * Jira, label the ticket needs-clarification, move it to Backlog, snapshot and
 * stop the sandbox, and KEEP the bound active_runs claim so the same run can
 * later resume from the snapshot when a human answers.
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
    branchName = `ai-workflow/${ticketKey.toLowerCase()}`;

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

    // 4. The parked run posts a numbered clarification-questions comment
    //    (best-effort postClarificationQuestionsCommentStep) alongside the
    //    one-time pickup link. The questions comment carries a numbered list
    //    AND the how-to-answer instructions from comment-format.ts, so a human
    //    can answer straight from Jira. Match a stable substring, not the whole
    //    template, so copy tweaks don't break the test.
    const comments = await getTicketComments(ticketKey);
    const questionComment = comments.find(
      (c) => /^\s*1\.\s/m.test(c.body) && c.body.includes("How to answer:"),
    );
    expect(questionComment).toBeDefined();
    const pickupComment = comments.find((c) =>
      c.body.includes(`/ticket/${ticketKey}`),
    );
    expect(pickupComment).toBeDefined();
    const labels = await getTicketLabels(ticketKey);
    expect(labels).toContain("needs-clarification");

    // 5. No PR was created — clarification halts before implementation
    const pr = await findPR(branchName);
    expect(pr).toBeNull();

    // 6. The suspended run deliberately KEEPS its bound active_runs claim while
    //    parked: the registry entry is NOT cleaned up, so the SAME runId can
    //    resume from the snapshot once a human answers. Assert the claim is
    //    present and stays present across a short recheck.
    const parkedRunId = await waitFor(() => getRunId(ticketKey), {
      description: `bound run for parked ${ticketKey}`,
      timeoutMs: 30_000,
    });
    expect(parkedRunId).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await getRunId(ticketKey)).toBe(parkedRunId);

    // 7. No sandbox is still running for this ticket. The clarification
    //    snapshot step (clarification-snapshot-steps.ts) snapshots the source
    //    workspace and polls until Sandbox.get reports it `stopped` before the
    //    run parks, so nothing is left running to stop here.
    const stopped = await stopSandboxesForTicket(ticketKey);
    expect(stopped).toBe(0);

    // 8. Final status assertion
    const finalStatus = await getTicketStatus(ticketKey);
    expect(finalStatus).toBe(e2eEnv.COLUMN_BACKLOG);
  });
});
