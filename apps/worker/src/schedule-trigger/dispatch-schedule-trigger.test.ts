import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunEntry,
  RunRegistryAdapter,
  RunReservation,
  StartedRunRecord,
} from "../adapters/run-registry/types.js";
import type { AdmittedOccurrence, OccurrenceRow } from "./occurrence-store.js";
import type { ScheduleRow } from "./schedule-store.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "PROJ", COLUMN_AI: "AI", MAX_CONCURRENT_AGENTS: 3 },
}));
vi.mock("workflow/api", () => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
// Reachable only from ticket dispatch in this module's import graph.
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: vi.fn(async () => null),
  getLiveScheduleTriggerTarget: vi.fn(async () => null),
}));
vi.mock("../db/client.js", () => ({ getDb: () => ({}) }));
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/logger.js", () => ({ logger: loggerMock }));

const {
  dispatchScheduleOccurrence,
  drainPendingScheduleOccurrences,
  evaluateDueSchedules,
} = await import("./dispatch-schedule-trigger.js");
type DispatchParams = Parameters<typeof dispatchScheduleOccurrence>[0];
type DispatchDeps = Parameters<typeof dispatchScheduleOccurrence>[1];

const SCHEDULE_ID = "sch_1";
const OCCURRENCE = new Date("2026-08-05T14:00:00.000Z");
const EARLIER = new Date("2026-08-05T13:45:00.000Z");

/**
 * In-memory stand-in for the occurrence ledger that keeps the two properties the
 * dispatcher's correctness rests on: at most one pending occurrence per schedule,
 * and `admitted` true only for the call whose insert created the row.
 */
class FakeLedger {
  rows = new Map<string, OccurrenceRow>();
  calls: string[] = [];

  private key(scheduleId: string, occurrenceAt: Date): string {
    return `${scheduleId}\0${occurrenceAt.toISOString()}`;
  }

  private pendingOf(scheduleId: string): OccurrenceRow | undefined {
    return [...this.rows.values()].find(
      (row) => row.scheduleId === scheduleId && row.pending,
    );
  }

  row(scheduleId: string, occurrenceAt: Date): OccurrenceRow | undefined {
    return this.rows.get(this.key(scheduleId, occurrenceAt));
  }

  seedPending(scheduleId: string, occurrenceAt: Date): void {
    this.rows.set(
      this.key(scheduleId, occurrenceAt),
      makeRow({ scheduleId, occurrenceAt, pending: true }),
    );
  }

  accept = async (admitted: AdmittedOccurrence) => {
    this.calls.push("accept");
    const key = this.key(admitted.scheduleId, admitted.occurrenceAt);
    const existing = this.rows.get(key);
    if (existing) return { admitted: false, stored: existing };
    const blocker = this.pendingOf(admitted.scheduleId);
    const stored = makeRow({
      scheduleId: admitted.scheduleId,
      occurrenceAt: admitted.occurrenceAt,
      definitionVersion: admitted.definitionVersion,
      pending: blocker === undefined,
      outcome: blocker === undefined ? null : "skipped_overlap",
      skipReason: blocker
        ? `overlap:${blocker.occurrenceAt.toISOString().replace(".000Z", "Z")}`
        : null,
      droppedCount: admitted.droppedOlder,
      droppedCountCapped: admitted.droppedOlderAtLeast,
    });
    this.rows.set(key, stored);
    return { admitted: stored.pending, stored };
  };

  supersedeThenAccept = async (admitted: AdmittedOccurrence) => {
    this.calls.push("supersedeThenAccept");
    const key = this.key(admitted.scheduleId, admitted.occurrenceAt);
    const existing = this.rows.get(key);
    if (existing) return { admitted: false, stored: existing };
    const blocker = this.pendingOf(admitted.scheduleId);
    if (blocker && blocker.occurrenceAt < admitted.occurrenceAt) {
      this.rows.set(this.key(blocker.scheduleId, blocker.occurrenceAt), {
        ...blocker,
        pending: false,
        outcome: "superseded",
      });
    }
    const stored = makeRow({
      scheduleId: admitted.scheduleId,
      occurrenceAt: admitted.occurrenceAt,
      definitionVersion: admitted.definitionVersion,
      pending: true,
      droppedCount: admitted.droppedOlder + (blocker ? 1 + blocker.droppedCount : 0),
    });
    this.rows.set(key, stored);
    return { admitted: true, stored };
  };

