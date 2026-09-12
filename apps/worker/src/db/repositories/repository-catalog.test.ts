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
  listClaimedRepositoriesNotEnabled,
  listRepositoriesWithProfiles,
  listRepositoryCatalogRows,
  listRepositoryProfileVersionRows,
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
    expect(second).toEqual({ id: first.id, version: 2 });

    const row = await getRepositoryCatalogRow(db, first.id);
    expect(row).toMatchObject({
      provider: "github",
      path: "acme/api",
      currentProfileVersion: 2,
      rules: "no force push, ever",
      source: "manual",
      enabled: true,
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
    const kept = await upsertRepositoryProfile(db, profile({ path: "acme/api" }));
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
    });

    const at = new Date("2026-09-12T09:00:00.000Z");
    const state = await activateRepositoryCatalog(db, { actorId: "user-1", now: at });
    expect(state).toEqual({ activated: true, activatedAt: at, activatedById: "user-1" });

    await activateRepositoryCatalog(db, { actorId: "user-2" });
    await expect(getRepositoryCatalogStateRow(db)).resolves.toMatchObject({
      activated: true,
      activatedById: "user-2",
    });
  });

  it("names a repository a live claim is working in that the catalog would stop selecting", async () => {
    const db = await createTestDb();
    const enabled = await upsertRepositoryProfile(db, profile({ path: "acme/api" }));
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

    await expect(listClaimedRepositoriesNotEnabled(db)).resolves.toEqual([
      "github:acme/unknown",
      "github:acme/web",
    ]);
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
    expect(current.repositoryVersions).toEqual({ "github:acme/api": 2 });
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
