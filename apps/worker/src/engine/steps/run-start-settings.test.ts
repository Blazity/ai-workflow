import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkScopeActor } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { writeManySettings } from "../../db/repositories/settings.js";
import {
  applyAnswerWorkScopePlan,
  applyRunWorkScopePlan,
} from "../../db/repositories/work-scope.js";
import {
  activateRepositoryCatalog,
  seedRepositoryCatalogEntries,
  setRepositoryEnabled,
} from "../../db/repositories/repository-catalog.js";
import { repositories } from "../../db/schema.js";

/**
 * The run-start step against a real database.
 *
 * pglite rather than a mocked repository, because the two things worth proving
 * are what the STORE answers: that stored settings resolve as one snapshot,
 * updates leave unrelated rows alone, and that the enabled-key list is
 * exactly the enabled rows, deduplicated, lowercased and sorted. A mock of the
 * repository would prove only that this file and that mock agree.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  loadRunStartSettingsStep,
  runStartHasNoEnabledRepository,
  runStartRepositoryAccess,
  runStartSettings,
  runStartWorkScope,
} = await import("./run-start-settings.js");

let db: Db;

/** What this deployment has stored, in miniature. */
function storedSettingsForDeployment() {
  return {
    MAX_CONCURRENT_AGENTS: 7,
    JOB_TIMEOUT_MS: 1_800_000,
    ATTACHMENT_MAX_COUNT: 20,
    COLUMN_AI: "AI",
  };
}

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  await writeManySettings(db, {
    patch: storedSettingsForDeployment(),
    actor: "test",
    reason: "seed run-start fixture",
  });
});

describe("loadRunStartSettingsStep", () => {
  it("resolves the snapshot from stored rows", async () => {
    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect(result.version).toBe(1);
    expect(result.settings.MAX_CONCURRENT_AGENTS).toBe(7);
    expect(result.settings.JOB_TIMEOUT_MS).toBe(1_800_000);
  });

  it("lets stored updates change those keys alone", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 2 },
      actor: "user_admin",
      reason: "tuning",
    });

    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect(result.settings.MAX_CONCURRENT_AGENTS).toBe(2);
    // Untouched stored keys keep their previous value.
    expect(result.settings.JOB_TIMEOUT_MS).toBe(1_800_000);
  });

  it("reports the bridge while the catalog is not activated", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "Acme/Api" }],
      source: "seeded",
      enabled: true,
    });

    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    // Not activated, so the list is carried but the predicate ignores it: the
    // bridge is a deployment that has never opened the Repositories page.
    expect(result.repositories?.activated).toBe(false);
    expect(runStartRepositoryAccess(result)).toEqual({
      activated: false,
      enabledKeys: ["github:acme/api"],
    });
  });

  it("carries only the enabled rows once the catalog is activated, keyed and sorted", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [
        { provider: "github", path: "Acme/Api" },
        { provider: "gitlab", path: "group/tool" },
        { provider: "github", path: "acme/web" },
      ],
      source: "seeded",
      enabled: true,
    });
    await activateRepositoryCatalog(db, { actorId: "user_admin", actorLabel: "Ada", reason: "the bridge is over" });
    const rows = await db.select().from(repositories);
    const web = rows.find((row) => row.path === "acme/web");
    await setRepositoryEnabled(db, { id: web!.id, enabled: false });

    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect(result.repositories).toEqual({
      activated: true,
      // Lowercased by the one key helper, sorted, and the disabled row absent.
      enabledKeys: ["github:acme/api", "gitlab:group/tool"],
    });
  });

  it("gives the same answer twice, and writes nothing, so a retry is safe", async () => {
    await activateRepositoryCatalog(db, { actorId: "user_admin", reason: "the bridge is over" });
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });

    const first = await loadRunStartSettingsStep({ workScopeSubjectKey: null });
    const second = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect(second).toEqual(first);
    expect(await db.select().from(repositories)).toHaveLength(1);
  });

  it("fills a key the stored snapshot predates with its registry default", () => {
    // A run suspended across a deploy that ADDS a registry key replays a
    // snapshot written without it. Read raw, that key is `undefined`, and the
    // run would carry undefined into whatever the key decides (a timeout, a
    // column name, a model) and fail somewhere far from here. The default is
    // what a deployment with nothing stored would have used, which makes it the
    // only honest filler.
    const stored = {
      settings: { MAX_CONCURRENT_AGENTS: 2 },
    } as Parameters<typeof runStartSettings>[0];

    const settings = runStartSettings(stored);

    // The stored value still wins where the snapshot has one.
    expect(settings.MAX_CONCURRENT_AGENTS).toBe(2);
    // And a key written after that snapshot answers, rather than being absent.
    expect(settings.COLUMN_AI).toBe("AI");
    expect(settings.JOB_TIMEOUT_MS).toBeTypeOf("number");
    expect(Object.keys(settings).length).toBeGreaterThan(10);
  });

  it("never lets current stored values into a replayed snapshot gap", async () => {
    // The deployment currently stores 7 concurrent agents. A resumed run whose
    // snapshot has no MAX_CONCURRENT_AGENTS must NOT pick that up: a value an
    // operator changed under a suspended run is exactly the drift the frozen
    // snapshot exists to prevent, so the gap is filled from the registry instead.
    const fresh = await loadRunStartSettingsStep({ workScopeSubjectKey: null });
    expect(fresh.settings.MAX_CONCURRENT_AGENTS).toBe(7);

    const stored = { settings: {} } as Parameters<typeof runStartSettings>[0];
    expect(runStartSettings(stored).MAX_CONCURRENT_AGENTS).not.toBe(7);
  });

  it("reads a stored result from before the repositories field as the bridge", () => {
    // The `repositoryVersions` precedent: a run suspended across a deploy
    // replays its STORED result, so an absent optional field must have a
    // defined meaning rather than throwing on resume.
    const stored = { settings: {} } as Parameters<typeof runStartRepositoryAccess>[0];

    expect(runStartRepositoryAccess(stored)).toEqual({
      activated: false,
      enabledKeys: [],
    });
  });
});

