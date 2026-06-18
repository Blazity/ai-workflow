import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import { findPR, deleteBranch } from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/registry.js";
import {
  stopSandboxesForTicket,
  killClaudeForTicket,
} from "../helpers/sandbox.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-7: Agent failure moves ticket to Backlog
 *
 * When the agent fails mid-run, the ticket should move to Backlog and all
 * resources (Redis entry, sandbox) should be cleaned up. We simulate the
 * failure by killing the claude process inside the research-phase sandbox —
 * the wrapper script's cleanup still touches the sentinel, and
 * parseResearchStatus defaults to `failed` on empty/partial stdout.
 */
describe("US-07: Agent failure moves ticket to Backlog", () => {
  let ticketKey: string;
  let branchName: string;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (branchName) await deleteBranch(branchName).catch(() => {});
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("moves ticket to Backlog and cleans up when the agent fails", async () => {
    // 1. Create a normal, clear ticket — would succeed on the happy path
    const ticket = await createTestTicket({
      summary: "[E2E] Add GET /api/health endpoint",
      description: [
        "Create a GET /api/health route that returns JSON { status: \"ok\" } with HTTP 200.",
        "",
        "Acceptance criteria:",
        "- Route file at app/api/health/route.ts",
        "- Exports a GET handler",
        '- Returns JSON response: { status: "ok" }',
        "- HTTP 200 response",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // 2. Move to AI column — Jira webhook triggers dispatch
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // 3. Poll until the research-phase sandbox exists, then kill claude.
    //    killClaudeForTicket returns true once it finds and pkills the
    //    claude process in the sandbox matching this ticket's branch.
    await waitFor(() => killClaudeForTicket(ticketKey), {
      description: `sandbox ready to kill for ${ticketKey}`,
      timeoutMs: 300_000,
      intervalMs: 10_000,
    });

    // 4. Workflow's pollUntilDone picks up the sentinel within 30s,
    //    collectPhaseOutput reads empty stdout, parseResearchStatus
    //    defaults to `failed`, workflow moves ticket to Backlog.
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_BACKLOG ? status : null;
      },
      {
        description: `ticket ${ticketKey} → ${e2eEnv.COLUMN_BACKLOG}`,
        timeoutMs: 300_000,
      },
    );

    // 5. No PR was created — failure halts before push
    const pr = await findPR(branchName);
    expect(pr).toBeNull();

    // 6. Redis entry cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      { description: `Redis clean for ${ticketKey}`, timeoutMs: 60_000 },
    );

    // 7. No sandbox still running for this ticket. Redis cleanup
    //    (unregisterRun) and sandbox teardown happen in separate workflow
    //    steps — Redis lands first, then teardownSandbox runs in the outer
    //    finally. Poll until the teardown actually completes instead of
    //    asserting immediately.
    await waitFor(
      async () => {
        const stopped = await stopSandboxesForTicket(ticketKey);
        return stopped === 0 ? true : null;
      },
      { description: `sandbox stopped for ${ticketKey}`, timeoutMs: 60_000 },
    );

    // 8. Final status assertion
    const finalStatus = await getTicketStatus(ticketKey);
    expect(finalStatus).toBe(e2eEnv.COLUMN_BACKLOG);
  });
});
