import { asc } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkScopeActor, WorkScopeEntry, WorkScopeWritePlan } from "@shared/contracts";
import type { Db } from "../client.js";
import { workScopeEntries, workScopes, workScopeTrail } from "../schema.js";
import { createTestDb } from "../test-db.js";
import {
  applyAnswerWorkScopePlan,
  applyPersonWorkScopeEdit,
  applyRunWorkScopePlan,
  listWorkScopeTrail,
  readWorkScope,
} from "./work-scope.js";

let db: Db;
const subjectKey = "ticket:jira:AWT-1";
const runActor: WorkScopeActor = {
  kind: "run",
  runId: "run-1",
  definitionId: 4,
  definitionVersion: 7,
};

function entry(repositoryKey: string, overrides: Partial<WorkScopeEntry> = {}): WorkScopeEntry {
  return {
    repositoryKey,
    state: "selected",
    origin: "ticket_text",
    rationale: "The ticket names it.",
    decidedBy: runActor,
    decidedAt: "2026-09-15T10:00:00.000Z",
    ...overrides,
  };
}

function upsertsOnly(...entries: WorkScopeEntry[]): WorkScopeWritePlan {
  return {
    upserts: entries.map((value) => ({ entry: value, replacesExpired: false })),
    deletes: [],
    trail: [],
  };
}

async function entriesOf(key: string) {
  return (await readWorkScope(db, key))?.entries ?? [];
}

beforeEach(async () => {
  db = await createTestDb();
});

describe("readWorkScope", () => {
  it("returns null for a subject with no record", async () => {
    await expect(readWorkScope(db, "ticket:jira:AWT-1")).resolves.toBeNull();
  });
});

describe("applyRunWorkScopePlan", () => {
  it("creates version 1, its entries and its trail rows on a new subject", async () => {
    const api = entry("github:acme/api");
    const web = entry("github:acme/web", {
      state: "unavailable",
      unavailableReason: "not_enabled",
      origin: "trigger_policy",
      rationale: "Listed by the trigger, not enabled in the catalog.",
    });

    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        plan: {
          upserts: [
            { entry: web, replacesExpired: false },
            { entry: api, replacesExpired: false },
          ],
          deletes: [],
          trail: [
            { kind: "entry_written", entry: api, previousState: null },
            {
              kind: "map_shown",
              text: "api, web",
              repositoryKeys: ["github:acme/api", "github:acme/web"],
            },
          ],
        },
      }),
    ).resolves.toEqual({ version: 1 });

    await expect(readWorkScope(db, subjectKey)).resolves.toEqual({
      subjectKey: "ticket:jira:AWT-1",
      version: 1,
      entries: [
        {
          repositoryKey: "github:acme/api",
          state: "selected",
          origin: "ticket_text",
          rationale: "The ticket names it.",
          decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
          decidedAt: "2026-09-15T10:00:00.000Z",
        },
        {
          repositoryKey: "github:acme/web",
          state: "unavailable",
          unavailableReason: "not_enabled",
          origin: "trigger_policy",
          rationale: "Listed by the trigger, not enabled in the catalog.",
          decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
          decidedAt: "2026-09-15T10:00:00.000Z",
        },
      ],
    });

    await expect(
      listWorkScopeTrail(db, { subjectKey }, { limit: 10 }),
    ).resolves.toEqual({
      rows: [
        {
          id: 2,
          subjectKey: "ticket:jira:AWT-1",
          runId: "run-1",
          at: expect.any(String),
          event: {
            kind: "map_shown",
            text: "api, web",
            repositoryKeys: ["github:acme/api", "github:acme/web"],
          },
        },
        {
          id: 1,
          subjectKey: "ticket:jira:AWT-1",
          runId: "run-1",
          at: expect.any(String),
          event: { kind: "entry_written", entry: api, previousState: null },
        },
      ],
      nextBeforeId: null,
    });
    await expect(
      db
        .select({
          id: workScopeTrail.id,
          kind: workScopeTrail.kind,
          repositoryKey: workScopeTrail.repositoryKey,
        })
        .from(workScopeTrail)
        .orderBy(asc(workScopeTrail.id)),
    ).resolves.toEqual([
      { id: 1, kind: "entry_written", repositoryKey: "github:acme/api" },
      { id: 2, kind: "map_shown", repositoryKey: null },
    ]);
  });
});