/**
 * D8 / row R04. A ticket moved into the AI column starts a run whatever the
 * catalog says, because a ticket trigger is not one of the four paths the
 * catalog decides dispatch on. Until stage F that run prepared a workspace
 * before finding out there was nothing it was allowed to touch.
 *
 * The predicate is pure and reads the FROZEN run-start result, so a run refuses
 * on the list it started with, exactly as every other repository decision in
 * the run does. `agentWorkflowBody` calls it right after the clarification
 * cleanup and exits through `runRetiredWorkflowFailureExit`, the AIW-254
 * transparent-failure path, with this message.
 */
describe("runStartHasNoEnabledRepository", () => {
  it("stops a run whose activated catalog enables nothing", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });
    await activateRepositoryCatalog(db, {
      actorId: "user_admin",
      reason: "the bridge is over",
    });
    const rows = await db.select().from(repositories);
    await setRepositoryEnabled(db, { id: rows[0]!.id, enabled: false });

    const stored = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect(runStartHasNoEnabledRepository(stored)).toBe(true);
  });

  it("lets a run through while one repository is still enabled", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });
    await activateRepositoryCatalog(db, {
      actorId: "user_admin",
      reason: "the bridge is over",
    });

    expect(runStartHasNoEnabledRepository(await loadRunStartSettingsStep({ workScopeSubjectKey: null }))).toBe(false);
  });

  it("lets a run through on the bridge, where the catalog decides nothing", async () => {
    // Not activated and nothing enabled is not an empty allowlist, it is a
    // deployment that has never opened the Repositories page: the agent sees
    // everything the installation exposes, which is what it did before the
    // catalog existed.
    const stored = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect(runStartRepositoryAccess(stored)).toEqual({ activated: false, enabledKeys: [] });
    expect(runStartHasNoEnabledRepository(stored)).toBe(false);
  });

  it("reads a stored result from before the repositories field as the bridge too", () => {
    const stored = { settings: {} } as Parameters<typeof runStartHasNoEnabledRepository>[0];
    expect(runStartHasNoEnabledRepository(stored)).toBe(false);
  });
});

