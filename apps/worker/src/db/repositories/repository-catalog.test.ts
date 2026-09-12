import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "../test-db.js";
import {
  activeRuns,
  prePrCheckConfigVersions,
  repositories,
  repositoryProfileVersions,
  workflowOwnedBranches,
} from "../schema.js";
import {
  activateRepositoryCatalog,
  getCurrentCheckConfiguration,
  getRepositoryCatalogRow,
  getRepositoryCatalogRowByPath,
  getRepositoryCatalogStateRow,
  getRepositoryProfileVersionRow,
  getRepositoryWithProfileByPath,
  listClaimedRepositoriesNotEnabled,
  listRepositoriesWithProfiles,
  listRepositoryCatalogRows,
  listRepositoryProfileVersionRows,
  seedRepositoryCatalogEntries,
  setRepositoryEnabled,
  upsertRepositoryProfile,
  type UpsertRepositoryProfileInput,
} from "./repository-catalog.js";

function profile(
  overrides: Partial<UpsertRepositoryProfileInput> = {},
): UpsertRepositoryProfileInput {
  return {
    provider: "github",
    path: "acme/api",
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: {
      provider: "github",
      repoPath: "acme/api",
      groups: { test: { commands: ["pnpm test"] } },
    },
    gateGroups: null,
    actorId: "user-1",
    actorLabel: "Ada",
    reason: "",
    ...overrides,
  };
}