  recordStarted = async (
    scheduleId: string,
    occurrenceAt: Date,
    _ownerToken: string,
    runId: string,
  ) => {
    this.calls.push("recordStarted");
    const key = this.key(scheduleId, occurrenceAt);
    const row = this.rows.get(key);
    if (!row) return false;
    if (!row.pending && row.outcome !== null && row.outcome !== "started") return false;
    this.rows.set(key, { ...row, pending: false, outcome: "started", runId });
    return true;
  };

  recordSkipped = async (
    scheduleId: string,
    occurrenceAt: Date,
    outcome: "skipped_overlap" | "skipped_stale",
    options: { skipReason?: string; blockingRunId?: string } = {},
  ) => {
    this.calls.push(`recordSkipped:${outcome}`);
    const key = this.key(scheduleId, occurrenceAt);
    const row = this.rows.get(key);
    if (!row || (!row.pending && row.outcome !== null)) return false;
    this.rows.set(key, {
      ...row,
      pending: false,
      outcome,
      skipReason: options.skipReason ?? row.skipReason,
      blockingRunId: options.blockingRunId ?? null,
    });
    return true;
  };

  recordError = async (scheduleId: string, occurrenceAt: Date, message: string) => {
    this.calls.push("recordError");
    const key = this.key(scheduleId, occurrenceAt);
    const row = this.rows.get(key);
    if (!row) return false;
    this.rows.set(key, {
      ...row,
      outcome: "error",
      skipReason: message,
      attemptCount: row.attemptCount + 1,
    });
    return true;
  };

  recordAtCapacity = async (scheduleId: string, occurrenceAt: Date) => {
    this.calls.push("recordAtCapacity");
    const key = this.key(scheduleId, occurrenceAt);
    const row = this.rows.get(key);
    if (!row || !row.pending) return false;
    this.rows.set(key, {
      ...row,
      skipReason: "at_capacity",
      attemptCount: row.attemptCount + 1,
    });
    return true;
  };

  cancelWaiting = async (scheduleId: string, reason: string) => {
    this.calls.push("cancelWaiting");
    let cancelled = 0;
    for (const [key, row] of this.rows) {
      if (row.scheduleId !== scheduleId || !row.pending) continue;
      this.rows.set(key, {
        ...row,
        pending: false,
        outcome: "cancelled",
        skipReason: row.skipReason ?? reason,
      });
      cancelled += 1;
    }
    return cancelled;
  };

  listPending = async (limit: number) =>
    [...this.rows.values()]
      .filter((row) => row.pending)
      .sort((a, b) => a.occurrenceAt.getTime() - b.occurrenceAt.getTime())
      .slice(0, limit);

  expirePending = async () => 0;
  sweepSettled = async () => undefined;
}

/** Subject-claim model: one row per subject key, capacity counted over all of
 *  them, exactly as the Postgres registry behaves for the dispatch protocol. */
class FakeRunRegistry {
  entries = new Map<string, ActiveRunEntry>();