/**
 * The work scope the run freezes, and the one thing it decides: nothing.
 *
 * The record is read here because the read is pure and belongs with the other
 * two, and because everything below must work off one frozen copy. What the
 * entries MEAN is decided later, where the repository listing exists.
 */
describe("the frozen work scope", () => {
  const runActor: WorkScopeActor = {
    kind: "run",
    runId: "run-1",
    definitionId: 4,
    definitionVersion: 7,
  };
  const subjectKey = "ticket:jira:AWT-1";

  it("carries the subject's entries", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: {
        upserts: [
          {
            entry: {
              repositoryKey: "github:acme/api",
              state: "selected",
              origin: "person",
              rationale: "Ada selected it on the ticket.",
              decidedBy: runActor,
              decidedAt: "2026-09-15T10:00:00.000Z",
            },
            replacesExpired: false,
          },
        ],
        deletes: [],
        trail: [],
      },
    });

    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: subjectKey });

    expect(result.workScope).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      scope: {
        subjectKey: "ticket:jira:AWT-1",
        version: 1,
        entries: [
          {
            repositoryKey: "github:acme/api",
            state: "selected",
            origin: "person",
            rationale: "Ada selected it on the ticket.",
            decidedBy: { kind: "run", runId: "run-1", definitionId: 4, definitionVersion: 7 },
            decidedAt: "2026-09-15T10:00:00.000Z",
          },
        ],
      },
      selectionAnswered: false,
      answeredRepositoryKeys: [],
      narrowingAnswered: false,
    });
  });

  it("carries the field with a null scope for a subject nobody has decided anything about", async () => {
    // Present and empty is not the same as absent: absent is a result stored
    // before this field existed, and puts the run on the whole old path.
    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: subjectKey });

    expect(result.workScope).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      scope: null,
      selectionAnswered: false,
      answeredRepositoryKeys: [],
      narrowingAnswered: false,
    });
    expect(runStartWorkScope(result)).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      scope: null,
      selectionAnswered: false,
      answeredRepositoryKeys: [],
      narrowingAnswered: false,
    });
  });

  it("says a selection question was already answered on the subject", async () => {
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
            // Named, because the question this stands for put the key in front
            // of a person: an ask whose question named nothing is not a
            // decision about the repository and never reaches this set.
            repositories: [
              { repositoryKey: "github:acme/api", askedBecause: "selection", named: true },
            ],
          },
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
            answeredBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
          },
        ],
      },
    });

    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: subjectKey });

    // The answer recorded no entry, which is exactly why the flag has to travel
    // beside them: without it the next run asks the same question again.
    expect(result.workScope).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      scope: null,
      selectionAnswered: true,
      // And beside the flag, WHICH repository that answer was about. The flag
      // alone cannot tell this repository's question from another's, so a run
      // holding only the flag would stop asking about every repository on this
      // subject the moment one of them was answered (A47).
      answeredRepositoryKeys: ["github:acme/api"],
      // And the narrowing question is a different question, untouched by this
      // answer. One fact, one read, one thing silenced.
      narrowingAnswered: false,
    });
  });

  it("says a narrowing question was already answered, without silencing anything else", async () => {
    // The question that asks somebody to cut a set down names none of the
    // repositories, so its ask is empty and nothing in the repositories it
    // carries can say which question it was. The purpose on the event is the
    // only record, and it must not reach `selectionAnswered`: that flag is
    // subject-wide, and folding this into it would stop the run asking about a
    // repository nobody ever showed this person.
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_asked",
            clarificationId: "clarification-narrow",
            repositories: [],
            purpose: "narrowing",
          },
        ],
      },
    });
    await applyAnswerWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      clarificationId: "clarification-narrow",
      plan: {
        upserts: [],
        deletes: [],
        trail: [
          {
            kind: "question_answered",
            clarificationId: "clarification-narrow",
            answer: { kind: "repositories", repositoryKeys: ["github:acme/api"] },
            answeredBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
          },
        ],
      },
    });

    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: subjectKey });

    expect(result.workScope).toEqual({
      subjectKey: "ticket:jira:AWT-1",
      scope: null,
      selectionAnswered: false,
      answeredRepositoryKeys: [],
      narrowingAnswered: true,
    });
  });

  it("reads nothing at all for a subject that carries no record", async () => {
    await applyRunWorkScopePlan(db, {
      subjectKey,
      runId: "run-1",
      plan: {
        upserts: [
          {
            entry: {
              repositoryKey: "github:acme/api",
              state: "selected",
              origin: "person",
              rationale: "Ada selected it on the ticket.",
              decidedBy: runActor,
              decidedAt: "2026-09-15T10:00:00.000Z",
            },
            replacesExpired: false,
          },
        ],
        deletes: [],
        trail: [],
      },
    });

    // A schedule occurrence and a subjectless delivery get a new subject key
    // every time, so there is nothing to read and nothing to carry.
    const result = await loadRunStartSettingsStep({ workScopeSubjectKey: null });

    expect("workScope" in result).toBe(false);
    expect(runStartWorkScope(result)).toBeNull();
  });

  it("reads a stored result from before the work scope field as no record read", () => {
    // The `repositories` precedent. A run suspended across this deploy replays
    // its STORED result, and an absent field must keep meaning what it means
    // today: the whole old path, with no scope and no default pretending one
    // was read.
    const stored = { settings: {} } as Parameters<typeof runStartWorkScope>[0];

    expect(runStartWorkScope(stored)).toBeNull();
  });
});