describe("repository catalog repository", () => {
  it("creates the row and its first version, then bumps both on the next save", async () => {
    const db = await createTestDb();

    const first = await upsertRepositoryProfile(db, profile({ rules: "no force push" }));
    expect(first.version).toBe(1);

    const second = await upsertRepositoryProfile(db, profile({ rules: "no force push, ever" }));
    // The profile moved, the checks did not: the script groups are the same
    // bytes, and no run in flight ran anything different because of this save.
    expect(second).toEqual({ id: first.id, version: 2, checksVersion: 1 });

    const row = await getRepositoryCatalogRow(db, first.id);
    expect(row).toMatchObject({
      provider: "github",
      path: "acme/api",
      currentProfileVersion: 2,
      currentChecksVersion: 1,
      rules: "no force push, ever",
      source: "manual",
      // Created by a profile save, so granted to nobody until somebody says so.
      enabled: false,
    });
    await expect(db.select().from(repositories)).resolves.toHaveLength(1);
    await expect(db.select().from(repositoryProfileVersions)).resolves.toHaveLength(2);
  });

  it("writes the repository row and its version row in one statement", async () => {
    const db = await createTestDb();
    const execute = vi.spyOn(db, "execute");
    try {
      await upsertRepositoryProfile(db, profile());
      expect(execute).toHaveBeenCalledTimes(1);
      await upsertRepositoryProfile(db, profile({ description: "second" }));
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      execute.mockRestore();
    }
    await expect(db.select().from(repositories)).resolves.toHaveLength(1);
    await expect(db.select().from(repositoryProfileVersions)).resolves.toHaveLength(2);
  });

  it("matches an existing repository whatever the casing of the path", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile({ path: "Acme/Api" }));
    const again = await upsertRepositoryProfile(db, profile({ path: "acme/api" }));

    expect(again.id).toBe(created.id);
    expect(again.version).toBe(2);
    await expect(db.select().from(repositories)).resolves.toHaveLength(1);
    await expect(
      getRepositoryCatalogRowByPath(db, { provider: "github", path: "ACME/API" }),
    ).resolves.toMatchObject({ id: created.id });
  });

  it("keeps the two providers apart", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(db, profile({ provider: "github" }));
    await upsertRepositoryProfile(db, profile({ provider: "gitlab" }));
    await expect(db.select().from(repositories)).resolves.toHaveLength(2);
    await expect(
      getRepositoryCatalogRowByPath(db, { provider: "gitlab", path: "acme/api" }),
    ).resolves.toMatchObject({ provider: "gitlab" });
  });

  it("lists every row, and only the enabled ones when asked", async () => {
    const db = await createTestDb();
    const kept = await upsertRepositoryProfile(
      db,
      profile({ path: "acme/api", enabled: true }),
    );
    const dropped = await upsertRepositoryProfile(db, profile({ path: "acme/web" }));
    await setRepositoryEnabled(db, { id: dropped.id, enabled: false });

    await expect(listRepositoryCatalogRows(db)).resolves.toHaveLength(2);
    const enabled = await listRepositoryCatalogRows(db, { enabledOnly: true });
    expect(enabled.map((row) => row.id)).toEqual([kept.id]);
  });

  it("does not mint a profile version when a repository is only switched off", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile());
    const disabled = await setRepositoryEnabled(db, { id: created.id, enabled: false });

    expect(disabled).toMatchObject({ enabled: false, currentProfileVersion: 1 });
    await expect(db.select().from(repositoryProfileVersions)).resolves.toHaveLength(1);
  });

  it("lists a repository's versions newest first", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile({ reason: "first" }));
    await upsertRepositoryProfile(db, profile({ reason: "second" }));

    const versions = await listRepositoryProfileVersionRows(db, created.id);
    expect(versions.map((row) => row.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ reason: "second", actorLabel: "Ada" });
  });

  it("reads one profile version by its key, and the pair by path", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile({ rules: "first" }));
    await upsertRepositoryProfile(db, profile({ rules: "second" }));

    await expect(
      getRepositoryProfileVersionRow(db, created.id, 1),
    ).resolves.toMatchObject({ version: 1, rules: "first" });
    await expect(getRepositoryProfileVersionRow(db, created.id, 9)).resolves.toBeNull();

    // Case insensitive on the path, like every other lookup that decides which
    // repository a caller means.
    const found = await getRepositoryWithProfileByPath(db, {
      provider: "github",
      path: "ACME/API",
    });
    expect(found?.repository.id).toBe(created.id);
    expect(found?.profile).toMatchObject({ version: 2, rules: "second" });
    await expect(
      getRepositoryWithProfileByPath(db, { provider: "gitlab", path: "acme/api" }),
    ).resolves.toBeNull();
  });

  it("answers with a null profile for a row nobody has configured", async () => {
    const db = await createTestDb();
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });
    const found = await getRepositoryWithProfileByPath(db, {
      provider: "github",
      path: "acme/api",
    });
    expect(found?.repository.currentProfileVersion).toBe(0);
    expect(found?.profile).toBeNull();
  });

  it("resolves each repository to its current profile version", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(db, profile({ path: "acme/api" }));
    await upsertRepositoryProfile(db, profile({ path: "acme/api", description: "newer" }));
    await upsertRepositoryProfile(db, profile({ path: "acme/web", scriptGroups: null }));

    const rows = await listRepositoriesWithProfiles(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.profile).toMatchObject({ version: 2, description: "newer" });
    expect(rows[1]?.profile).toMatchObject({ version: 1, scriptGroups: null });
  });

  it("reports the bridge until somebody activates the catalog", async () => {
    const db = await createTestDb();
    await expect(getRepositoryCatalogStateRow(db)).resolves.toEqual({
      activated: false,
      activatedAt: null,
      activatedById: null,
      activatedByLabel: null,
    });

    const at = new Date("2026-09-12T09:00:00.000Z");
    const state = await activateRepositoryCatalog(db, {
      actorId: "user-1",
      actorLabel: "Ada",
      now: at,
    });
    expect(state).toEqual({
      activated: true,
      activatedAt: at,
      activatedById: "user-1",
      activatedByLabel: "Ada",
    });

    await activateRepositoryCatalog(db, { actorId: "user-2" });
    await expect(getRepositoryCatalogStateRow(db)).resolves.toMatchObject({
      activated: true,
      activatedById: "user-2",
    });
  });

  it("names a repository a live claim is working in that the catalog would stop selecting", async () => {
    const db = await createTestDb();
    const enabled = await upsertRepositoryProfile(
      db,
      profile({ path: "acme/api", enabled: true }),
    );
    const disabled = await upsertRepositoryProfile(db, profile({ path: "acme/web" }));
    await setRepositoryEnabled(db, { id: disabled.id, enabled: false });
    expect(enabled.version).toBe(1);

    await db.insert(activeRuns).values({
      subjectKey: "jira:AIW-1",
      ticketKey: "AIW-1",
      ownerToken: "token-1",
      runId: "run-1",
      state: "bound",
    });
    await db.insert(workflowOwnedBranches).values([
      {
        ticketKey: "AIW-1",
        provider: "github",
        repoPath: "acme/api",
        branchName: "ai/AIW-1",
      },
      {
        ticketKey: "AIW-1",
        provider: "github",
        repoPath: "acme/web",
        branchName: "ai/AIW-1",
      },
      {
        ticketKey: "AIW-1",
        provider: "github",
        repoPath: "acme/unknown",
        branchName: "ai/AIW-1",
      },
    ]);

    // Named with the tickets and runs it was found through, because the join is
    // on the ticket and cannot prove the live run is the one that made the
    // branch: an admin has to be able to go and look.
    await expect(listClaimedRepositoriesNotEnabled(db)).resolves.toEqual([
      {
        key: "github:acme/unknown",
        displayName: "acme/unknown",
        ticketKeys: ["AIW-1"],
        runIds: ["run-1"],
      },
      {
        key: "github:acme/web",
        displayName: "acme/web",
        ticketKeys: ["AIW-1"],
        runIds: ["run-1"],
      },
    ]);
  });
});