describe("origin precedence", () => {
  it("leaves a person's entry when an inferred entry arrives for the same repository", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(
        entry("github:acme/api", { origin: "person", rationale: "Ada chose it." }),
      ),
    });
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-2",
      plan: upsertsOnly(
        entry("github:acme/api", { state: "excluded", origin: "inferred", rationale: "Guessed." }),
      ),
    });

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        rationale: "Ada chose it.",
        decidedBy: runActor,
        decidedAt: "2026-09-15T10:00:00.000Z",
      },
    ]);
  });

  it("replaces a ticket text entry with a newer ticket text entry", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(entry("github:acme/api", { rationale: "The old text names it." })),
    });
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-2",
      plan: upsertsOnly(
        entry("github:acme/api", {
          state: "excluded",
          rationale: "The corrected text rules it out.",
          decidedAt: "2026-09-15T11:00:00.000Z",
        }),
      ),
    });

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "excluded",
        origin: "ticket_text",
        rationale: "The corrected text rules it out.",
        decidedBy: runActor,
        decidedAt: "2026-09-15T11:00:00.000Z",
      },
    ]);
  });

  it("replaces an inferred entry with a trigger policy entry", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(entry("github:acme/api", { origin: "inferred", rationale: "Guessed." })),
    });
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-2",
      plan: upsertsOnly(
        entry("github:acme/api", { origin: "trigger_policy", rationale: "The trigger lists it." }),
      ),
    });

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "trigger_policy",
        rationale: "The trigger lists it.",
        decidedBy: runActor,
        decidedAt: "2026-09-15T10:00:00.000Z",
      },
    ]);
  });
});

describe("replacesExpired", () => {
  const personActor: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };

  async function seedPersonEntry(overrides: Partial<WorkScopeEntry>) {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(
        entry("github:acme/api", {
          origin: "person",
          rationale: "Ada could not give it.",
          decidedBy: personActor,
          ...overrides,
        }),
      ),
    });
  }

  async function attachEnabled() {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-2",
      plan: {
        upserts: [
          {
            entry: entry("github:acme/api", {
              origin: "inferred",
              rationale: "Enabled since, attached.",
              decidedAt: "2026-09-15T12:00:00.000Z",
            }),
            replacesExpired: true,
          },
        ],
        deletes: [],
        trail: [],
      },
    });
  }

  it("replaces an unavailable entry whose reason was not_enabled", async () => {
    await seedPersonEntry({ state: "unavailable", unavailableReason: "not_enabled" });
    await attachEnabled();

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "inferred",
        rationale: "Enabled since, attached.",
        decidedBy: runActor,
        decidedAt: "2026-09-15T12:00:00.000Z",
      },
    ]);
  });

  it("replaces an unavailable entry whose reason was unusable", async () => {
    await seedPersonEntry({ state: "unavailable", unavailableReason: "unusable" });
    await attachEnabled();

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "inferred",
        rationale: "Enabled since, attached.",
        decidedBy: runActor,
        decidedAt: "2026-09-15T12:00:00.000Z",
      },
    ]);
  });

  it("leaves a selected entry", async () => {
    await seedPersonEntry({ rationale: "Ada chose it." });
    await attachEnabled();

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "person",
        rationale: "Ada chose it.",
        decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
        decidedAt: "2026-09-15T10:00:00.000Z",
      },
    ]);
  });

  it("leaves an excluded entry", async () => {
    await seedPersonEntry({ state: "excluded", rationale: "Ada ruled it out." });
    await attachEnabled();

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "excluded",
        origin: "person",
        rationale: "Ada ruled it out.",
        decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
        decidedAt: "2026-09-15T10:00:00.000Z",
      },
    ]);
  });
});