/**
 * This wave changes no repository decision.
 *
 * Every repository decision inside a run is made from the two values this step
 * already froze (`ctx.settings` and `ctx.repositories`, the run context rule in
 * apps/worker/AGENTS.md). So the proof that a record holding entries changes
 * nothing is that those two come out identical with the record and without it,
 * and that the refusal predicate built on them answers the same.
 */
describe("freezing a record decides nothing", () => {
  it("leaves the settings, the repository access and the refusal exactly as they were", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });
    await activateRepositoryCatalog(db, {
      actorId: "user_admin",
      reason: "the bridge is over",
    });
    await applyRunWorkScopePlan(db, {
      subjectKey: "ticket:jira:AWT-1",
      runId: "run-1",
      plan: {
        upserts: [
          {
            entry: {
              repositoryKey: "github:acme/web",
              state: "excluded",
              origin: "person",
              rationale: "Ada ruled it out.",
              decidedBy: { kind: "person", actorId: "user-1", actorLabel: "Ada" },
              decidedAt: "2026-09-15T10:00:00.000Z",
            },
            replacesExpired: false,
          },
        ],
        deletes: [],
        trail: [],
      },
    });

    const withoutRecord = await loadRunStartSettingsStep({ workScopeSubjectKey: null });
    const withRecord = await loadRunStartSettingsStep({
      workScopeSubjectKey: "ticket:jira:AWT-1",
    });

    expect(withRecord.workScope?.scope?.entries).toHaveLength(1);
    expect(runStartSettings(withRecord)).toEqual(runStartSettings(withoutRecord));
    expect(runStartRepositoryAccess(withRecord)).toEqual(
      runStartRepositoryAccess(withoutRecord),
    );
    expect(runStartHasNoEnabledRepository(withRecord)).toBe(
      runStartHasNoEnabledRepository(withoutRecord),
    );
  });
});