describe("what a profile save may and may not overwrite", () => {
  it("carries a catalog-authored description, rules and relationships through a save that omits them", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(
      db,
      profile({
        description: "The public API",
        rules: "never force push",
        relationships: [{ repositoryId: 7, label: "consumes" }],
      }),
    );

    // Exactly what the legacy repository-scripts fan-out sends: the script
    // groups it owns, and not one field it does not.
    await upsertRepositoryProfile(db, {
      provider: "github",
      path: "acme/api",
      scriptGroups: { provider: "github", repoPath: "acme/api", groups: { lint: {} } },
      gateGroups: null,
      actorId: "user-2",
      actorLabel: "Legacy screen",
      reason: "repository scripts save",
    });

    const row = await getRepositoryCatalogRow(db, created.id);
    expect(row).toMatchObject({
      description: "The public API",
      rules: "never force push",
      relationships: [{ repositoryId: 7, label: "consumes" }],
    });
    const versions = await listRepositoryProfileVersionRows(db, created.id);
    expect(versions[0]).toMatchObject({
      version: 2,
      description: "The public API",
      rules: "never force push",
    });
  });

  it("still lets a save clear a field on purpose", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile({ rules: "no force push" }));
    await upsertRepositoryProfile(db, profile({ rules: "" }));
    await expect(getRepositoryCatalogRow(db, created.id)).resolves.toMatchObject({
      rules: "",
    });
  });

  it("creates a repository switched off, and never grants one that already exists", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile());
    await expect(getRepositoryCatalogRow(db, created.id)).resolves.toMatchObject({
      enabled: false,
    });

    await setRepositoryEnabled(db, { id: created.id, enabled: true });
    await upsertRepositoryProfile(db, profile({ description: "again", enabled: false }));
    // The flag decides creation only: a later save must not revoke a grant an
    // operator made, any more than it may hand one out.
    await expect(getRepositoryCatalogRow(db, created.id)).resolves.toMatchObject({
      enabled: true,
    });
  });

  it("creates an enabled repository when the caller says so", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(db, profile({ enabled: true }));
    await expect(getRepositoryCatalogRow(db, created.id)).resolves.toMatchObject({
      enabled: true,
    });
  });
});