  reserve = async (reservation: RunReservation) => {
    if (this.entries.has(reservation.subjectKey)) return false;
    this.entries.set(reservation.subjectKey, {
      ...reservation,
      runId: null,
      state: "reserved",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return true;
  };

  releaseReservation = async (subjectKey: string, ownerToken: string) => {
    const entry = this.entries.get(subjectKey);
    if (!entry || entry.ownerToken !== ownerToken || entry.state !== "reserved") {
      return false;
    }
    this.entries.delete(subjectKey);
    return true;
  };

  commitStartedRun = async (started: StartedRunRecord) => {
    const entry = this.entries.get(started.subjectKey);
    if (!entry || entry.ownerToken !== started.ownerToken) return false;
    this.entries.set(started.subjectKey, {
      ...entry,
      runId: started.runId,
      state: "bound",
      updatedAt: Date.now(),
    });
    return true;
  };

  get = async (subjectKey: string) => this.entries.get(subjectKey) ?? null;
  listAll = async () => [...this.entries.values()];

  /** Pretend another run already owns this subject. */
  occupy(subjectKey: string, runId: string): void {
    this.entries.set(subjectKey, {
      subjectKey,
      ticketKey: null,
      ownerToken: `owner:${runId}`,
      kind: "schedule",
      runId,
      state: "bound",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

function makeRow(over: Partial<OccurrenceRow>): OccurrenceRow {
  return {
    scheduleId: SCHEDULE_ID,
    occurrenceAt: OCCURRENCE,
    definitionId: 9,
    definitionVersion: 3,
    pending: false,
    outcome: null,
    skipReason: null,
    droppedCount: 0,
    droppedCountCapped: false,
    attemptCount: 0,
    blockingRunId: null,
    runId: null,
    dispatchedAt: null,
    createdAt: new Date("2026-08-05T14:00:01.000Z"),
    updatedAt: new Date("2026-08-05T14:00:01.000Z"),
    ...over,
  };
}

function makeSchedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: SCHEDULE_ID,
    definitionId: 9,
    nodeId: "entry",
    cron: "*/15 * * * *",
    timezone: "UTC",
    overlapPolicy: "skip",
    catchUpGraceMinutes: 60,
    pausedAt: null,
    evaluationWatermarkAt: EARLIER,
    lastEvaluatedAt: null,
    lastStartedOccurrenceAt: null,
    lastStartedRunId: null,
    revokedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...over,
  };
}

/** Records the two cursor writes an evaluation pass performs, which is the only
 *  way to tell "the scheduler never looked" from "nothing was due". */
function fakeSchedules(rows: ScheduleRow[]) {
  const passes: string[] = [];
  const watermarks: Array<{ scheduleId: string; occurrenceAt: Date }> = [];
  const revoked: string[] = [];
  return {
    passes,
    watermarks,
    revoked,
    port: {
      listEvaluable: async (limit: number) => rows.slice(0, limit),
      recordEvaluationPass: async (scheduleId: string) => {
        passes.push(scheduleId);
      },
      advanceWatermark: async (scheduleId: string, occurrenceAt: Date) => {
        watermarks.push({ scheduleId, occurrenceAt });
        return true;
      },
      revoke: async (scheduleId: string) => {
        revoked.push(scheduleId);
      },
      getById: async (scheduleId: string) =>
        rows.find((row) => row.id === scheduleId) ?? null,
    },
  };
}

let ledger: FakeLedger;
let registry: FakeRunRegistry;
let startWorkflow: ReturnType<typeof vi.fn>;
let orphanStartedRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ledger = new FakeLedger();
  registry = new FakeRunRegistry();
  startWorkflow = vi.fn(async () => "run-1");
  orphanStartedRun = vi.fn(async () => undefined);
  loggerMock.warn.mockClear();
});

function params(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    scheduleId: SCHEDULE_ID,
    occurrenceAt: OCCURRENCE,
    definitionId: 9,
    definitionVersion: 3,
    nodeId: "entry",
    overlapPolicy: "skip",
    taskTitle: "Sweep the backlog",
    taskDescription: "Look for stale tickets.",
    previousOccurrenceAt: null,
    previousRunPullRequests: [],
    droppedOlder: 0,
    droppedOlderAtLeast: false,
    ...overrides,
  };
}

function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    runRegistry: registry as unknown as RunRegistryAdapter,
    maxConcurrentAgents: 3,
    occurrences: ledger,
    schedules: {
      listEvaluable: async () => [],
      recordEvaluationPass: async () => undefined,
      advanceWatermark: async () => true,
      revoke: async () => undefined,
      getById: async () => null,
    },
    resolveScheduleTarget: async () => null,
    previousRunPullRequests: async () => [],
    startWorkflow: startWorkflow as DispatchDeps["startWorkflow"],
    orphanStartedRun: orphanStartedRun as DispatchDeps["orphanStartedRun"],
    now: () => new Date("2026-08-05T14:00:01.000Z"),
    ...overrides,
  };
}

