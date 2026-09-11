/* oxlint-disable eslint/max-lines-per-function */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../client.js";
import {
  scheduleOccurrences,
  workflowDefinitionVersions,
  workflowDefinitions,
  workflowSchedules,
} from "../schema.js";
import { createTestDb } from "../test-db.js";
import { createDefinitionsRepository } from "./definitions.js";

vi.mock("../../config/env.js", () => ({ env: {} }));

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

describe("definitions repository", () => {
  it("creates a definition and initial version atomically", async () => {
    const repository = createDefinitionsRepository(db);
    const created = await repository.createWithInitialVersion({
      name: "Atomic definition",
      layout: { nodes: {} },
      layoutRevision: 1,
      actorId: "author",
      actorLabel: "Author",
      initialDefinition: { schemaVersion: 2, nodes: [], edges: [] },
    });

    expect(created.initialVersion).toBe(1);
    const [definition] = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, created.definitionId));
    const [version] = await db
      .select()
      .from(workflowDefinitionVersions)
      .where(
        and(
          eq(workflowDefinitionVersions.definitionId, created.definitionId),
          eq(workflowDefinitionVersions.version, 1),
        ),
      );
    expect(definition).toMatchObject({ name: "Atomic definition", enabled: false });
    expect(version).toMatchObject({ createdById: "author", createdByLabel: "Author" });
  });

  it("rolls back the definition when the dependent version write fails", async () => {
    const repository = createDefinitionsRepository(db);
    await expect(
      repository.createWithInitialVersion({
        name: "Rollback definition",
        layout: { nodes: {} },
        layoutRevision: 1,
        actorId: null as never,
        actorLabel: "Author",
        initialDefinition: { schemaVersion: 2, nodes: [], edges: [] },
      }),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, "Rollback definition"));
    expect(rows).toEqual([]);
  });

  it("settles a waiting occurrence on first revoke and preserves the first instant on repeat", async () => {
    await db.insert(workflowDefinitions).values({
      id: 871,
      name: "Schedule definition",
      createdById: "author",
      createdByLabel: "Author",
    });
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 871,
      version: 1,
      definition: {},
      createdById: "author",
      createdByLabel: "Author",
    });
    await db.insert(workflowSchedules).values({
      id: "schedule-871",
      definitionId: 871,
      nodeId: "schedule-node",
      cron: "0 * * * *",
      evaluationWatermarkAt: new Date("2026-09-10T09:00:00.000Z"),
    });
    await db.insert(scheduleOccurrences).values({
      scheduleId: "schedule-871",
      occurrenceAt: new Date("2026-09-10T10:00:00.000Z"),
      definitionId: 871,
      definitionVersion: 1,
      pending: true,
    });

    const repository = createDefinitionsRepository(db);
    const first = new Date("2026-09-10T10:05:00.000Z");
    const execute = vi.spyOn(db, "execute");
    try {
      expect(await repository.revokeScheduleAndCancelWaiting("schedule-871", first)).toEqual({
        revoked: true,
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      execute.mockRestore();
    }
    expect(
      await repository.revokeScheduleAndCancelWaiting(
        "schedule-871",
        new Date("2026-09-10T11:05:00.000Z"),
      ),
    ).toEqual({ revoked: false });

    const [schedule] = await db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.id, "schedule-871"));
    const [occurrence] = await db
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.scheduleId, "schedule-871"));
    expect(schedule?.revokedAt).toEqual(first);
    expect(occurrence).toMatchObject({ pending: false, outcome: "cancelled", skipReason: "schedule_revoked" });
  });

  it("settles a pending occurrence when the schedule was already revoked", async () => {
    const revokedAt = new Date("2026-09-10T10:05:00.000Z");
    await db.insert(workflowDefinitions).values({
      id: 872,
      name: "Already revoked schedule definition",
      createdById: "author",
      createdByLabel: "Author",
    });
    await db.insert(workflowDefinitionVersions).values({
      definitionId: 872,
      version: 1,
      definition: {},
      createdById: "author",
      createdByLabel: "Author",
    });
    await db.insert(workflowSchedules).values({
      id: "schedule-872",
      definitionId: 872,
      nodeId: "schedule-node",
      cron: "0 * * * *",
      evaluationWatermarkAt: new Date("2026-09-10T09:00:00.000Z"),
      revokedAt,
    });
    await db.insert(scheduleOccurrences).values({
      scheduleId: "schedule-872",
      occurrenceAt: new Date("2026-09-10T10:00:00.000Z"),
      definitionId: 872,
      definitionVersion: 1,
      pending: true,
    });

    await expect(
      createDefinitionsRepository(db).revokeScheduleAndCancelWaiting(
        "schedule-872",
        new Date("2026-09-10T11:05:00.000Z"),
      ),
    ).resolves.toEqual({ revoked: false });

    const [schedule] = await db
      .select()
      .from(workflowSchedules)
      .where(eq(workflowSchedules.id, "schedule-872"));
    const [occurrence] = await db
      .select()
      .from(scheduleOccurrences)
      .where(eq(scheduleOccurrences.scheduleId, "schedule-872"));
    expect(schedule?.revokedAt).toEqual(revokedAt);
    expect(occurrence).toMatchObject({
      pending: false,
      outcome: "cancelled",
      skipReason: "schedule_revoked",
    });
  });
});
