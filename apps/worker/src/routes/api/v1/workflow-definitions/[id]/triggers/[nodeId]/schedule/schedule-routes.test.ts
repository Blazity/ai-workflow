import { eq } from "drizzle-orm";
import { createApp, createRouter, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../../../../../db/client.js";
import {
  member,
  organization,
  scheduleOccurrences,
  user,
  workflowDefinitions,
  workflowDefinitionVersions,
  workflowSchedules,
} from "../../../../../../../../db/schema.js";
import { createTestDb } from "../../../../../../../../db/test-db.js";
import {
  getScheduleById,
  mintSchedulesForLiveHead,
  pauseSchedule,
  recordEvaluationPass,
  revokeSchedule,
} from "../../../../../../../../schedule-trigger/schedule-store.js";
// Also as a namespace, only for the two defensive-guard tests below that spy
// on one call without disturbing the real implementation everywhere else.
import * as scheduleStore from "../../../../../../../../schedule-trigger/schedule-store.js";

const DEFINITION_ID = 9;
const NODE_ID = "sched";
const BASE = `/api/v1/workflow-definitions/${DEFINITION_ID}/triggers/${NODE_ID}/schedule`;

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  sessionUserId: "user_admin",
  // Distinct from an unrecognised user: no session at all is the 401 path,
  // never reachable if the mock always answers with one.
  noSession: false,
  env: { DASHBOARD_ORG_SLUG: "ai-workflow" },
}));

vi.mock("../../../../../../../../../env.js", () => ({ env: state.env }));
vi.mock("../../../../../../../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../../../../../../../auth-instance.js", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        state.noSession
          ? null
          : { user: { id: state.sessionUserId }, session: { id: "session_test" } },
      ),
    },
  },
}));

const configGet = (await import("./config.get.js")).default;
const pausePost = (await import("./pause.post.js")).default;
const resumePost = (await import("./resume.post.js")).default;
const previewPost = (await import("./preview.post.js")).default;
const { SCHEDULE_STALE_EVALUATION_MS } = await import("./config.get.js");

let db: Db;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(route: any, method: "GET" | "POST", suffix: string, body?: unknown) {
  return callFor(route, method, DEFINITION_ID, NODE_ID, suffix, body);
}