describe("schedule occurrence dispatch", () => {
  it("admits the occurrence, starts one run and publishes the start", async () => {
    await expect(dispatchScheduleOccurrence(params(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-1",
    });

    expect(startWorkflow).toHaveBeenCalledOnce();
    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      kind: "schedule",
      scheduleId: SCHEDULE_ID,
      definitionId: 9,
      definitionVersion: 3,
      nodeId: "entry",
      subjectKey: "schedule:sch_1",
      scheduledFor: "2026-08-05T14:00:00.000Z",
      taskTitle: "Sweep the backlog",
      taskDescription: "Look for stale tickets.",
      ownerToken: expect.stringMatching(/^owner:/),
    });
    expect(startWorkflow.mock.calls[0]?.[0]).not.toHaveProperty(
      "previousScheduledFor",
    );
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: false,
      outcome: "started",
      runId: "run-1",
    });
    await expect(registry.get("schedule:sch_1")).resolves.toMatchObject({
      runId: "run-1",
      state: "bound",
      kind: "schedule",
    });
  });

  it("carries the previous occurrence so the task can be written relative to it", async () => {
    await dispatchScheduleOccurrence(
      params({ previousOccurrenceAt: new Date("2026-08-04T14:00:00.000Z") }),
      deps(),
    );

    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      previousScheduledFor: "2026-08-04T14:00:00.000Z",
    });
  });
});

describe("overlap policy", () => {
  it("skip settles the occurrence as skipped_overlap naming the run that blocked it", async () => {
    registry.occupy("schedule:sch_1", "run-in-flight");

    await expect(
      dispatchScheduleOccurrence(params({ overlapPolicy: "skip" }), deps()),
    ).resolves.toEqual({ result: "skipped_overlap", blockingRunId: "run-in-flight" });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.calls).toEqual([
      "supersedeThenAccept",
      "recordSkipped:skipped_overlap",
    ]);
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: false,
      outcome: "skipped_overlap",
      blockingRunId: "run-in-flight",
    });
  });

  it("queue leaves the newer occurrence waiting and supersedes the one it replaced", async () => {
    ledger.seedPending(SCHEDULE_ID, EARLIER);
    registry.occupy("schedule:sch_1", "run-in-flight");

    await expect(
      dispatchScheduleOccurrence(params({ overlapPolicy: "queue" }), deps()),
    ).resolves.toEqual({ result: "queued" });

    expect(startWorkflow).not.toHaveBeenCalled();
    // No settling write at all: the occurrence is still owed a run.
    expect(ledger.calls).toEqual(["supersedeThenAccept"]);
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: true,
      outcome: null,
    });
    expect(ledger.row(SCHEDULE_ID, EARLIER)).toMatchObject({
      pending: false,
      outcome: "superseded",
    });
  });

  it("allow gives the occurrence its own subject, so it starts beside a running sibling", async () => {
    registry.occupy("schedule:sch_1", "run-in-flight");

    await expect(
      dispatchScheduleOccurrence(params({ overlapPolicy: "allow" }), deps()),
    ).resolves.toEqual({ result: "started", runId: "run-1" });

    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      subjectKey: `schedule:sch_1:${OCCURRENCE.getTime()}`,
    });
  });

  it("allow refuses a third occurrence while two of the schedule's runs are in flight", async () => {
    registry.occupy(`schedule:sch_1:${EARLIER.getTime()}`, "run-older");
    registry.occupy("schedule:sch_1:1754400000000", "run-oldest");

    await expect(
      dispatchScheduleOccurrence(
        params({ overlapPolicy: "allow" }),
        // Well clear of the global cap, so this is the per-schedule ceiling and
        // not capacity answering.
        deps({ maxConcurrentAgents: 9 }),
      ),
    ).resolves.toEqual({ result: "skipped_overlap", blockingRunId: "run-older" });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      outcome: "skipped_overlap",
    });
  });

  it("allow starts a second occurrence while one sibling run is in flight", async () => {
    registry.occupy(`schedule:sch_1:${EARLIER.getTime()}`, "run-older");

    await expect(
      dispatchScheduleOccurrence(
        params({ overlapPolicy: "allow" }),
        deps({ maxConcurrentAgents: 9 }),
      ),
    ).resolves.toEqual({ result: "started", runId: "run-1" });
  });
});

