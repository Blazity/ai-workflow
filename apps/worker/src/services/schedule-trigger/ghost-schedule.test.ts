import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  scheduleOccurrences,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowSchedules,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";

/**
 * A schedule row whose definition has nothing deployed.
 *
 * On production (2026-09-25) eleven "[E2E] AIW-223 schedule dispatch" fixtures
 * sat enabled with deployed_version NULL and a schedule row behind them: the
 * suite's teardown nulled the pointer, then failed to delete the version a run
 * had referenced and swallowed the error. No product path writes that state,
 * but a stored enabled flag is not a deployed head, and the one guarantee an
 * operator needs is that such a row never starts a run and says why it stopped.
 *
 * Everything below is real: the committed migrations, the live-target reads
 * and the dispatcher. Only the Workflow start is a spy.
 */

const { testEnv } = vi.hoisted(() => ({
  testEnv: { MAX_CONCURRENT_AGENTS: 3 } as Record<string, unknown>,
}));
vi.mock("../../infra/vcs-config.js", () => ({ env: testEnv }));
const { startMock } = vi.hoisted(() => ({ startMock: vi.fn() }));
vi.mock("workflow/api", () => ({ start: startMock, getRun: vi.fn() }));
vi.mock("../../engine/index.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown as Db } }));
vi.mock("../../db/client.js", () => ({ getDb: () => dbRef.current }));
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../infra/logger.js", () => ({ logger: loggerMock }));

const { PostgresRunRegistry } = await import("../../db/repositories/active-runs.js");
const { createScheduleDispatchDeps, evaluateDueSchedules } = await import(
  "./dispatch-schedule-trigger.js"
);

const SCHEDULE_ID = "sch_ghost";
const NODE_ID = "trigger";

const graph = {
  schemaVersion: 2,
  nodes: [
    {
      id: NODE_ID,
      type: "trigger_schedule",
      x: 0,
      y: 0,
      configuration: { cron: "*/30 * * * *", timezone: "UTC", overlapPolicy: "skip" },
      inputs: {},
      additionalInputs: [],
    },
  ],
  edges: [],
};

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  dbRef.current = db;
  startMock.mockReset();
  loggerMock.info.mockReset();
  await db.insert(workflowDefinitions).values({
    id: 58,
    name: "[E2E] AIW-223 schedule dispatch 5e1f",
    enabled: true,
    triggerTypes: ["trigger_schedule"],
    createdById: "e2e",
    createdByLabel: "E2E schedule trigger test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: 58,
    version: 1,
    definition: graph,
    createdById: "e2e",
    createdByLabel: "E2E schedule trigger test",
  });
  // deployed_version stays NULL: what the old teardown left behind.
  await db.insert(workflowSchedules).values({
    id: SCHEDULE_ID,
    definitionId: 58,
    nodeId: NODE_ID,
    cron: "*/30 * * * *",
    catchUpGraceMinutes: 720,
    evaluationWatermarkAt: new Date(Date.now() - 35 * 60_000),
  });
});

describe("a schedule whose definition has no deployed version", () => {
  it("never fires, is revoked, and the revocation is logged with the reason", async () => {
    const deps = createScheduleDispatchDeps(db, new PostgresRunRegistry(db), 3);

    const metrics = await evaluateDueSchedules(deps, 10);

    expect(metrics).toMatchObject({ evaluated: 1, revoked: 1, started: 0 });
    expect(startMock).not.toHaveBeenCalled();
    expect(await db.select().from(scheduleOccurrences)).toEqual([]);
    const [row] = await db
      .select({ revokedAt: workflowSchedules.revokedAt })
      .from(workflowSchedules)
      .where(eq(workflowSchedules.id, SCHEDULE_ID));
    expect(row!.revokedAt).not.toBeNull();
    // The enabled flag said it was live, so the log has to say what did not.
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: SCHEDULE_ID,
        definitionId: 58,
        nodeId: NODE_ID,
        reason: "not_deployed",
      }),
      "schedule_revoked_not_live",
    );
  });

  it("stays quiet on the next pass, because a revoked row is no longer evaluated", async () => {
    const deps = createScheduleDispatchDeps(db, new PostgresRunRegistry(db), 3);
    await evaluateDueSchedules(deps, 10);
    loggerMock.info.mockReset();

    const again = await evaluateDueSchedules(deps, 10);

    expect(again).toMatchObject({ evaluated: 0, revoked: 0, started: 0 });
    expect(loggerMock.info).not.toHaveBeenCalledWith(
      expect.anything(),
      "schedule_revoked_not_live",
    );
  });
});
