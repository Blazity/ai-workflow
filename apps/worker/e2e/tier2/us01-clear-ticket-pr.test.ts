import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import {
  findPR,
  getPRCommits,
  getPRFiles,
  getFileContent,
  closePR,
  deleteBranch,
} from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-1: Clear ticket produces a PR [GitHub]
 *
 * When a ticket with clear requirements is moved to the AI column,
 * the agent implements the feature and creates a PR for review.
 */
describe("US-01: Clear ticket produces a PR", () => {
  let ticketKey: string;
  let branchName: string;
  let prNumber: number | undefined;

  afterAll(async () => {
    if (ticketKey) await stopSandboxesForTicket(ticketKey).catch(() => {});
    if (prNumber) await closePR(prNumber);
    if (branchName) await deleteBranch(branchName);
    if (ticketKey) {
      await redisCleanup(ticketKey);
      await deleteTicket(ticketKey);
    }
  });

  it("implements a clear ticket and creates a PR on the correct branch", async () => {
    // 1. Create ticket with very specific requirements so we can validate the output
    const ticket = await createTestTicket({
      summary: "[E2E] Add GET /api/health endpoint",
      description: [
        "Create a GET /api/health route that returns JSON { status: \"ok\" } with HTTP 200.",
        "",
        "Acceptance criteria:",
        '- Route file at app/api/health/route.ts',
        '- Exports a GET handler',
        '- Returns JSON response: { status: "ok" }',
        "- HTTP 200 response",
        "- No other files created or modified",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // 2. Move to AI column — webhook or cron triggers dispatch
    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);
    await callCronPoll();

    // 3. Wait for PR to appear on the expected branch
    const pr = await waitFor(() => findPR(branchName), {
      description: `PR on branch ${branchName}`,
      timeoutMs: 2_000_000,
    });
    prNumber = pr.number;

    // 4. PR has at least 1 commit
    const commits = await getPRCommits(prNumber);
    expect(commits.length).toBeGreaterThan(0);

    // 5. PR contains the health route file
    const prFiles = await getPRFiles(prNumber);
    const filenames = prFiles.map((f) => f.filename);
    expect(filenames.some((f) => f.includes("health/route"))).toBe(true);

    // 6. Route file exports a GET handler and returns { status: "ok" }
    const routeContent = await getFileContent(
      branchName,
      "app/api/health/route.ts",
    );
    expect(routeContent).not.toBeNull();
    expect(routeContent).toMatch(/export\s+(async\s+)?function\s+GET/);
    expect(routeContent).toContain('"ok"');

    // 7. Ticket moved to AI Review
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
      },
      { description: `ticket ${ticketKey} → ${e2eEnv.COLUMN_AI_REVIEW}`, timeoutMs: 60_000 },
    );

    // 8. Redis entry cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      { description: `Redis clean for ${ticketKey}`, timeoutMs: 30_000 },
    );
  });
});