describe("capacity and admission", () => {
  it.each(["skip", "queue", "allow"] as const)(
    "leaves a %s occurrence pending when the system is at capacity",
    async (overlapPolicy) => {
      await expect(
        dispatchScheduleOccurrence(
          params({ overlapPolicy }),
          deps({ maxConcurrentAgents: 0 }),
        ),
      ).resolves.toEqual({ result: "at_capacity" });

      expect(startWorkflow).not.toHaveBeenCalled();
      expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
        pending: true,
        outcome: null,
        skipReason: "at_capacity",
        attemptCount: 1,
      });
    },
  );

  // maxConcurrentAgents: 0 only exercises the pre-reservation check. This is the
  // other half: the reservation is taken, a racer fills the pool, and the
  // post-reservation fairness check rolls this one back.
  it("leaves the occurrence pending when it loses capacity after reserving", async () => {
    registry.occupy("ticket:jira:AIW-1", "run-someone-else");
    const racing = {
      ...registry,
      reserve: async (reservation: RunReservation) => {
        const reserved = await registry.reserve(reservation);
        // A second dispatcher wins its own slot between our capacity check and
        // our reservation, which is exactly what the fairness check exists for.
        if (reserved) registry.occupy("ticket:jira:AIW-2", "run-racer");
        return reserved;
      },
    } as unknown as RunRegistryAdapter;

    await expect(
      dispatchScheduleOccurrence(
        params(),
        deps({ runRegistry: racing, maxConcurrentAgents: 2 }),
      ),
    ).resolves.toEqual({ result: "at_capacity" });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: true,
      outcome: null,
      skipReason: "at_capacity",
      attemptCount: 1,
    });
    // The reservation is rolled back, so the next tick is free to try again.
    await expect(registry.get("schedule:sch_1")).resolves.toBeNull();
  });

  it("does not dispatch when another evaluator's insert took the occurrence", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);

    await expect(dispatchScheduleOccurrence(params(), deps())).resolves.toEqual({
      result: "not_admitted",
    });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.calls).toEqual(["supersedeThenAccept"]);
  });

  // A waiting row is not a running job. Admitting behind it produced a daily
  // schedule with two occurrences and zero runs, the second one reporting that
  // the previous run was still going when no run had ever started.
  it.each(["skip", "queue", "allow"] as const)(
    "%s supersedes a waiting occurrence that never started and runs the newer one",
    async (overlapPolicy) => {
      ledger.seedPending(SCHEDULE_ID, EARLIER);

      await expect(
        dispatchScheduleOccurrence(params({ overlapPolicy }), deps()),
      ).resolves.toEqual({ result: "started", runId: "run-1" });

      expect(ledger.row(SCHEDULE_ID, EARLIER)).toMatchObject({
        pending: false,
        outcome: "superseded",
      });
      expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
        outcome: "started",
        runId: "run-1",
      });
    },
  );

  // The one condition that does block an occurrence, and the reason skipped_overlap
  // can no longer be written without naming a run.
  it("stands down instead of settling when the subject holder is only a reservation", async () => {
    registry.entries.set("schedule:sch_1", {
      subjectKey: "schedule:sch_1",
      ticketKey: null,
      ownerToken: "owner:concurrent-dispatcher",
      kind: "schedule",
      // A reservation with no run id: another dispatcher of THIS occurrence is
      // between reserve and start, and settling here would terminally skip the
      // occurrence it is about to publish a start against.
      runId: null,
      state: "reserved",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await expect(
      dispatchScheduleOccurrence(params({ overlapPolicy: "skip" }), deps()),
    ).resolves.toEqual({ result: "queued" });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: true,
      outcome: null,
    });
  });

  it("treats a thrown unique violation as another evaluator winning, not a failure", async () => {
    const conflict = Object.assign(new Error("duplicate key"), { code: "23505" });
    const occurrences = {
      ...ledger,
      supersedeThenAccept: vi.fn(async () => {
        throw conflict;
      }),
    } as unknown as DispatchDeps["occurrences"];

    await expect(
      dispatchScheduleOccurrence(params(), deps({ occurrences })),
    ).resolves.toEqual({ result: "not_admitted" });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.calls).toEqual([]);
  });

  it("cancels a run whose occurrence was settled between the start and the publish", async () => {
    const occurrences = {
      ...ledger,
      recordStarted: async () => false,
    } as unknown as DispatchDeps["occurrences"];

    await expect(
      dispatchScheduleOccurrence(params(), deps({ occurrences })),
    ).resolves.toEqual({ result: "orphaned_start", runId: "run-1" });

    expect(orphanStartedRun).toHaveBeenCalledWith({
      subjectKey: "schedule:sch_1",
      ticketKey: null,
      kind: "schedule",
      ownerToken: expect.stringMatching(/^owner:/),
      runId: "run-1",
    });
  });
});

