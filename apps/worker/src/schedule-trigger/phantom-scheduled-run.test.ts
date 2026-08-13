import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import {
  activeRuns,
  scheduleOccurrences,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowRuns,
  workflowSchedules,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";

/**
 * AIW-249: an occurrence that says a run started must name a run that exists.
 *
 * The dispatcher's own suite runs on a fake ledger and a fake registry, which
 * model the intent rather than the SQL, so the phantom this file is about is
 * invisible there by construction. Everything below runs the REAL occurrence
 * store, the REAL PostgresRunRegistry and the REAL dispatcher against the
 * committed migrations, and asserts the one property an operator relies on:
 * schedule_occurrences.outcome = 'started' implies a workflow_runs row for its
 * run id.
 *
 * The failure modes injected here are the ones a production deployment swap
 * actually produces: a commit whose response is lost after the statement
 * applied (the neon-http shape), a commit that never reaches the database, a
 * reservation that ages past its bind grace, and a poll invocation killed
 * between start() and the commit so the hosted run publishes its own start.
 */

const { testEnv } = vi.hoisted(() => ({
  testEnv: { MAX_CONCURRENT_AGENTS: 3 } as Record<string, unknown>,
}));
vi.mock("../../env.js", () => ({ env: testEnv }));

const { startMock, getRunMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  getRunMock: vi.fn(),
}));
vi.mock("workflow/api", () => ({ start: startMock, getRun: getRunMock }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
vi.mock("../lib/workflow-step-drain.js", () => ({
  confirmWorkflowStepsDrained: vi.fn(async () => true),
}));

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown as Db } }));
vi.mock("../db/client.js", () => ({ getDb: () => dbRef.current }));

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));

const { PostgresRunRegistry } = await import("../adapters/run-registry/postgres.js");
const { recordOccurrenceStarted } = await import("./occurrence-store.js");
const { createScheduleDispatchDeps, dispatchScheduleOccurrence } = await import(
  "./dispatch-schedule-trigger.js"
);
type DispatchParams = Parameters<typeof dispatchScheduleOccurrence>[0];

const SCHEDULE_ID = "sch_phantom";
const NODE_ID = "trigger_schedule_1";
const OCCURRENCE_AT = new Date("2026-08-10T17:00:00.000Z");
const RUN_ID = "wrun_01KZPA62DVJSBJRM1AOVKDY2HS";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  dbRef.current = db;
  startMock.mockReset();
  getRunMock.mockReset();
  getRunMock.mockReturnValue({ cancel: async () => {}, status: "cancelled" });
  await db.insert(workflowDefinitions).values({
    id: 7,
    name: "Nightly report",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: 7,
    version: 2,
    definition: {},
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowSchedules).values({
    id: SCHEDULE_ID,
    definitionId: 7,
    nodeId: NODE_ID,
    cron: "0 * * * *",
  });
});

const occurrence: DispatchParams = {
  scheduleId: SCHEDULE_ID,
  occurrenceAt: OCCURRENCE_AT,
  definitionId: 7,
  definitionVersion: 2,
  nodeId: NODE_ID,
  overlapPolicy: "skip",
  taskTitle: "Nightly report",
  taskDescription: "Produce the nightly report",
  previousOccurrenceAt: null,
  previousRunPullRequests: [],
  droppedOlder: 0,
  droppedOlderAtLeast: false,
};

/** The real registry with one method swapped for a failure injector. */
function withCommit(
  registry: RunRegistryAdapter,
  impl: RunRegistryAdapter["commitStartedRun"],
): RunRegistryAdapter {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (prop === "commitStartedRun") return impl;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as RunRegistryAdapter;
}

/** The symptom, read from the two tables an operator actually looks at. */
async function expectNoPhantom(): Promise<void> {
  const [occ] = await db
    .select({ outcome: scheduleOccurrences.outcome, runId: scheduleOccurrences.runId })
    .from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, SCHEDULE_ID));
  if (occ?.outcome !== "started") return;
  const [row] = await db
    .select({ runId: workflowRuns.runId })
    .from(workflowRuns)
    .where(eq(workflowRuns.runId, occ.runId!));
  expect(
    row,
    `phantom: occurrence says started with run ${occ.runId} and no workflow_runs row exists`,
  ).toBeTruthy();
}

describe("AIW-249: a started occurrence names a run that exists", () => {
  it("publishes a start whose run row is present", async () => {
    startMock.mockResolvedValue({ runId: RUN_ID });
    const result = await dispatchScheduleOccurrence(
      occurrence,
      createScheduleDispatchDeps(db, new PostgresRunRegistry(db), 3),
    );
    expect(result).toEqual({ result: "started", runId: RUN_ID });
    await expectNoPhantom();
  });

  it("keeps the run row when the commit response is lost after it applied", async () => {
    startMock.mockResolvedValue({ runId: RUN_ID });
    const real = new PostgresRunRegistry(db);
    const registry = withCommit(real, async (started) => {
      await real.commitStartedRun(started);
      throw new Error("fetch failed");
    });
    const result = await dispatchScheduleOccurrence(
      occurrence,
      createScheduleDispatchDeps(db, registry, 3),
    );
    expect(result).toEqual({ result: "started", runId: RUN_ID });
    await expectNoPhantom();
  });

  it("publishes nothing when the commit never reaches the database", async () => {
    startMock.mockResolvedValue({ runId: RUN_ID });
    const real = new PostgresRunRegistry(db);
    const registry = withCommit(real, async () => {
      throw new Error("fetch failed");
    });
    const result = await dispatchScheduleOccurrence(
      occurrence,
      createScheduleDispatchDeps(db, registry, 3),
    );
    expect(result.result).toBe("error");
    await expectNoPhantom();
  });

  it("publishes nothing when the reservation aged past its bind grace", async () => {
    startMock.mockImplementation(async () => {
      await db.execute(
        sql`update active_runs set updated_at = now() - interval '10 minutes'`,
      );
      return { runId: RUN_ID };
    });
    const result = await dispatchScheduleOccurrence(
      occurrence,
      createScheduleDispatchDeps(db, new PostgresRunRegistry(db), 3),
    );
    expect(result.result).toBe("error");
    await expectNoPhantom();
  });

  it("keeps the invariant when the hosted run publishes its own start", async () => {
    // The poll invocation is killed between start() and the commit, which is
    // what a deployment swap does. The hosted run then binds the reservation
    // itself (bindWorkflowCandidateStep) and publishes the occurrence
    // (acknowledgeScheduleDispatchStep). Both writers are exercised here in
    // that order, against the real registry.
    const registry = new PostgresRunRegistry(db);
    const ownerToken = "owner:deployment-swap";
    const subject = { subjectKey: `schedule:${SCHEDULE_ID}`, ticketKey: null, kind: "schedule" as const };
    await db.insert(scheduleOccurrences).values({
      scheduleId: SCHEDULE_ID,
      occurrenceAt: OCCURRENCE_AT,
      definitionId: 7,
      definitionVersion: 2,
      pending: true,
    });
    expect(await registry.reserve({ ...subject, ownerToken })).toBe(true);

    expect(
      await registry.markRunEntryStarted({ ...subject, ownerToken, runId: RUN_ID }),
    ).toBe(true);
    expect(
      await recordOccurrenceStarted(db, SCHEDULE_ID, OCCURRENCE_AT, ownerToken, RUN_ID),
    ).toBe(true);

    const [claim] = await db.select().from(activeRuns);
    expect(claim).toMatchObject({ state: "bound", runId: RUN_ID });
    await expectNoPhantom();
  });
});
