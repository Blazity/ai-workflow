import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "../helpers/jira.js";
import {
  createBranch,
  createOrUpdateFile,
  openPR,
  findPR,
  getPRCommits,
  getPRFiles,
  getFileContent,
  addPRComment,
  closePR,
  deleteBranch,
} from "../helpers/github.js";
import { getRunId, cleanup as redisCleanup } from "../helpers/registry.js";
import { stopSandboxesForTicket } from "../helpers/sandbox.js";
import { callCronPoll } from "../helpers/cron.js";
import { waitFor } from "../helpers/wait.js";
import { e2eEnv } from "../env.js";

/**
 * US-3: Review feedback triggers a fix cycle [GitHub]
 *
 * When a developer leaves review comments on the agent's PR and moves
 * the ticket back to AI, the agent addresses the feedback and pushes
 * updates to the same PR — no duplicate PR created.
 *
 * Setup uses GitHub API to create branch + code + PR in seconds,
 * instead of waiting for a full workflow run.
 */
describe("US-03: Review feedback triggers a fix cycle", () => {
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

  it("addresses review comments and pushes updates to the same PR", async () => {
    // --- Setup: create ticket + branch + initial code + PR via GitHub API ---

    const ticket = await createTestTicket({
      summary: "[E2E] Add GET /api/ping endpoint",
      description: [
        "Add a GET /api/ping API route that returns JSON { ping: 'pong' } with status 200.",
        "",
        "Acceptance criteria:",
        "- Route file at app/api/ping/route.ts",
        "- Exports a GET handler function",
        '- Returns JSON response: { ping: "pong" }',
        "- HTTP 200 response",
        "- No other files created or modified",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    // Create branch with a simple implementation
    await createBranch(branchName);
    await createOrUpdateFile(
      branchName,
      "app/api/ping/route.ts",
      [
        'import { NextResponse } from "next/server";',
        "",
        "export async function GET() {",
        '  return NextResponse.json({ ping: "pong" });',
        "}",
        "",
      ].join("\n"),
      "feat: add GET /api/ping endpoint",
    );

    // Create PR and record initial commit count
    const pr = await openPR(
      branchName,
      `[${ticketKey}] Add GET /api/ping endpoint`,
    );
    prNumber = pr.number;

    const commitsBefore = await getPRCommits(prNumber);
    const commitCountBefore = commitsBefore.length;

    // Review feedback: explicit rename instruction. Previous iterations used
    // "delete + create" wording which the agent sometimes interpreted as
    // "edit in place at the original path" — phrasing as a rename makes the
    // destination path unambiguous.
    await addPRComment(
      prNumber,
      [
        "Please rename this endpoint from /api/ping to /api/healthcheck.",
        "",
        "Concretely:",
        "- Move the route file from app/api/ping/route.ts to app/api/healthcheck/route.ts",
        '- Update the GET handler to return JSON { healthcheck: "passed" }',
        "- The old /api/ping route must no longer exist after this change",
        "- No other files should be created or modified",
      ].join("\n"),
    );

    // --- Act: move ticket to AI to trigger the review-fix workflow ---

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // Poke cron to ensure dispatch if webhook didn't fire
    await callCronPoll();

    // --- Assert ---

    // Ticket moves to AI Review (workflow completed)
    await waitFor(
      async () => {
        const status = await getTicketStatus(ticketKey);
        return status === e2eEnv.COLUMN_AI_REVIEW ? status : null;
      },
      {
        description: `ticket → ${e2eEnv.COLUMN_AI_REVIEW} after review-fix`,
        timeoutMs: 2_000_000,
      },
    );

    // PR has more commits than before the review fix
    const commitsAfter = await getPRCommits(prNumber);
    expect(commitsAfter.length).toBeGreaterThan(commitCountBefore);

    // No duplicate PR — same PR number is still the only open PR for this branch
    const currentPR = await findPR(branchName);
    expect(currentPR).not.toBeNull();
    expect(currentPR!.number).toBe(prNumber);

    // Healthcheck route file exists on the branch with the new response body.
    const routeContent = await getFileContent(
      branchName,
      "app/api/healthcheck/route.ts",
    );
    expect(routeContent).not.toBeNull();
    expect(routeContent).toMatch(/export\s+(async\s+)?function\s+GET/);
    expect(routeContent).toContain('"passed"');

    // Old ping route must be gone — the review asked to rename, not to
    // leave a stale endpoint behind.
    const oldRoute = await getFileContent(branchName, "app/api/ping/route.ts");
    expect(oldRoute).toBeNull();

    // PR diff reflects the rename on both sides. GitHub reports renames
    // either as a single "renamed" entry with filename=new path, or as a
    // remove+add pair — either way the new path appears in the list, and
    // the old path does not appear as a surviving file.
    const prFiles = await getPRFiles(prNumber);
    const filenames = prFiles.map((f) => f.filename);
    expect(filenames.some((f) => f.includes("healthcheck"))).toBe(true);

    // Redis cleaned up
    await waitFor(
      async () => {
        const runId = await getRunId(ticketKey);
        return runId === null ? true : null;
      },
      { description: `Redis clean for ${ticketKey}`, timeoutMs: 30_000 },
    );
  });
});