describe("compare-and-delete", () => {
  async function seedTicketTextEntry() {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(entry("github:acme/api")),
    });
  }

  function removal(origin: WorkScopeEntry["origin"]): WorkScopeWritePlan {
    return {
      upserts: [],
      deletes: [{ repositoryKey: "github:acme/api", origin }],
      trail: [
        {
          kind: "entry_removed",
          entry: entry("github:acme/api", { origin }),
          removedBy: { kind: "run", runId: "run-2", definitionId: 4, definitionVersion: 7 },
        },
      ],
    };
  }

  it("leaves the row, the version and the trail when its origin no longer matches", async () => {
    await seedTicketTextEntry();

    await expect(
      applyRunWorkScopePlan(db, { subjectKey, runId: "run-2", plan: removal("inferred") }),
    ).resolves.toEqual({ version: 1 });

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "ticket_text",
        rationale: "The ticket names it.",
        decidedBy: runActor,
        decidedAt: "2026-09-15T10:00:00.000Z",
      },
    ]);
    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
  });

  it("removes the row when its origin matches, and appends the removal", async () => {
    await seedTicketTextEntry();

    await expect(
      applyRunWorkScopePlan(db, { subjectKey, runId: "run-2", plan: removal("ticket_text") }),
    ).resolves.toEqual({ version: 2 });

    await expect(readWorkScope(db, subjectKey)).resolves.toEqual({
      subjectKey: "ticket:jira:AWT-1",
      version: 2,
      entries: [],
    });
    await expect(
      listWorkScopeTrail(db, { subjectKey }, { limit: 10 }),
    ).resolves.toEqual({
      rows: [
        {
          id: 1,
          subjectKey: "ticket:jira:AWT-1",
          runId: "run-2",
          at: expect.any(String),
          event: {
            kind: "entry_removed",
            entry: {
              repositoryKey: "github:acme/api",
              state: "selected",
              origin: "ticket_text",
              rationale: "The ticket names it.",
              decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
              decidedAt: "2026-09-15T10:00:00.000Z",
            },
            removedBy: { kind: "run", runId: "run-2", definitionId: 4, definitionVersion: 7 },
          },
        },
      ],
      nextBeforeId: null,
    });
    await expect(
      db.select({ repositoryKey: workScopeTrail.repositoryKey }).from(workScopeTrail),
    ).resolves.toEqual([{ repositoryKey: "github:acme/api" }]);
  });
});

// pglite runs one statement at a time, so the Promise.all cases below prove the
// statements compose, not that they are safe under real concurrency.
describe("two runs on one subject", () => {
  it("keeps both runs' entries and moves the version once per write", async () => {
    await expect(
      Promise.all([
        applyRunWorkScopePlan(db, {
          subjectKey,
          runId: "run-1",
          plan: upsertsOnly(entry("github:acme/api")),
        }),
        applyRunWorkScopePlan(db, {
          subjectKey,
          runId: "run-2",
          plan: upsertsOnly(entry("github:acme/web", { origin: "inferred", rationale: "Guessed." })),
        }),
      ]),
    ).resolves.toHaveLength(2);

    const scope = await readWorkScope(db, subjectKey);
    expect(scope?.version).toBe(2);
    expect(scope?.entries.map((value) => [value.repositoryKey, value.origin])).toEqual([
      ["github:acme/api", "ticket_text"],
      ["github:acme/web", "inferred"],
    ]);
  });
});