function liveTarget(version = 3) {
  return vi.fn(async () => ({
    definitionVersion: version,
    taskTitle: "Sweep the backlog",
    taskDescription: "Look for stale tickets.",
  }));
}

describe("schedule evaluation pass", () => {
  it("revokes a schedule whose node is gone from the deployed head and cancels what it left waiting", async () => {
    ledger.seedPending(SCHEDULE_ID, EARLIER);
    const schedules = fakeSchedules([makeSchedule()]);
    const resolveScheduleTarget = vi.fn(async () => null);

    await expect(
      evaluateDueSchedules(
        deps({ schedules: schedules.port, resolveScheduleTarget }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, revoked: 1, started: 0 });

    expect(schedules.revoked).toEqual([SCHEDULE_ID]);
    // Revocation is reversible, so an occurrence left pending here would be
    // started hours late by the drain once a later deploy restores the node.
    expect(ledger.row(SCHEDULE_ID, EARLIER)).toMatchObject({
      pending: false,
      outcome: "cancelled",
      skipReason: "schedule_revoked",
    });
    expect(schedules.watermarks).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  // The batch is ordered by last_evaluated_at ascending with nulls first, so a
  // schedule whose liveness lookup throws would sort to the head of every later
  // batch and starve every healthy schedule behind it.
  it("records the evaluation pass before it resolves liveness, so a failing lookup cannot starve the batch", async () => {
    const schedules = fakeSchedules([makeSchedule()]);
    const resolveScheduleTarget = vi.fn(async () => {
      throw new Error("definition store unavailable");
    });

    await expect(
      evaluateDueSchedules(
        deps({ schedules: schedules.port, resolveScheduleTarget }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, errors: 1 });

    expect(schedules.passes).toEqual([SCHEDULE_ID]);
  });

  it("records an evaluation pass even when nothing is due, and leaves the watermark alone", async () => {
    // Watermark at the occurrence that just fired, so the window is empty.
    const schedules = fakeSchedules([
      makeSchedule({ evaluationWatermarkAt: OCCURRENCE }),
    ]);

    await expect(
      evaluateDueSchedules(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, due: 0, started: 0 });

    expect(schedules.passes).toEqual([SCHEDULE_ID]);
    expect(schedules.watermarks).toEqual([]);
  });

  it("dispatches the due occurrence on the deployed head and advances the watermark to it", async () => {
    const schedules = fakeSchedules([
      makeSchedule({ lastStartedOccurrenceAt: EARLIER }),
    ]);

    await expect(
      evaluateDueSchedules(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget(7) }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, due: 1, started: 1 });

    expect(startWorkflow.mock.calls[0]?.[0]).toMatchObject({
      kind: "schedule",
      definitionVersion: 7,
      scheduledFor: "2026-08-05T14:00:00.000Z",
      previousScheduledFor: EARLIER.toISOString(),
    });
    expect(schedules.watermarks).toEqual([
      { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE },
    ]);
  });

  it("records a stale occurrence as skipped_stale and still advances the watermark", async () => {
    // Daily at 03:00 with an hour of grace: today's occurrence is eleven hours
    // past it, so it will never be worth running.
    const schedules = fakeSchedules([
      makeSchedule({
        cron: "0 3 * * *",
        evaluationWatermarkAt: new Date("2026-08-04T03:00:00.000Z"),
      }),
    ]);

    await expect(
      evaluateDueSchedules(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, due: 0, skipped: 1, started: 0 });

    expect(startWorkflow).not.toHaveBeenCalled();
    const stale = new Date("2026-08-05T03:00:00.000Z");
    expect(ledger.row(SCHEDULE_ID, stale)).toMatchObject({
      pending: false,
      outcome: "skipped_stale",
    });
    expect(schedules.watermarks).toEqual([
      { scheduleId: SCHEDULE_ID, occurrenceAt: stale },
    ]);
  });

  it("advances the watermark for an occurrence the overlap policy refused", async () => {
    registry.occupy("schedule:sch_1", "run-in-flight");
    const schedules = fakeSchedules([makeSchedule()]);

    await expect(
      evaluateDueSchedules(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, due: 1, started: 0, skipped: 1 });

    expect(schedules.watermarks).toEqual([
      { scheduleId: SCHEDULE_ID, occurrenceAt: OCCURRENCE },
    ]);
  });

  it("keeps evaluating the batch after one schedule throws", async () => {
    const schedules = fakeSchedules([
      makeSchedule({ id: "sch_bad" }),
      makeSchedule({ id: "sch_good" }),
    ]);
    const occurrences = {
      ...ledger,
      supersedeThenAccept: vi.fn(async (admitted: AdmittedOccurrence) => {
        if (admitted.scheduleId === "sch_bad") throw new Error("ledger unavailable");
        return ledger.supersedeThenAccept(admitted);
      }),
    } as unknown as DispatchDeps["occurrences"];

    await expect(
      evaluateDueSchedules(
        deps({
          schedules: schedules.port,
          resolveScheduleTarget: liveTarget(),
          occurrences,
        }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 2, started: 1, errors: 1 });

    // Counting it is not enough: nothing durable exists for that occurrence, so
    // this line is the operator's only route to the cause.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "sch_bad",
        err: "ledger unavailable",
      }),
      "schedule_occurrence_admission_failed",
    );
  });

  // The watermark moving on evaluation rests on the occurrence having been
  // recorded. Moving it past one the ledger never accepted is the single way an
  // occurrence can disappear with no row, no retry and no trace.
  it("leaves the watermark alone when the ledger never recorded the occurrence", async () => {
    const schedules = fakeSchedules([makeSchedule()]);
    const occurrences = {
      ...ledger,
      supersedeThenAccept: vi.fn(async () => {
        throw new Error("ledger unavailable");
      }),
    } as unknown as DispatchDeps["occurrences"];

    await expect(
      evaluateDueSchedules(
        deps({
          schedules: schedules.port,
          resolveScheduleTarget: liveTarget(),
          occurrences,
        }),
        10,
      ),
    ).resolves.toMatchObject({ evaluated: 1, due: 1, started: 0, errors: 1 });

    expect(schedules.watermarks).toEqual([]);
  });
});

describe("pending occurrence drain", () => {
  it("starts a waiting occurrence on the version it was admitted under, without re-admitting it", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);
    const schedules = fakeSchedules([makeSchedule()]);
    const resolveScheduleTarget = liveTarget(3);

    await expect(
      drainPendingScheduleOccurrences(
        deps({ schedules: schedules.port, resolveScheduleTarget }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 1, started: 1 });

    expect(resolveScheduleTarget).toHaveBeenCalledWith({
      definitionId: 9,
      nodeId: "entry",
      definitionVersion: 3,
    });
    expect(ledger.calls).toEqual(["recordStarted"]);
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      outcome: "started",
      runId: "run-1",
    });
  });

  // The dispatcher died after start() returned, so it never published. The workflow
  // publishes the same start itself (acknowledgeScheduleDispatchStep calls exactly
  // this store function), and that has to leave the drain with nothing: otherwise
  // the crash costs a second 3 to 25 minute run for one occurrence.
  it("has nothing left to start once the workflow published the start the dispatcher never did", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);
    const schedules = fakeSchedules([makeSchedule()]);

    await expect(
      ledger.recordStarted(SCHEDULE_ID, OCCURRENCE, "owner:crashed", "run-crash"),
    ).resolves.toBe(true);

    await expect(
      drainPendingScheduleOccurrences(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 0, started: 0 });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: false,
      outcome: "started",
      runId: "run-crash",
    });
  });

  // A pending row under skip or allow exists for one reason, that there was no
  // capacity. "No capacity for a while" is not the customer agreeing to a 03:00
  // report delivered at 20:00.
  it.each(["skip", "allow"] as const)(
    "refuses to start a %s occurrence that waited past its tolerance",
    async (overlapPolicy) => {
      const late = new Date("2026-08-04T15:00:00.000Z");
      ledger.seedPending(SCHEDULE_ID, late);
      const schedules = fakeSchedules([
        makeSchedule({ overlapPolicy, catchUpGraceMinutes: 15 }),
      ]);

      await expect(
        drainPendingScheduleOccurrences(
          deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
          10,
        ),
      ).resolves.toMatchObject({ listed: 1, started: 0, pastGrace: 1 });

      expect(startWorkflow).not.toHaveBeenCalled();
      // Left for the pending-age ceiling to retire: the drain never settles.
      expect(ledger.row(SCHEDULE_ID, late)).toMatchObject({
        pending: true,
        outcome: null,
      });
    },
  );

  // queue is the policy whose entire meaning is "wait", so its only ceiling stays
  // the 24 hour pending-age backstop.
  it("still starts a queue occurrence that waited past the tolerance", async () => {
    const late = new Date("2026-08-04T15:00:00.000Z");
    ledger.seedPending(SCHEDULE_ID, late);
    const schedules = fakeSchedules([
      makeSchedule({ overlapPolicy: "queue", catchUpGraceMinutes: 15 }),
    ]);

    await expect(
      drainPendingScheduleOccurrences(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 1, started: 1, pastGrace: 0 });
  });

  it("revokes and refuses a waiting occurrence whose schedule went dead", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);
    const schedules = fakeSchedules([makeSchedule()]);

    await expect(
      drainPendingScheduleOccurrences(
        deps({
          schedules: schedules.port,
          resolveScheduleTarget: vi.fn(async () => null),
        }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 1, started: 0, revoked: 1 });

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(schedules.revoked).toEqual([SCHEDULE_ID]);
  });

  it("stands down without settling when a concurrent pass already claimed an allow occurrence", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);
    // The second claim is another drain pass over THIS occurrence, which is about
    // to publish a start against this exact row. Settling it here would answer
    // false to that publication and cancel a healthy run.
    registry.occupy(`schedule:sch_1:${EARLIER.getTime()}`, "run-sibling");
    registry.occupy(`schedule:sch_1:${OCCURRENCE.getTime()}`, "run-mine");
    const schedules = fakeSchedules([makeSchedule({ overlapPolicy: "allow" })]);

    await expect(
      drainPendingScheduleOccurrences(
        deps({
          schedules: schedules.port,
          resolveScheduleTarget: liveTarget(),
          maxConcurrentAgents: 9,
        }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 1, started: 0, deferred: 1 });

    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: true,
      outcome: null,
    });
  });

  it("leaves an allow occurrence pending when the drain finds the ceiling full", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);
    registry.occupy(`schedule:sch_1:${EARLIER.getTime()}`, "run-older");
    registry.occupy("schedule:sch_1:1754400000000", "run-oldest");
    const schedules = fakeSchedules([makeSchedule({ overlapPolicy: "allow" })]);

    await expect(
      drainPendingScheduleOccurrences(
        deps({
          schedules: schedules.port,
          resolveScheduleTarget: liveTarget(),
          maxConcurrentAgents: 9,
        }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 1, started: 0, deferred: 1 });

    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: true,
      outcome: null,
    });
  });

  it("leaves a waiting occurrence pending when its subject is busy, whatever the policy", async () => {
    ledger.seedPending(SCHEDULE_ID, OCCURRENCE);
    registry.occupy("schedule:sch_1", "run-in-flight");
    const schedules = fakeSchedules([makeSchedule({ overlapPolicy: "skip" })]);

    await expect(
      drainPendingScheduleOccurrences(
        deps({ schedules: schedules.port, resolveScheduleTarget: liveTarget() }),
        10,
      ),
    ).resolves.toMatchObject({ listed: 1, started: 0, deferred: 1 });

    // Not settled: a concurrent drain of this same occurrence may be about to
    // publish a start against this exact row.
    expect(ledger.row(SCHEDULE_ID, OCCURRENCE)).toMatchObject({
      pending: true,
      outcome: null,
    });
  });
});