/** Like call(), but against an arbitrary {id}/{nodeId} pair: the one place a
 *  cross-definition isolation test needs a target other than BASE's. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callFor(
  route: any,
  method: "GET" | "POST",
  definitionId: number,
  nodeId: string,
  suffix: string,
  body?: unknown,
) {
  const app = createApp();
  const router = createRouter();
  const pattern = "/api/v1/workflow-definitions/:id/triggers/:nodeId/schedule" + suffix;
  if (method === "GET") router.get(pattern, route);
  else router.post(pattern, route);
  app.use(router);
  const path = `/api/v1/workflow-definitions/${definitionId}/triggers/${nodeId}/schedule${suffix}`;
  return toWebHandler(app)(
    new Request(`http://worker.test${path}`, {
      method,
      headers: {
        host: "worker.test",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function graph(configuration: Record<string, unknown> = { cron: "0 * * * *", timezone: "UTC" }) {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: NODE_ID,
        type: "trigger_schedule" as const,
        x: 0,
        y: 0,
        configuration,
        inputs: {},
        additionalInputs: [],
      },
    ],
    edges: [],
  };
}

async function deployScheduleDefinition(
  configuration?: Record<string, unknown>,
): Promise<void> {
  await db.insert(workflowDefinitionVersions).values({
    definitionId: DEFINITION_ID,
    version: 1,
    definition: graph(configuration),
    createdById: "test",
    createdByLabel: "Test",
  });
  await db
    .update(workflowDefinitions)
    .set({ deployedVersion: 1, enabled: true })
    .where(eq(workflowDefinitions.id, DEFINITION_ID));
}

async function mintSchedule(configuration?: Record<string, unknown>) {
  const [minted] = await mintSchedulesForLiveHead(db, {
    definitionId: DEFINITION_ID,
    nodes: graph(configuration).nodes,
  });
  return minted!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  state.sessionUserId = "user_admin";
  state.noSession = false;

  await db
    .insert(organization)
    .values({ id: "org_aiw", name: "AI Workflow", slug: "ai-workflow" });
  await db.insert(user).values([
    { id: "user_admin", name: "Admin", email: "admin@example.com", emailVerified: true },
    { id: "user_member", name: "Member", email: "member@example.com", emailVerified: true },
    // No member row: a real account, but not part of the org. Distinct from
    // "user_member", whose 403 comes from canDispatchWorkflowRuns AFTER actor
    // resolution succeeds. This one's 403 must come from requireDashboardActor
    // itself, before role is ever consulted.
    { id: "user_stranger", name: "Stranger", email: "stranger@example.com", emailVerified: true },
  ]);
  await db.insert(member).values([
    { id: "m_admin", organizationId: "org_aiw", userId: "user_admin", role: "admin" },
    { id: "m_member", organizationId: "org_aiw", userId: "user_member", role: "member" },
  ]);
  await db.insert(workflowDefinitions).values({
    id: DEFINITION_ID,
    name: "Scheduled flow",
    enabled: true,
    triggerTypes: ["trigger_schedule"],
    createdById: "test",
    createdByLabel: "Test",
  });
});

// These three close the gap a probe found: every one of these behaviours was
// already correct, but nothing here could have caught a regression in it. The
// mock previously always answered getSession with a session, which made 401
// unreachable by construction.
describe("auth gaps (regression guards)", () => {
  it("401s with no session at all, distinct from an unrecognised one", async () => {
    state.noSession = true;

    expect((await call(configGet, "GET", "/config")).status).toBe(401);
  });

  it("403s a real session that belongs to no organization member, before any role is consulted", async () => {
    state.sessionUserId = "user_stranger";

    // This 403 comes from requireDashboardActor's own getDashboardActor
    // lookup returning null, not from canDispatchWorkflowRuns: config.get.ts
    // never calls the role check at all for a GET.
    expect((await call(configGet, "GET", "/config")).status).toBe(403);
  });

  it("a nodeId that belongs to another definition is treated as unknown, and that definition's row is untouched", async () => {
    const OTHER_DEFINITION_ID = DEFINITION_ID + 1;
    const OTHER_NODE_ID = "other_sched";
    await db.insert(workflowDefinitions).values({
      id: OTHER_DEFINITION_ID,
      name: "Someone else's scheduled flow",
      enabled: true,
      triggerTypes: ["trigger_schedule"],
      createdById: "test",
      createdByLabel: "Test",
    });
    const [otherMinted] = await mintSchedulesForLiveHead(db, {
      definitionId: OTHER_DEFINITION_ID,
      nodes: [{ id: OTHER_NODE_ID, type: "trigger_schedule", configuration: { cron: "0 * * * *" } }],
    });

    // DEFINITION_ID is real and live, but this nodeId only exists under
    // OTHER_DEFINITION_ID: it must read as draft, never as OTHER_DEFINITION_ID's
    // schedule leaking across, and it must not heal-mint a row for it either.
    const response = await callFor(configGet, "GET", DEFINITION_ID, OTHER_NODE_ID, "/config");
    await expect(response.json()).resolves.toEqual({
      state: "draft",
      schedule: null,
      occurrences: [],
    });

    const untouched = await getScheduleById(db, otherMinted!.scheduleId);
    expect(untouched!.pausedAt).toBeNull();
    expect(untouched!.revokedAt).toBeNull();
  });
});

describe("GET .../schedule/config", () => {
  it("reports a node that is not deployed yet, without minting", async () => {
    const response = await call(configGet, "GET", "/config");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "draft",
      schedule: null,
      occurrences: [],
    });
    expect(await db.select().from(workflowSchedules)).toEqual([]);
  });

  it("mints the missing schedule of a deployed, enabled definition on read", async () => {
    await deployScheduleDefinition();

    const response = await call(configGet, "GET", "/config");

    expect(response.status).toBe(200);
    const body = await response.json();
    const stored = await getScheduleById(db, body.schedule.scheduleId);
    expect(stored).not.toBeNull();
    expect(body.state).toBe("not_evaluated");
    expect(body.schedule).toMatchObject({
      scheduleId: stored!.id,
      // The deployed authored fields, so the editor can tell a live draft
      // edit apart from what actually runs (see A2's own note).
      cron: "0 * * * *",
      timezone: "UTC",
      pausedAt: null,
      revokedAt: null,
      lastEvaluatedAt: null,
    });
    expect(body.occurrences).toEqual([]);
  });

  it("does not mint for a disabled definition", async () => {
    await deployScheduleDefinition();
    await db
      .update(workflowDefinitions)
      .set({ enabled: false })
      .where(eq(workflowDefinitions.id, DEFINITION_ID));

    await expect((await call(configGet, "GET", "/config")).json()).resolves.toEqual({
      state: "draft",
      schedule: null,
      occurrences: [],
    });
    expect(await db.select().from(workflowSchedules)).toEqual([]);
  });

  it("does not heal-mint under a member and returns draft", async () => {
    await deployScheduleDefinition();
    state.sessionUserId = "user_member";

    await expect((await call(configGet, "GET", "/config")).json()).resolves.toEqual({
      state: "draft",
      schedule: null,
      occurrences: [],
    });
    expect(await db.select().from(workflowSchedules)).toEqual([]);
  });

  it("is readable by a member", async () => {
    state.sessionUserId = "user_member";

    expect((await call(configGet, "GET", "/config")).status).toBe(200);
  });

  it("reports evaluating once last_evaluated_at is fresh", async () => {
    const minted = await mintSchedule();
    await recordEvaluationPass(db, minted.scheduleId, new Date());

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.state).toBe("evaluating");
  });

  it("reports not_evaluated once last_evaluated_at is stale", async () => {
    const minted = await mintSchedule();
    const staleAt = new Date(Date.now() - SCHEDULE_STALE_EVALUATION_MS - 1000);
    await recordEvaluationPass(db, minted.scheduleId, staleAt);

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.state).toBe("not_evaluated");
  });

  it("reports paused ahead of not_evaluated, since a paused schedule is never evaluated", async () => {
    const minted = await mintSchedule();
    await pauseSchedule(db, minted.scheduleId);

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.state).toBe("paused");
    expect(body.schedule.pausedAt).not.toBeNull();
  });

  it("reports revoked ahead of everything else, including a schedule that is also paused", async () => {
    const minted = await mintSchedule();
    await pauseSchedule(db, minted.scheduleId);
    await revokeSchedule(db, minted.scheduleId);

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.state).toBe("revoked");
    expect(body.schedule.revokedAt).not.toBeNull();
    expect(body.schedule.pausedAt).not.toBeNull();
  });

  it("surfaces last_started_occurrence_at and last_started_run_id as the last run, never the watermark", async () => {
    const minted = await mintSchedule();
    const startedAt = new Date("2026-08-01T09:00:00.000Z");
    // Set directly on the schedule row: recordOccurrenceStarted's own write path
    // needs a live active_runs reservation to satisfy its ownership guard, which
    // is Stage 3 machinery this route never touches. This route only serializes
    // whatever is already on the row.
    await db
      .update(workflowSchedules)
      .set({ lastStartedOccurrenceAt: startedAt, lastStartedRunId: "run_99" })
      .where(eq(workflowSchedules.id, minted.scheduleId));

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.schedule.lastStartedOccurrenceAt).toBe(startedAt.toISOString());
    expect(body.schedule.lastStartedRunId).toBe("run_99");
    // The internal engine cursor never appears on the wire.
    expect(body.schedule.evaluationWatermarkAt).toBeUndefined();
  });

  it("lists this schedule's recent occurrences newest first, with the full ledger detail", async () => {
    await deployScheduleDefinition();
    const minted = await mintSchedule();
    const older = new Date("2026-08-01T09:00:00.000Z");
    const newer = new Date("2026-08-02T09:00:00.000Z");
    // Inserted directly rather than through the occurrence-store write API,
    // which is Stage 2's own moving target: this route only ever reads the
    // ledger (via listOccurrencesForSchedule), so the fixture only needs rows
    // of this exact shape, not a specific write path.
    await db.insert(scheduleOccurrences).values([
      {
        scheduleId: minted.scheduleId,
        occurrenceAt: older,
        definitionId: DEFINITION_ID,
        definitionVersion: 1,
        pending: false,
        outcome: "skipped_overlap",
        skipReason: "previous occurrence still running",
        blockingRunId: "run_123",
        droppedCount: 2,
      },
      {
        scheduleId: minted.scheduleId,
        occurrenceAt: newer,
        definitionId: DEFINITION_ID,
        definitionVersion: 1,
        pending: false,
        outcome: "expired",
        droppedCount: 60,
        droppedCountCapped: true,
        attemptCount: 3,
      },
    ]);

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.occurrences).toEqual([
      {
        occurrenceAt: newer.toISOString(),
        pending: false,
        outcome: "expired",
        skipReason: null,
        blockingRunId: null,
        runId: null,
        droppedCount: 60,
        droppedCountCapped: true,
        attemptCount: 3,
      },
      {
        occurrenceAt: older.toISOString(),
        pending: false,
        outcome: "skipped_overlap",
        skipReason: "previous occurrence still running",
        blockingRunId: "run_123",
        runId: null,
        droppedCount: 2,
        droppedCountCapped: false,
        attemptCount: 0,
      },
    ]);
  });

  it("has no occurrence yet for a freshly minted schedule", async () => {
    await mintSchedule();

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.occurrences).toEqual([]);
  });

  it("reports a pending occurrence waiting for capacity as an annotation, not a settled outcome", async () => {
    await deployScheduleDefinition();
    const minted = await mintSchedule();
    const occurrenceAt = new Date("2026-08-01T09:00:00.000Z");
    await db.insert(scheduleOccurrences).values({
      scheduleId: minted.scheduleId,
      occurrenceAt,
      definitionId: DEFINITION_ID,
      definitionVersion: 1,
      pending: true,
      outcome: null,
      skipReason: "at_capacity",
      attemptCount: 4,
    });

    const body = await (await call(configGet, "GET", "/config")).json();

    expect(body.occurrences).toEqual([
      {
        occurrenceAt: occurrenceAt.toISOString(),
        pending: true,
        outcome: null,
        skipReason: "at_capacity",
        blockingRunId: null,
        runId: null,
        droppedCount: 0,
        droppedCountCapped: false,
        attemptCount: 4,
      },
    ]);
  });
});

describe("POST .../schedule/pause", () => {
  it("pauses a deployed schedule and is idempotent", async () => {
    const minted = await mintSchedule();

    const first = await call(pausePost, "POST", "/pause");
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.scheduleId).toBe(minted.scheduleId);
    expect(typeof firstBody.pausedAt).toBe("string");

    const second = await call(pausePost, "POST", "/pause");
    expect((await second.json()).pausedAt).toBe(firstBody.pausedAt);
  });

  it("404s when the node has no schedule yet", async () => {
    expect((await call(pausePost, "POST", "/pause")).status).toBe(404);
  });

  it("rejects members with 403", async () => {
    await mintSchedule();
    state.sessionUserId = "user_member";

    expect((await call(pausePost, "POST", "/pause")).status).toBe(403);
  });

  it("409s, not 404, when the write does not take effect on a row that exists", async () => {
    const minted = await mintSchedule();
    const spy = vi.spyOn(scheduleStore, "pauseSchedule").mockResolvedValueOnce(undefined);
    try {
      const response = await call(pausePost, "POST", "/pause");
      // A row that exists but never got paused is a different failure than
      // "unknown schedule", and must not be reported with the same 404 that
      // covers a genuinely missing row (see requireScheduleRow).
      expect(response.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST .../schedule/resume", () => {
  it("resumes a paused schedule and parks the watermark one grace window behind now", async () => {
    const minted = await mintSchedule();
    await pauseSchedule(db, minted.scheduleId);
    const before = Date.now();

    const response = await call(resumePost, "POST", "/resume");

    expect(response.status).toBe(200);
    const body = await response.json();
    // The response is deliberately just the id: the evaluation watermark is an
    // internal engine cursor the contract forbids returning to the editor, so
    // the grace-window math is verified against the row, not the response.
    expect(body).toEqual({ scheduleId: minted.scheduleId });

    const row = await getScheduleById(db, minted.scheduleId);
    // mintSchedule's node carries no explicit catchUpGraceMinutes, so
    // authoredFrom defaults it to 60: the watermark should land about an hour
    // behind "now", not at "now" itself and not where the pause left it.
    const watermarkMs = row!.evaluationWatermarkAt.getTime();
    const graceMs = 60 * 60 * 1000;
    expect(watermarkMs).toBeLessThan(before);
    expect(watermarkMs).toBeGreaterThanOrEqual(before - graceMs - 5_000);
    expect(watermarkMs).toBeLessThanOrEqual(before - graceMs + 5_000);

    expect(row!.pausedAt).toBeNull();
  });

  it("is idempotent when the schedule is not paused", async () => {
    const minted = await mintSchedule();

    const response = await call(resumePost, "POST", "/resume");

    expect(response.status).toBe(200);
    expect((await response.json()).scheduleId).toBe(minted.scheduleId);
  });

  it("404s when the node has no schedule yet", async () => {
    expect((await call(resumePost, "POST", "/resume")).status).toBe(404);
  });

  it("rejects members with 403", async () => {
    const minted = await mintSchedule();
    await pauseSchedule(db, minted.scheduleId);
    state.sessionUserId = "user_member";

    expect((await call(resumePost, "POST", "/resume")).status).toBe(403);
  });

  it("409s when the write does not take effect on a row that is still paused", async () => {
    const minted = await mintSchedule();
    await pauseSchedule(db, minted.scheduleId);
    const spy = vi.spyOn(scheduleStore, "resumeSchedule").mockResolvedValueOnce(undefined);
    try {
      const response = await call(resumePost, "POST", "/resume");
      expect(response.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST .../schedule/preview", () => {
  it("computes the next occurrences for a raw cron expression", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.cron).toBe("0 9 * * *");
    expect(body.runs).toHaveLength(3);
    expect(new Date(body.runs[0]).getTime()).toBeLessThan(new Date(body.runs[1]).getTime());
  });

  it("includes a catch-up grace suggestion for a valid schedule", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    const body = await response.json();
    expect(body.ok).toBe(true);
    // A prefill hint only, see suggestedGraceMinutes's own doc comment: this
    // route must pass it through, not decide the number itself.
    expect(typeof body.suggestedGraceMinutes).toBe("number");
    expect(body.suggestedGraceMinutes).toBeGreaterThan(0);
  });

  it("compiles a weekly preset to the same cron the worker would evaluate", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "preset",
      preset: { kind: "weekly", weekdays: [1, 3, 5], hour: 9, minute: 0 },
      timezone: "UTC",
    });

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.cron).toBe("0 9 * * 1,3,5");
    expect(body.runs).toHaveLength(3);
  });

  it("compiles an interval preset in UTC regardless of the requested timezone", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "preset",
      preset: { kind: "every-n-minutes", minutes: 15 },
      timezone: "Europe/Warsaw",
    });

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.cron).toBe("*/15 * * * *");
    // An interval has no clock meaning, so occurrence.ts overrides the zone:
    // this must not echo back "Europe/Warsaw".
    expect(body.timezone).toBe("UTC");
  });

  it("keeps the requested timezone for a clock-anchored preset", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "preset",
      preset: { kind: "daily", hour: 9, minute: 0 },
      timezone: "Europe/Warsaw",
    });

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.timezone).toBe("Europe/Warsaw");
  });

  it("rejects a disallowed preset step without inventing its own reason or message", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "preset",
      preset: { kind: "every-n-minutes", minutes: 25 },
      timezone: "UTC",
    });

    const body = await response.json();
    expect(body.ok).toBe(false);
    // Not pinned to a specific reason or wording: stepProblem's own math (a
    // step that does not divide sixty has a real minimum gap below the step
    // itself, see occurrence.ts) decides whether this reads as
    // "below-minimum-period" or "invalid-expression", and that decision is
    // Stage 1's, not this route's. This test's job is only to confirm the
    // route passes the worker's answer through unchanged, so it asserts a
    // structurally valid problem rather than a specific one.
    expect(["below-minimum-period", "invalid-expression"]).toContain(body.problem.reason);
    expect(typeof body.problem.message).toBe("string");
    expect(body.problem.message.length).toBeGreaterThan(0);
  });

  it("rejects a cron below the minimum period", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "cron",
      cron: "* * * * *",
      timezone: "UTC",
    });

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.problem.reason).toBe("below-minimum-period");
  });

  it("rejects an unknown IANA timezone", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "cron",
      cron: "0 9 * * *",
      timezone: "Not/AZone",
    });

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.problem.reason).toBe("invalid-timezone");
  });

  it("works for a draft node that was never deployed", async () => {
    const response = await call(previewPost, "POST", "/preview", {
      source: "cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  it("is usable by a member, since it mutates nothing", async () => {
    state.sessionUserId = "user_member";

    const response = await call(previewPost, "POST", "/preview", {
      source: "cron",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(response.status).toBe(200);
  });
});