describe("applyPersonWorkScopeEdit", () => {
  const ada: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };
  const adaSelectsWeb = entry("github:acme/web", {
    origin: "person",
    rationale: "Ada needs the web app.",
    decidedBy: ada,
    decidedAt: "2026-09-15T13:00:00.000Z",
  });

  async function seedRunScope() {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(
        entry("github:acme/api"),
        entry("github:acme/docs", { origin: "inferred", rationale: "Guessed." }),
        entry("github:acme/infra", { origin: "trigger_policy", rationale: "Listed." }),
      ),
    });
  }

  it("refuses a stale version and writes no entry and no trail row", async () => {
    await seedRunScope();

    await expect(
      applyPersonWorkScopeEdit(db, {
        subjectKey,
        expectedVersion: 0,
        plan: {
          upserts: [{ entry: adaSelectsWeb, replacesExpired: false }],
          deletes: [{ repositoryKey: "github:acme/api", origin: "ticket_text" }],
          trail: [{ kind: "entry_written", entry: adaSelectsWeb, previousState: null }],
        },
      }),
    ).resolves.toEqual({ outcome: "conflict", currentVersion: 1 });

    const scope = await readWorkScope(db, subjectKey);
    expect(scope?.version).toBe(1);
    expect(scope?.entries.map((value) => value.repositoryKey)).toEqual([
      "github:acme/api",
      "github:acme/infra",
      "github:acme/docs",
    ]);
    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
  });

  it("applies on the current version, moves it by one and records no run", async () => {
    await seedRunScope();
    const adaExcludesDocs = entry("github:acme/docs", {
      state: "excluded",
      origin: "person",
      rationale: "Ada ruled it out.",
      decidedBy: ada,
      decidedAt: "2026-09-15T13:00:00.000Z",
    });

    const outcome = await applyPersonWorkScopeEdit(db, {
      subjectKey,
      expectedVersion: 1,
      plan: {
        upserts: [
          { entry: adaSelectsWeb, replacesExpired: false },
          { entry: adaExcludesDocs, replacesExpired: false },
        ],
        deletes: [{ repositoryKey: "github:acme/api", origin: "ticket_text" }],
        trail: [
          { kind: "entry_written", entry: adaSelectsWeb, previousState: null },
          { kind: "entry_written", entry: adaExcludesDocs, previousState: "selected" },
        ],
      },
    });

    const expectedScope = {
      subjectKey: "ticket:jira:AWT-1",
      version: 2,
      entries: [
        {
          repositoryKey: "github:acme/docs",
          state: "excluded",
          origin: "person",
          rationale: "Ada ruled it out.",
          decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
          decidedAt: "2026-09-15T13:00:00.000Z",
        },
        {
          repositoryKey: "github:acme/web",
          state: "selected",
          origin: "person",
          rationale: "Ada needs the web app.",
          decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
          decidedAt: "2026-09-15T13:00:00.000Z",
        },
        {
          repositoryKey: "github:acme/infra",
          state: "selected",
          origin: "trigger_policy",
          rationale: "Listed.",
          decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
          decidedAt: "2026-09-15T10:00:00.000Z",
        },
      ],
    };
    expect(outcome).toEqual({ outcome: "applied", scope: expectedScope });
    await expect(readWorkScope(db, subjectKey)).resolves.toEqual(expectedScope);
    await expect(
      db
        .select({
          subjectKey: workScopeTrail.subjectKey,
          runId: workScopeTrail.runId,
          repositoryKey: workScopeTrail.repositoryKey,
        })
        .from(workScopeTrail)
        .orderBy(asc(workScopeTrail.id)),
    ).resolves.toEqual([
      { subjectKey: "ticket:jira:AWT-1", runId: null, repositoryKey: "github:acme/web" },
      { subjectKey: "ticket:jira:AWT-1", runId: null, repositoryKey: "github:acme/docs" },
    ]);
  });
});

