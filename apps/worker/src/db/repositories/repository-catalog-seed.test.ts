import { describe, expect, it } from "vitest";
import { createTestDb } from "../test-db.js";
import {
  prePrCheckConfigVersions,
  repositories,
  repositoryProfileVersions,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../schema.js";
import {
  getCurrentCheckConfiguration,
  getRepositoryCatalogStateRow,
  listPinnedRepositoriesFromDefinitions,
  listRepositoriesWithProfiles,
  migrateScriptGroupsIntoProfiles,
  seedRepositoryCatalogEntries,
  seedRepositoryCatalogState,
} from "./repository-catalog.js";
import type { Db } from "../types.js";

const BLOB = {
  repositories: [
    {
      provider: "github",
      repoPath: "Acme/Api",
      groups: { test: { commands: ["pnpm test"] } },
      gateGroups: ["test"],
    },
    {
      provider: "gitlab",
      repoPath: "acme/web",
      commands: ["pnpm lint"],
    },
  ],
  batchTimeoutMinutes: 30,
};

async function storeBlob(db: Db): Promise<void> {
  await db.insert(prePrCheckConfigVersions).values({
    config: BLOB as unknown as { repositories: [] },
    createdById: "user-1",
    createdByLabel: "Ada",
    restoredFromVersion: null,
  });
}

async function pinRepository(db: Db, pinned: unknown): Promise<void> {
  const [definition] = await db
    .insert(workflowDefinitions)
    .values({ name: "pinned fixture", createdById: "user-1", createdByLabel: "Ada" })
    .returning();
  await db.insert(workflowDefinitionVersions).values({
    definitionId: definition!.id,
    version: 1,
    definition: { repositoryScope: { repositories: pinned } },
    createdById: "user-1",
    createdByLabel: "Ada",
  });
}

describe("catalog seed", () => {
  it("reads the repositories every stored definition version pins", async () => {
    const db = await createTestDb();
    await pinRepository(db, [
      { provider: "github", repoPath: "acme/api" },
      { provider: "gitlab", repoPath: " acme/web " },
      { provider: "bitbucket", repoPath: "acme/nope" },
      { provider: "github", repoPath: "  " },
    ]);

    await expect(listPinnedRepositoriesFromDefinitions(db)).resolves.toEqual([
      { provider: "github", path: "acme/api" },
      { provider: "gitlab", path: "acme/web" },
    ]);
  });

  it("creates one enabled row per granted repository and is a no-op the second time", async () => {
    const db = await createTestDb();
    const granted = [
      { provider: "github", path: "acme/api" },
      { provider: "github", path: "acme/web" },
    ];

    await expect(
      seedRepositoryCatalogEntries(db, {
        repositories: granted,
        source: "seeded",
        enabled: true,
      }),
    ).resolves.toBe(2);
    await expect(
      seedRepositoryCatalogEntries(db, {
        repositories: granted,
        source: "seeded",
        enabled: true,
      }),
    ).resolves.toBe(0);

    const rows = await db.select().from(repositories);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "seeded",
      enabled: true,
      currentProfileVersion: 0,
    });
  });

  it("does not duplicate a row that differs only in casing", async () => {
    const db = await createTestDb();
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "Acme/Api" }],
      source: "seeded",
      enabled: true,
    });
    await expect(
      seedRepositoryCatalogEntries(db, {
        repositories: [{ provider: "github", path: "acme/api" }],
        source: "seeded",
        enabled: true,
      }),
    ).resolves.toBe(0);
    await expect(db.select().from(repositories)).resolves.toHaveLength(1);
  });

  it("collapses one allowlist spelling and one pin spelling into a single row", async () => {
    const db = await createTestDb();
    // The exact overlap the build hits: AGENT_ALLOWED_REPOS says `Acme/Api`,
    // a stored definition pins `acme/api`, and they are one repository.
    await expect(
      seedRepositoryCatalogEntries(db, {
        repositories: [
          { provider: "github", path: "Acme/Api" },
          { provider: "github", path: "acme/api" },
        ],
        source: "seeded",
        enabled: true,
      }),
    ).resolves.toBe(1);
    const rows = await db.select().from(repositories);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "Acme/Api", enabled: true });
  });

  it("writes the state row once and never re-decides activation", async () => {
    const db = await createTestDb();
    await expect(
      seedRepositoryCatalogState(db, { activated: true }),
    ).resolves.toMatchObject({
      activated: true,
      // Named so a later screen can offer a review of an activation nobody
      // clicked, rather than presenting it as somebody's decision.
      activatedById: "seed",
      activatedByLabel: "seeded from AGENT_ALLOWED_REPOS",
    });
    await expect(
      seedRepositoryCatalogState(db, { activated: false }),
    ).resolves.toMatchObject({ activated: true });
    await expect(getRepositoryCatalogStateRow(db)).resolves.toMatchObject({
      activated: true,
    });
  });

  it("leaves an unrestricted deployment on the bridge", async () => {
    const db = await createTestDb();
    await expect(
      seedRepositoryCatalogState(db, { activated: false }),
    ).resolves.toMatchObject({ activated: false, activatedAt: null });
  });
});

