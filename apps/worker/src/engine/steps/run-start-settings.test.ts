import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { writeManySettings } from "../../db/repositories/settings.js";
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
} = await import("./run-start-settings.js");

let db: Db;

/** What this deployment has stored, in miniature. */
function storedSettingsForDeployment() {
  return {
    MAX_CONCURRENT_AGENTS: 7,
    JOB_TIMEOUT_MS: 1_800_000,
    AGENT_KIND: "codex",
    CODEX_MODEL: "gpt-5.6-codex",
    ENABLE_REVIEW_PHASE: true,
    ENABLE_LEAK_REVIEW: false,
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
    const result = await loadRunStartSettingsStep();

    expect(result.version).toBe(1);
    expect(result.settings.MAX_CONCURRENT_AGENTS).toBe(7);
    expect(result.settings.AGENT_KIND).toBe("codex");
    expect(result.settings.JOB_TIMEOUT_MS).toBe(1_800_000);
    // Unset in the store, so the registry default stands.
    expect(result.settings.CLAUDE_MODEL).toBeNull();
  });

  it("lets stored updates change those keys alone", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 2, AGENT_KIND: "claude" },
      actor: "user_admin",
      reason: "tuning",
    });

    const result = await loadRunStartSettingsStep();

    expect(result.settings.MAX_CONCURRENT_AGENTS).toBe(2);
    expect(result.settings.AGENT_KIND).toBe("claude");
    // Untouched stored keys keep their previous value.
    expect(result.settings.JOB_TIMEOUT_MS).toBe(1_800_000);
  });

  it("reports the bridge while the catalog is not activated", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "Acme/Api" }],
      source: "seeded",
      enabled: true,
    });

    const result = await loadRunStartSettingsStep();

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

    const result = await loadRunStartSettingsStep();

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

    const first = await loadRunStartSettingsStep();
    const second = await loadRunStartSettingsStep();

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
    const fresh = await loadRunStartSettingsStep();
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

    const stored = await loadRunStartSettingsStep();

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

    expect(runStartHasNoEnabledRepository(await loadRunStartSettingsStep())).toBe(false);
  });

  it("lets a run through on the bridge, where the catalog decides nothing", async () => {
    // Not activated and nothing enabled is not an empty allowlist, it is a
    // deployment that has never opened the Repositories page: the agent sees
    // everything the installation exposes, which is what it did before the
    // catalog existed.
    const stored = await loadRunStartSettingsStep();

    expect(runStartRepositoryAccess(stored)).toEqual({ activated: false, enabledKeys: [] });
    expect(runStartHasNoEnabledRepository(stored)).toBe(false);
  });

  it("reads a stored result from before the repositories field as the bridge too", () => {
    const stored = { settings: {} } as Parameters<typeof runStartHasNoEnabledRepository>[0];
    expect(runStartHasNoEnabledRepository(stored)).toBe(false);
  });
});