describe("a run with no subject", () => {
  const refusal = {
    kind: "request_refused",
    repositoryKey: "github:acme/api",
    reason: "outside_policy",
  } as const;

  it("writes a trail readable by its run and by no subject, and no version", async () => {
    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey: null,
        runId: "run-schedule-1",
        plan: { upserts: [], deletes: [], trail: [refusal] },
      }),
    ).resolves.toEqual({ version: null });

    await expect(
      listWorkScopeTrail(db, { runId: "run-schedule-1" }, { limit: 10 }),
    ).resolves.toEqual({
      rows: [
        {
          id: 1,
          subjectKey: null,
          runId: "run-schedule-1",
          at: expect.any(String),
          event: { kind: "request_refused", repositoryKey: "github:acme/api", reason: "outside_policy" },
        },
      ],
      nextBeforeId: null,
    });
    await expect(
      db.select({ repositoryKey: workScopeTrail.repositoryKey }).from(workScopeTrail),
    ).resolves.toEqual([{ repositoryKey: "github:acme/api" }]);
    await expect(
      listWorkScopeTrail(db, { subjectKey: "ticket:jira:AWT-1" }, { limit: 10 }),
    ).resolves.toEqual({ rows: [], nextBeforeId: null });
    await expect(db.select().from(workScopes)).resolves.toEqual([]);
  });

  it("throws on an upsert and writes nothing", async () => {
    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey: null,
        runId: "run-schedule-1",
        plan: {
          upserts: [{ entry: entry("github:acme/api"), replacesExpired: false }],
          deletes: [],
          trail: [refusal],
        },
      }),
    ).rejects.toThrow("A run with no subject writes no entry and no entry event.");

    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
    await expect(db.select().from(workScopeEntries)).resolves.toEqual([]);
  });

  it("throws on an entry event and writes nothing", async () => {
    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey: null,
        runId: "run-schedule-1",
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            refusal,
            {
              kind: "entry_removed",
              entry: entry("github:acme/web"),
              removedBy: runActor,
            },
          ],
        },
      }),
    ).rejects.toThrow("A run with no subject writes no entry and no entry event.");

    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
  });
});