describe("the checks version", () => {
  it("stands still while only the authored fields move", async () => {
    const db = await createTestDb();
    const first = await upsertRepositoryProfile(db, profile());
    expect(first.checksVersion).toBe(1);

    const second = await upsertRepositoryProfile(db, profile({ description: "edited" }));
    expect(second).toMatchObject({ version: 2, checksVersion: 1 });

    const third = await upsertRepositoryProfile(db, profile({ rules: "be careful" }));
    expect(third).toMatchObject({ version: 3, checksVersion: 1 });
  });

  it("moves when a command changes, and when the gate selection changes", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(db, profile());
    const edited = await upsertRepositoryProfile(
      db,
      profile({
        scriptGroups: {
          provider: "github",
          repoPath: "acme/api",
          groups: { test: { commands: ["pnpm test --run"] } },
        },
      }),
    );
    expect(edited.checksVersion).toBe(2);

    const gated = await upsertRepositoryProfile(
      db,
      profile({
        scriptGroups: {
          provider: "github",
          repoPath: "acme/api",
          groups: { test: { commands: ["pnpm test --run"] } },
        },
        gateGroups: ["test"],
      }),
    );
    expect(gated.checksVersion).toBe(3);
  });

  it("moves when a repository's script groups are dropped altogether", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(db, profile());
    const dropped = await upsertRepositoryProfile(db, profile({ scriptGroups: null }));
    expect(dropped.checksVersion).toBe(2);
  });

  it("is 0 for a repository whose first profile configures no checks", async () => {
    const db = await createTestDb();
    const created = await upsertRepositoryProfile(
      db,
      profile({ scriptGroups: null, gateGroups: null }),
    );
    expect(created.checksVersion).toBe(0);
    await expect(getRepositoryCatalogRow(db, created.id)).resolves.toMatchObject({
      currentChecksVersion: 0,
    });
  });
});

describe("getCurrentCheckConfiguration", () => {
  it("is empty and versionless on a deployment that configured nothing", async () => {
    const db = await createTestDb();
    await expect(getCurrentCheckConfiguration(db)).resolves.toEqual({
      version: null,
      config: { repositories: [] },
      repositoryVersions: {},
      changedAt: null,
      changedById: null,
      changedByLabel: null,
    });
  });

  it("composes one entry per repository that has script groups", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(db, profile({ path: "acme/api" }));
    await upsertRepositoryProfile(db, profile({ path: "acme/api", description: "v2" }));
    await upsertRepositoryProfile(db, profile({ path: "acme/web", scriptGroups: null }));

    const current = await getCurrentCheckConfiguration(db);
    expect(current.config.repositories).toEqual([
      {
        provider: "github",
        repoPath: "acme/api",
        groups: { test: { commands: ["pnpm test"] } },
      },
    ]);
    // The checks version, not the profile version: the second save changed the
    // description and nothing a check executes.
    expect(current.repositoryVersions).toEqual({ "github:acme/api": 1 });
    expect(current.version).toBe(1);
  });

  it("carries the gate group selection when the profile declares one", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(db, profile({ gateGroups: ["test"] }));
    const current = await getCurrentCheckConfiguration(db);
    expect(current.config.repositories[0]).toMatchObject({ gateGroups: ["test"] });
  });

  it("makes the stored provider and path win over the profile's own copy", async () => {
    const db = await createTestDb();
    await upsertRepositoryProfile(
      db,
      profile({
        path: "Acme/Api",
        scriptGroups: {
          provider: "gitlab",
          repoPath: "someone/else",
          groups: { test: { commands: ["pnpm test"] } },
        },
      }),
    );
    const current = await getCurrentCheckConfiguration(db);
    expect(current.config.repositories[0]).toMatchObject({
      provider: "github",
      repoPath: "Acme/Api",
    });
    expect(current.repositoryVersions).toEqual({ "github:acme/api": 1 });
  });

  it("keeps the legacy global counter and the deployment-wide batch timeout", async () => {
    const db = await createTestDb();
    await db.insert(prePrCheckConfigVersions).values({
      // The stored row type predates batchTimeoutMinutes; the column is jsonb
      // and the engine has always read the field off it, so the assertion is
      // about the bytes rather than about the declaration.
      config: { repositories: [], batchTimeoutMinutes: 45 } as unknown as {
        repositories: [];
      },
      createdById: "user-1",
      createdByLabel: "Ada",
      restoredFromVersion: null,
    });
    await upsertRepositoryProfile(db, profile());

    const current = await getCurrentCheckConfiguration(db);
    expect(current.version).toBe(1);
    expect(current.config.batchTimeoutMinutes).toBe(45);
  });
});
