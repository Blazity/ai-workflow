import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../test-db.js";
import type { Db } from "../../client.js";
import { workflowRuns } from "../../schema.js";
import { PostgresRunRegistry } from "../active-runs.js";
import {
  markRunSucceededOnSelfMove,
  recordBlockStatuses,
  recordRunUsage,
  type RunBlockStatusWrite,
  type RunUsage,
} from "./telemetry.js";
import { fetchRunDetailFromDb } from "../../../services/run-lifecycle/durable-run-detail.js";
import { isRunCompletionPending } from "../../../services/mcp/contracts.js";

vi.mock("../../../infra/vcs-config.js", () => ({ env: {} }));

const JIRA = "https://blazity.atlassian.net";
const subjectKey = "ticket:jira:PROJ-1";
const ownerToken = "owner-a";
const runId = "wrun_identity";

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  registry = new PostgresRunRegistry(db);
}, 30_000);

async function runDetail(id: string) {
  const result = await fetchRunDetailFromDb({ db, runId: id, ticketOrigin: JIRA, secrets: [] });
  if (result === null) throw new Error(`no run detail row for ${id}`);
  return result.run;
}

const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
  runId,
  subjectKey,
  workflowId: "wf_agent",
  workflowName: "Agent",
  status: "success",
  ticketKey: "PROJ-1",
  ticketTitle: "Add login",
  ticketUrl: "https://jira/browse/PROJ-1",
  model: "claude-opus-4-6",
  costUsd: 1.23,
  costKnown: true,
  tokensInput: 1000,
  tokensCached: 200,
  tokensOutput: 500,
  phases: {},
  steps: null,
  budgetFailure: null,
  prUrl: "https://github.com/o/r/pull/7",
  prNumber: 7,
  prs: [{ provider: "github", repoPath: "o/r", id: 7, url: "https://github.com/o/r/pull/7" }],
  ...over,
});

const blockWrite = (over: Partial<RunBlockStatusWrite> = {}): RunBlockStatusWrite => ({
  runId,
  subjectKey,
  ticketKey: "PROJ-1",
  ticketTitle: "Add login",
  ticketUrl: "https://jira/browse/PROJ-1",
  definitionVersion: 3,
  definitionId: 7,
  blockStatuses: { b1: { status: "running" } },
  ...over,
});

/**
 * The window between a run's status flip and its end-of-run telemetry write is
 * exactly what `completionPending` exists to name, and it can only be named if
 * the row already knows which workflow it belongs to. Identity therefore has to
 * be on the row from the claim onwards, not from the final write.
 */
describe("agent run identity from the claim onwards", () => {
  it("stamps the workflow on the claim insert, so a finished run reads as completion-pending", async () => {
    expect(
      await registry.reserve({ subjectKey, ticketKey: "PROJ-1", ownerToken, kind: "ticket" }),
    ).toBe(true);
    expect(
      await registry.commitStartedRun({
        subjectKey,
        ticketKey: "PROJ-1",
        ownerToken,
        kind: "ticket",
        runId,
      }),
    ).toBe(true);

    const claimed = await runDetail(runId);
    expect(claimed.workflow).toBe("wf_agent");
    expect(claimed.workflowName).toBe("Agent");
    expect(claimed.usageRecorded).toBe(false);

    await markRunSucceededOnSelfMove(db, runId);
    const succeeded = await runDetail(runId);
    expect(succeeded.status).toBe("success");
    expect(
      isRunCompletionPending({
        status: "success",
        workflowId: succeeded.workflow,
        usageRecorded: succeeded.usageRecorded,
      }),
    ).toBe(true);

    await recordRunUsage(db, usage());
    const recorded = await runDetail(runId);
    expect(recorded.usageRecorded).toBe(true);
    expect(
      isRunCompletionPending({
        status: "success",
        workflowId: recorded.workflow,
        usageRecorded: recorded.usageRecorded,
      }),
    ).toBe(false);
  });

  it("repairs a row born without identity at the first block-status write", async () => {
    await db.insert(workflowRuns).values({
      runId,
      status: "running",
      subjectKey,
      ticketKey: "PROJ-1",
      createdAt: new Date("2026-09-15T07:20:00Z"),
      startedAt: new Date("2026-09-15T07:20:00Z"),
    });
    expect((await runDetail(runId)).workflow).toBe("wf_unknown");

    await recordBlockStatuses(db, blockWrite());

    const repaired = await runDetail(runId);
    expect(repaired.workflow).toBe("wf_agent");
    expect(repaired.workflowName).toBe("Agent");
  });
});