describe("listWorkScopeTrail paging", () => {
  const ada: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };

  // Ids 1 to 6 in this order; the answers go through the only path that may
  // write them.
  async function seedSixRows() {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_asked",
            clarificationId: "clarification-1",
            repositories: [{ repositoryKey: "github:acme/api", askedBecause: "selection" }],
          },
          { kind: "map_shown", text: "api", repositoryKeys: ["github:acme/api"] },
        ],
      },
    });
    await applyAnswerWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      clarificationId: "clarification-1",
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_answered",
            clarificationId: "clarification-1",
            answer: { kind: "none" },
            answeredBy: ada,
          },
        ],
      },
    });
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-2",
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_asked",
            clarificationId: "clarification-2",
            repositories: [{ repositoryKey: "github:acme/web", askedBecause: "not_enabled" }],
          },
          { kind: "map_shown", text: "api, web", repositoryKeys: ["github:acme/api"] },
        ],
      },
    });
    await applyAnswerWorkScopePlan(db, {
      subjectKey,
      runId: "run-2",
      clarificationId: "clarification-2",
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_answered",
            clarificationId: "clarification-2",
            answer: { kind: "repositories", repositoryKeys: ["github:acme/web"] },
            answeredBy: ada,
          },
        ],
      },
    });
  }

  function idsAndKinds(result: Awaited<ReturnType<typeof listWorkScopeTrail>>) {
    return {
      rows: result.rows.map((row) => [row.id, row.event.kind]),
      nextBeforeId: result.nextBeforeId,
    };
  }

  it("pages newest first with limit and beforeId", async () => {
    await seedSixRows();

    const first = await listWorkScopeTrail(db, { subjectKey }, { limit: 4 });
    expect(idsAndKinds(first)).toEqual({
      rows: [
        [6, "question_answered"],
        [5, "map_shown"],
        [4, "question_asked"],
        [3, "question_answered"],
      ],
      nextBeforeId: 3,
    });
    const second = await listWorkScopeTrail(db, { subjectKey }, { limit: 4, beforeId: 3 });
    expect(idsAndKinds(second)).toEqual({
      rows: [
        [2, "map_shown"],
        [1, "question_asked"],
      ],
      nextBeforeId: null,
    });
    const exact = await listWorkScopeTrail(db, { subjectKey, kinds: [] }, { limit: 6 });
    expect(exact.rows.map((row) => row.id)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(exact.nextBeforeId).toBeNull();
  });

  it("filters to the kinds asked for and pages within them", async () => {
    await seedSixRows();
    const kinds = ["question_asked", "question_answered"] as const;

    const first = await listWorkScopeTrail(db, { subjectKey, kinds: [...kinds] }, { limit: 3 });
    expect(idsAndKinds(first)).toEqual({
      rows: [
        [6, "question_answered"],
        [4, "question_asked"],
        [3, "question_answered"],
      ],
      nextBeforeId: 3,
    });
    const second = await listWorkScopeTrail(
      db,
      { subjectKey, kinds: [...kinds] },
      { limit: 3, beforeId: 3 },
    );
    expect(idsAndKinds(second)).toEqual({
      rows: [[1, "question_asked"]],
      nextBeforeId: null,
    });
  });

  it("refuses a limit outside 1 to 200", async () => {
    await expect(listWorkScopeTrail(db, { subjectKey }, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(listWorkScopeTrail(db, { subjectKey }, { limit: 201 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("applyAnswerWorkScopePlan", () => {
  const ada: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };
  const adaSelectsWeb = entry("github:acme/web", {
    origin: "person",
    rationale: "Ada answered with the web app.",
    decidedBy: ada,
    decidedAt: "2026-09-15T14:00:00.000Z",
  });

  function answerPlan(clarificationId: string): WorkScopeWritePlan {
    return {
      upserts: [{ entry: adaSelectsWeb, replacesExpired: false }],
      deletes: [],
      trail: [
        {
          kind: "question_answered",
          clarificationId,
          answer: { kind: "repositories", repositoryKeys: ["github:acme/web"] },
          answeredBy: ada,
        },
        { kind: "entry_written", entry: adaSelectsWeb, previousState: null, clarificationId },
      ],
    };
  }

  async function seedRunScope() {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(entry("github:acme/api")),
    });
  }

  async function counts() {
    return {
      entries: (await db.select().from(workScopeEntries)).length,
      trail: (await db.select().from(workScopeTrail)).length,
      version: (await readWorkScope(db, subjectKey))?.version ?? null,
    };
  }

  it("applies the first time: entries, every trail row, version moved by one", async () => {
    await seedRunScope();

    await expect(
      applyAnswerWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        clarificationId: "clarification-1",
        plan: answerPlan("clarification-1"),
      }),
    ).resolves.toEqual({ outcome: "applied", version: 2 });

    await expect(entriesOf(subjectKey)).resolves.toEqual([
      {
        repositoryKey: "github:acme/web",
        state: "selected",
        origin: "person",
        rationale: "Ada answered with the web app.",
        decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
        decidedAt: "2026-09-15T14:00:00.000Z",
      },
      {
        repositoryKey: "github:acme/api",
        state: "selected",
        origin: "ticket_text",
        rationale: "The ticket names it.",
        decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
        decidedAt: "2026-09-15T10:00:00.000Z",
      },
    ]);
    await expect(
      db
        .select({
          subjectKey: workScopeTrail.subjectKey,
          runId: workScopeTrail.runId,
          kind: workScopeTrail.kind,
          repositoryKey: workScopeTrail.repositoryKey,
        })
        .from(workScopeTrail)
        .orderBy(asc(workScopeTrail.id)),
    ).resolves.toEqual([
      {
        subjectKey: "ticket:jira:AWT-1",
        runId: "run-1",
        kind: "question_answered",
        repositoryKey: null,
      },
      {
        subjectKey: "ticket:jira:AWT-1",
        runId: "run-1",
        kind: "entry_written",
        repositoryKey: "github:acme/web",
      },
    ]);
  });

  it("writes nothing when the same answer is applied again", async () => {
    await seedRunScope();
    const apply = () =>
      applyAnswerWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        clarificationId: "clarification-1",
        plan: answerPlan("clarification-1"),
      });
    await apply();
    await expect(counts()).resolves.toEqual({ entries: 2, trail: 2, version: 2 });

    await expect(apply()).resolves.toEqual({ outcome: "already_applied" });

    await expect(counts()).resolves.toEqual({ entries: 2, trail: 2, version: 2 });
  });

  it("applies exactly once when two identical answers start together", async () => {
    await seedRunScope();
    const apply = () =>
      applyAnswerWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        clarificationId: "clarification-1",
        plan: answerPlan("clarification-1"),
      });

    const outcomes = await Promise.all([apply(), apply()]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
      "already_applied",
      "applied",
    ]);
    await expect(counts()).resolves.toEqual({ entries: 2, trail: 2, version: 2 });
  });

  it("throws before any SQL when the plan carries no answer for the clarification", async () => {
    await seedRunScope();

    await expect(
      applyAnswerWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        clarificationId: "clarification-1",
        plan: answerPlan("clarification-2"),
      }),
    ).rejects.toThrow(
      'An answer plan carries exactly one question_answered event for "clarification-1".',
    );

    await expect(counts()).resolves.toEqual({ entries: 1, trail: 0, version: 1 });
  });

  it("applies an answer to a different clarification on the same subject", async () => {
    await seedRunScope();
    await applyAnswerWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      clarificationId: "clarification-1",
      plan: answerPlan("clarification-1"),
    });

    await expect(
      applyAnswerWorkScopePlan(db, {
        subjectKey,
        runId: "run-2",
        clarificationId: "clarification-2",
        plan: answerPlan("clarification-2"),
      }),
    ).resolves.toEqual({ outcome: "applied", version: 3 });

    await expect(counts()).resolves.toEqual({ entries: 2, trail: 4, version: 3 });
  });
});

