import { describe, it, expect, afterAll } from "vitest";
import {
  createTestTicket,
  moveTicketToColumn,
  getTicketStatus,
  deleteTicket,
} from "./helpers/jira.js";
import { findPR, deleteBranch } from "./helpers/github.js";
import { cleanup as redisCleanup } from "./helpers/redis.js";
import { stopSandboxesForTicket } from "./helpers/sandbox.js";
import { waitFor } from "./helpers/wait.js";
import { e2eEnv } from "./env.js";

const HAVE_CODEX = Boolean(process.env.CODEX_API_KEY);
const guard = HAVE_CODEX ? describe : describe.skip;

guard("Codex Tier-1: clear ticket → PR via codex exec", () => {
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

  it("provisions a Codex sandbox, commits, and opens a PR", async () => {
    // Sanity — the harness must already have AGENT_KIND=codex set in process.env
    expect(process.env.AGENT_KIND).toBe("codex");

    const ticket = await createTestTicket({
      summary: "[E2E codex] Add GET /api/health endpoint",
      description: [
        "Create a GET /api/health route that returns JSON { status: \"ok\" } with HTTP 200.",
        "Acceptance:",
        "- Route file at app/api/health/route.ts",
        "- Returns { status: \"ok\" } with HTTP 200",
      ].join("\n"),
    });
    ticketKey = ticket.ticketKey;
    branchName = `blazebot/${ticketKey.toLowerCase()}`;

    await moveTicketToColumn(ticketKey, e2eEnv.COLUMN_AI);

    // Wait for the workflow to push a commit and open the PR.
    const pr = await waitFor(async () => findPR(branchName), { timeoutMs: 30 * 60_000, intervalMs: 30_000 });
    expect(pr).not.toBeNull();

    // Ticket should land in AI Review.
    await waitFor(async () => {
      const s = await getTicketStatus(ticketKey);
      return s === e2eEnv.COLUMN_AI_REVIEW ? s : null;
    }, { timeoutMs: 5 * 60_000 });
  });
});
