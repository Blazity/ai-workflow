import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  getTicketComments,
  postCommentAs,
  deleteTicket,
} from "../helpers/jira.js";
import {
  findPR,
  getPRCommits,
  getFileContent,
  closePR,
  deleteBranch,
} from "../helpers/github.js";
import { getRunId, cleanup as registryCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-6: Clarification answered — ticket re-processed successfully [GitHub]
 *
 * After the agent asks a clarification question and moves the ticket to
 * Backlog, the developer posts an answer as a Jira comment and moves the
 * ticket back to AI. The research phase then reads the comment, the
 * clarity gate passes, and the implementation proceeds to a PR.
 *
 * This covers two full workflow runs in sequence, so the per-test timeout
 * is larger than the project default.
 */
// US-06 answers the clarification from a NON-bot Jira identity. The resume path
// filters the bot's own comments by accountId (resume-from-comments.ts), so
// answering with the bot token (JIRA_API_TOKEN) can never wake the run. The
// test is meaningless without a distinct commenter. Skip the whole suite when
// JIRA_E2E_COMMENTER_TOKEN is absent.
describe.skipIf(!e2eEnv.JIRA_E2E_COMMENTER_TOKEN)(
  "US-06: Clarification answered → ticket completes",
  () => {
  // Unique value so the PR content check can't pass on pre-existing files
  const uniqueGreeting = `Hello from Blazebot US-6 ${Date.now()}`;
  let ticketKey: string;
  let branchName: string;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (prNumber) await closePR(prNumber);
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await registryCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it(
    "uses the developer's answer from comments and implements the ticket",
    async () => {
      // --- Phase A: trigger clarification with a ticket missing a value ---

      const ticket = await createTestTicket({
        summary: "[E2E] Add greeting endpoint with my favorite greeting",
        description: [
          "Create a GET /api/greeting route at app/api/greeting/route.ts",
          "that returns JSON { message: X } with HTTP 200.",
          "",
          "The value of X is my favorite greeting. It is not specified in",
          "this ticket — I will provide it in a follow-up comment.",
          "",
          "Acceptance criteria:",
          "- Route file at app/api/greeting/route.ts",
          "- Exports a GET handler",
          "- Returns JSON: { message: X } where X is my favorite greeting",
          "- HTTP 200 response",
          "- No other files created or modified",
        ].join("\n"),
      });
      ticketKey = ticket.ticketKey;
      branchName = `ai-workflow/${ticketKey.toLowerCase()}`;

      await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
      await callCronPoll();

      // Wait for Backlog (clarification path) — research-only, so fast
      await waitFor(
        async () => {
          const status = await getTicketStatus(ticketKey);
          return status === e2eEnv.COLUMN_BACKLOG ? status : null;
        },
        {
          description: `ticket ${ticketKey} → ${e2eEnv.COLUMN_BACKLOG} (clarification)`,
          timeoutMs: 1_500_000,
        },
      );

      // The parked run must have posted its numbered clarification-questions
      // comment before we answer, same shape us05 asserts (numbered list plus
      // the how-to-answer instructions from comment-format.ts).
      const preAnswerComments = await getTicketComments(ticketKey);
      const clarificationComment = preAnswerComments.find(
        (c) => /^\s*1\.\s/m.test(c.body) && c.body.includes("How to answer:"),
      );
      expect(clarificationComment).toBeDefined();

      // The suspended run KEEPS its bound active_runs claim across the park (it
      // is NOT cleaned up), so the SAME runId can resume from the snapshot once
      // the human answers. Capture it now to prove the resume continues this
      // run rather than starting a fresh dispatch.
      const suspendedRunId = await waitFor(() => getRunId(ticketKey), {
        description: `bound run for parked ${ticketKey}`,
        timeoutMs: 30_000,
      });
      expect(suspendedRunId).not.toBeNull();

      // --- Phase B: developer answers + moves back to AI ---

      // Answer as a SECOND Jira identity. The resume path excludes the bot's
      // own comments by accountId (resume-from-comments.ts), so an answer
      // posted with the bot token (JIRA_API_TOKEN) would be filtered out and
      // could never wake the run. JIRA_E2E_COMMENTER_TOKEN is a distinct user;
      // the suite is skipped when it is absent.
      await postCommentAs(
        ticketKey,
        `1. Use "${uniqueGreeting}" as the message value.`,
        e2eEnv.JIRA_E2E_COMMENTER_TOKEN!,
      );

      await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
      await callCronPoll();

      // The comment + move is the human's commit gesture: cron/webhook detect
      // the bound suspended run and resume it via resumeHook. Because the run
      // never released its active_runs claim, getRunId stays pinned to the SAME
      // suspendedRunId as the resumed run works; a fresh dispatch would surface
      // a different id (and is anyway blocked by the existing claim).
      const resumedRunId = await getRunId(ticketKey);
      expect(resumedRunId).toBe(suspendedRunId);

      // Wait for AI Review — this time the full workflow runs
      await waitFor(
        async () => {
          const status = await getTicketStatus(ticketKey);
          return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
        },
        {
          description: `ticket ${ticketKey} → ${e2eEnv.COLUMN_AI_REVIEW} after answer`,
          timeoutMs: 2_000_000,
        },
      );

      // --- Assert: PR created with the answered value ---

      const pr = await waitFor(() => findPR(branchName), {
        description: `PR on branch ${branchName}`,
        timeoutMs: 60_000,
      });
      prNumber = pr.number;

      const commits = await getPRCommits(prNumber);
      expect(commits.length).toBeGreaterThan(0);

      // The route file must exist on the branch and contain the answered
      // greeting verbatim — proof the agent used the comment, not a guess.
      const routeContent = await getFileContent(
        branchName,
        "app/api/greeting/route.ts",
      );
      expect(routeContent).not.toBeNull();
      expect(routeContent).toMatch(/export\s+(async\s+)?function\s+GET/);
      expect(routeContent).toContain(uniqueGreeting);

      // Registry cleaned up after the implementation run
      await waitFor(
        async () => {
          const runId = await getRunId(ticketKey);
          return runId === null ? true : null;
        },
        {
          description: `Registry clean after implementation for ${ticketKey}`,
          timeoutMs: 30_000,
        },
      );
    },
    4_200_000, // 70 min — two workflow runs back-to-back
  );
});