describe("the trail records only what the record took", () => {
  it("appends no entry_written for a refused upsert and no entry_removed for a missed delete", async () => {
    const ada: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(
        entry("github:acme/api", { origin: "person", rationale: "Ada chose it.", decidedBy: ada }),
        entry("github:acme/web"),
      ),
    });
    const guessedApi = entry("github:acme/api", {
      state: "excluded",
      origin: "inferred",
      rationale: "Guessed.",
      decidedBy: { kind: "run", runId: "run-2", definitionId: 4, definitionVersion: 7 },
    });

    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey,
        runId: "run-2",
        plan: {
          upserts: [{ entry: guessedApi, replacesExpired: false }],
          deletes: [{ repositoryKey: "github:acme/web", origin: "inferred" }],
          trail: [
            { kind: "entry_written", entry: guessedApi, previousState: "selected" },
            {
              kind: "entry_removed",
              entry: entry("github:acme/web", { origin: "inferred" }),
              removedBy: { kind: "run", runId: "run-2", definitionId: 4, definitionVersion: 7 },
            },
            { kind: "request_refused", repositoryKey: "github:acme/docs", reason: "outside_policy" },
          ],
        },
      }),
    ).resolves.toEqual({ version: 1 });

    await expect(
      db
        .select({ kind: workScopeTrail.kind, repositoryKey: workScopeTrail.repositoryKey })
        .from(workScopeTrail),
    ).resolves.toEqual([{ kind: "request_refused", repositoryKey: "github:acme/docs" }]);
  });
});

describe("the version moves only when an entry changed", () => {
  it("keeps the version for a run plan that carries only trail rows", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(entry("github:acme/api")),
    });

    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey,
        runId: "run-2",
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: "github:acme/web", reason: "outside_policy" },
            { kind: "map_shown", text: "api", repositoryKeys: ["github:acme/api"] },
          ],
        },
      }),
    ).resolves.toEqual({ version: 1 });

    expect((await readWorkScope(db, subjectKey))?.version).toBe(1);
    expect((await db.select().from(workScopeTrail)).map((row) => row.kind)).toEqual([
      "request_refused",
      "map_shown",
    ]);
  });

  it("applies a person edit that changes nothing and keeps the version", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: upsertsOnly(entry("github:acme/api")),
    });

    await expect(
      applyPersonWorkScopeEdit(db, {
        subjectKey,
        expectedVersion: 1,
        plan: {
          upserts: [],
          deletes: [{ repositoryKey: "github:acme/api", origin: "person" }],
          trail: [],
        },
      }),
    ).resolves.toEqual({
      outcome: "applied",
      scope: {
        subjectKey: "ticket:jira:AWT-1",
        version: 1,
        entries: [
          {
            repositoryKey: "github:acme/api",
            state: "selected",
            origin: "ticket_text",
            rationale: "The ticket names it.",
            decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
            decidedAt: "2026-09-15T10:00:00.000Z",
          },
        ],
      },
    });
    expect((await readWorkScope(db, subjectKey))?.version).toBe(1);
  });
});

