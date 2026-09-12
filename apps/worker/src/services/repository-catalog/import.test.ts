import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoriesResponse } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  directory: undefined as unknown as RepositoriesResponse,
  env: {} as Record<string, string>,
}));

// The role check lives beside the profile save, which reaches the settings
// cluster and through it the environment schema. Stubbed the way every other
// worker test that touches a service stubs it.
vi.mock("../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => [],
  getVcsProviderConfig: () => undefined,
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../repository-discovery/index.js", () => ({
  listCachedRepositoryDirectory: vi.fn(async () => state.directory),
}));

const { commitRepositoryImport, previewRepositoryImport } = await import("./import.js");
const { upsertRepositoryProfile } = await import(
  "../../db/repositories/repository-catalog.js"
);
const { loadRepositoryCatalogSnapshot } = await import("./store.js");

const ADMIN = { role: "admin" as const, id: "user_admin" };
const MEMBER = { role: "member" as const, id: "user_member" };

function option(repoPath: string, provider: "github" | "gitlab" = "github") {
  const [owner, name] = repoPath.split("/");
  return {
    provider,
    repoPath,
    name: name ?? repoPath,
    owner: owner ?? "",
    defaultBranch: "main",
    private: true,
    archived: false,
  };
}

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
  state.directory = {
    repositories: [option("Acme/Api"), option("acme/web"), option("acme/ops", "gitlab")],
    providers: [
      { provider: "github", status: "ready" },
      { provider: "gitlab", status: "ready" },
    ],
  };
});

describe("previewRepositoryImport", () => {
  it("marks what the catalog already holds, matching case insensitively", async () => {
    await upsertRepositoryProfile(db, {
      provider: "github",
      path: "acme/api",
      description: "",
      rules: "",
      relationships: [],
      scriptGroups: null,
      gateGroups: null,
      actorId: "user_admin",
      actorLabel: "Admin",
      reason: "",
    });

    const preview = await previewRepositoryImport();

    expect(preview.repositories).toEqual([
      expect.objectContaining({ key: "github:acme/api", path: "Acme/Api", inCatalog: true }),
      expect.objectContaining({ key: "github:acme/web", path: "acme/web", inCatalog: false }),
      expect.objectContaining({ key: "gitlab:acme/ops", path: "acme/ops", inCatalog: false }),
    ]);
    expect(preview.providers).toEqual(state.directory.providers);
  });
});

describe("commitRepositoryImport", () => {
  it("creates the selected rows switched off, with the provider's own casing", async () => {
    const result = await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/api", "gitlab:acme/ops"], enabled: false },
    });

    expect(result.imported).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(
      result.repositories.map((entry) => [
        entry.provider,
        entry.path,
        entry.enabled,
        entry.source,
        entry.profileVersion,
      ]),
    ).toEqual([
      ["github", "Acme/Api", false, "imported", 0],
      ["gitlab", "acme/ops", false, "imported", 0],
    ]);
  });

  it("grants access when the admin asked for it, and only then", async () => {
    await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/web"], enabled: true },
    });

    const snapshot = await loadRepositoryCatalogSnapshot();
    expect(snapshot.entries.map((entry) => [entry.path, entry.enabled])).toEqual([
      ["acme/web", true],
    ]);
  });

  it("echoes back a key the installation does not expose instead of inventing a row", async () => {
    const result = await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/api", "github:ghost/repo"], enabled: false },
    });

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual(["github:ghost/repo"]);
    expect(result.alreadyPresent).toEqual([]);
    expect(result.repositories.map((entry) => entry.path)).toEqual(["Acme/Api"]);
  });

  it("separates a key the catalog already holds from one the provider lost", async () => {
    await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/api"], enabled: false },
    });

    const second = await commitRepositoryImport({
      actor: ADMIN,
      request: {
        repositoryKeys: ["github:acme/api", "github:acme/web", "github:ghost/repo"],
        enabled: false,
      },
    });

    expect(second.imported).toBe(1);
    expect(second.alreadyPresent).toEqual(["github:acme/api"]);
    expect(second.skipped).toEqual(["github:ghost/repo"]);
  });

  it("refuses the whole call when a provider owning a selected key could not be listed", async () => {
    state.directory = {
      repositories: [option("acme/web")],
      providers: [
        { provider: "github", status: "ready" },
        { provider: "gitlab", status: "error", error: "401 from GitLab" },
      ],
    };

    await expect(
      commitRepositoryImport({
        actor: ADMIN,
        request: {
          repositoryKeys: ["github:acme/web", "gitlab:acme/ops"],
          enabled: false,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    // Nothing was written: a partial import against a provider nobody could
    // list is worse than no import at all.
    const snapshot = await loadRepositoryCatalogSnapshot();
    expect(snapshot.entries).toEqual([]);
  });

  it("still imports when the provider that failed owns none of the selected keys", async () => {
    state.directory = {
      repositories: [option("acme/web")],
      providers: [
        { provider: "github", status: "ready" },
        { provider: "gitlab", status: "error", error: "401 from GitLab" },
      ],
    };

    const result = await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/web"], enabled: false },
    });

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("imports the same selection twice without duplicating or re-enabling a row", async () => {
    await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/api"], enabled: true },
    });
    const { setRepositoryEnabled, getRepositoryCatalogRowByPath } = await import(
      "../../db/repositories/repository-catalog.js"
    );
    const row = await getRepositoryCatalogRowByPath(db, {
      provider: "github",
      path: "acme/api",
    });
    await setRepositoryEnabled(db, { id: row!.id, enabled: false });

    const second = await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/api"], enabled: true },
    });

    expect(second.imported).toBe(0);
    expect(second.repositories).toHaveLength(1);
    expect(second.repositories[0]?.enabled).toBe(false);
  });

  it("gives a member 403 and writes nothing", async () => {
    await expect(
      commitRepositoryImport({
        actor: MEMBER,
        request: { repositoryKeys: ["github:acme/api"], enabled: true },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const snapshot = await loadRepositoryCatalogSnapshot();
    expect(snapshot.entries).toEqual([]);
  });
});