describe("script groups migration", () => {
  it("creates one disabled row and one version 1 profile per repository the blob names", async () => {
    const db = await createTestDb();
    await storeBlob(db);

    await expect(migrateScriptGroupsIntoProfiles(db)).resolves.toEqual({
      repositoriesCreated: 2,
      profilesCreated: 2,
    });

    const rows = await listRepositoriesWithProfiles(db);
    expect(rows.map((row) => [row.repository.path, row.repository.enabled])).toEqual([
      ["Acme/Api", false],
      ["acme/web", false],
    ]);
    expect(rows[0]?.repository).toMatchObject({
      source: "migrated",
      currentProfileVersion: 1,
    });
    expect(rows[0]?.profile).toMatchObject({
      version: 1,
      actorId: "migration",
      actorLabel: "migration",
      reason: "script groups migration from pre_pr_check_config_versions",
      gateGroups: ["test"],
    });
    // The legacy flat entry keeps its bytes: normalization stays at the engine
    // boundary, which is where it has always been.
    expect(rows[1]?.profile?.scriptGroups).toEqual({
      provider: "gitlab",
      repoPath: "acme/web",
      commands: ["pnpm lint"],
    });
    expect(rows[1]?.profile?.gateGroups).toBe(null);
  });

  it("runs twice without creating a second row or a second version", async () => {
    const db = await createTestDb();
    await storeBlob(db);
    await migrateScriptGroupsIntoProfiles(db);

    await expect(migrateScriptGroupsIntoProfiles(db)).resolves.toEqual({
      repositoriesCreated: 0,
      profilesCreated: 0,
    });
    await expect(db.select().from(repositories)).resolves.toHaveLength(2);
    await expect(db.select().from(repositoryProfileVersions)).resolves.toHaveLength(2);
  });

  it("keeps a repository the allowlist already enabled enabled, and gives it the profile", async () => {
    const db = await createTestDb();
    await storeBlob(db);
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });

    await expect(migrateScriptGroupsIntoProfiles(db)).resolves.toEqual({
      repositoriesCreated: 1,
      profilesCreated: 2,
    });
    const rows = await listRepositoriesWithProfiles(db);
    expect(rows.map((row) => [row.repository.path, row.repository.enabled])).toEqual([
      ["acme/api", true],
      ["acme/web", false],
    ]);
    expect(rows[0]?.repository.source).toBe("seeded");
    expect(rows[0]?.profile?.version).toBe(1);
  });

  it("hands the migrated profiles straight to the run's check configuration", async () => {
    const db = await createTestDb();
    await storeBlob(db);
    await migrateScriptGroupsIntoProfiles(db);

    const current = await getCurrentCheckConfiguration(db);
    expect(current.version).toBe(1);
    expect(current.config.batchTimeoutMinutes).toBe(30);
    expect(current.config.repositories).toHaveLength(2);
    expect(current.repositoryVersions).toEqual({
      "github:acme/api": 1,
      "gitlab:acme/web": 1,
    });
  });

  it("does nothing at all when no configuration was ever stored", async () => {
    const db = await createTestDb();
    await expect(migrateScriptGroupsIntoProfiles(db)).resolves.toEqual({
      repositoriesCreated: 0,
      profilesCreated: 0,
    });
  });
});