describe("answer rows only through the answer path", () => {
  const ada: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };
  const answeredNone = {
    kind: "question_answered",
    clarificationId: "clarification-1",
    answer: { kind: "none" },
    answeredBy: ada,
  } as const;

  it("throws on a run plan carrying an answer and writes nothing", async () => {
    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        plan: { ...upsertsOnly(entry("github:acme/api")), trail: [answeredNone] },
      }),
    ).rejects.toThrow("A question_answered event is written only through the answer path.");

    await expect(db.select().from(workScopes)).resolves.toEqual([]);
    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
  });

  it("throws on a person plan carrying an answer and writes nothing", async () => {
    await expect(
      applyPersonWorkScopeEdit(db, {
        subjectKey,
        expectedVersion: 0,
        plan: { upserts: [], deletes: [], trail: [answeredNone] },
      }),
    ).rejects.toThrow("A question_answered event is written only through the answer path.");

    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
  });

  it("throws on an answer plan carrying a second, different answer", async () => {
    await expect(
      applyAnswerWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        clarificationId: "clarification-1",
        plan: {
          upserts: [],
          deletes: [],
          trail: [answeredNone, { ...answeredNone, clarificationId: "clarification-2" }],
        },
      }),
    ).rejects.toThrow(
      'An answer plan carries exactly one question_answered event for "clarification-1".',
    );

    await expect(db.select().from(workScopeTrail)).resolves.toEqual([]);
  });
});

describe("a subject with no record", () => {
  it("gets no record from a plan that carries only trail rows", async () => {
    await expect(
      applyRunWorkScopePlan(db, {
        subjectKey,
        runId: "run-1",
        plan: {
          upserts: [],
          deletes: [],
          trail: [
            { kind: "request_refused", repositoryKey: "github:acme/api", reason: "outside_policy" },
          ],
        },
      }),
    ).resolves.toEqual({ version: 0 });

    await expect(db.select().from(workScopes)).resolves.toEqual([]);
    await expect(readWorkScope(db, subjectKey)).resolves.toBeNull();
    expect((await db.select().from(workScopeTrail)).map((row) => row.subjectKey)).toEqual([
      "ticket:jira:AWT-1",
    ]);
  });

  it("gets version 1 from a person edit expecting version 0", async () => {
    const ada: WorkScopeActor = { kind: "person", actorId: "user-1", actorLabel: "Ada" };

    await expect(
      applyPersonWorkScopeEdit(db, {
        subjectKey,
        expectedVersion: 0,
        plan: {
          upserts: [
            {
              entry: entry("github:acme/api", {
                state: "excluded",
                origin: "person",
                rationale: "Ada ruled it out.",
                decidedBy: ada,
              }),
              replacesExpired: false,
            },
          ],
          deletes: [],
          trail: [],
        },
      }),
    ).resolves.toEqual({
      outcome: "applied",
      scope: {
        subjectKey: "ticket:jira:AWT-1",
        version: 1,
        entries: [
          {
            repositoryKey: "github:acme/api",
            state: "excluded",
            origin: "person",
            rationale: "Ada ruled it out.",
            decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
            decidedAt: "2026-09-15T10:00:00.000Z",
          },
        ],
      },
    });
    expect((await readWorkScope(db, subjectKey))?.version).toBe(1);
  });
});
