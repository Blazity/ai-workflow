import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

// The predicate is pure, but what it is asked about is not: these cases load a
// real snapshot out of a pglite catalog, because the thing worth proving is that
// the store and the predicate agree about what "enabled" means.
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
// The catalog's cluster index reaches the dashboard actor lookup, which reaches
// the validated environment on import; nothing here needs either.
vi.mock("../../infra/vcs-config.js", () => ({
  env: {},
  getConfiguredVcsProviders: () => [],
}));

const { activateRepositoryCatalog, setRepositoryEnabled, upsertRepositoryProfile } =
  await import("../../db/repositories/repository-catalog.js");
const { loadRepositoryCatalogSnapshot } = await import(
  "../repository-catalog/index.js"
);
const { isRepositoryDispatchable, REPOSITORY_NOT_IN_CATALOG_REASON } = await import(
  "./repo-allowlist.js"
);

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
});

async function addRepository(
  provider: "github" | "gitlab",
  path: string,
  enabled: boolean,
): Promise<void> {
  const saved = await upsertRepositoryProfile(db, {
    provider,
    path,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: { provider, repoPath: path, groups: {} },
    gateGroups: null,
    actorId: "user-1",
    actorLabel: "Ada",
    reason: "",
    enabled,
  });
  if (!enabled) await setRepositoryEnabled(db, { id: saved.id, enabled: false });
}

describe("isRepositoryDispatchable", () => {
  it("passes every repository while the catalog is not activated", async () => {
    await addRepository("github", "acme/api", true);
    await addRepository("github", "acme/web", false);

    const snapshot = await loadRepositoryCatalogSnapshot();

    expect(snapshot.activated).toBe(false);
    expect(
      isRepositoryDispatchable(snapshot, { provider: "github", path: "acme/web" }),
    ).toBe(true);
    expect(
      isRepositoryDispatchable(snapshot, { provider: "gitlab", path: "never/heard-of-it" }),
    ).toBe(true);
  });

  it("lets only the enabled rows through once the catalog is activated", async () => {
    await addRepository("github", "Acme/Api", true);
    await addRepository("github", "acme/web", false);
    await addRepository("gitlab", "group/team/tool", true);
    await activateRepositoryCatalog(db, { actorId: "user-1", reason: "the bridge is over" });

    const snapshot = await loadRepositoryCatalogSnapshot();

    expect(
      isRepositoryDispatchable(snapshot, { provider: "github", path: "acme/API" }),
    ).toBe(true);
    expect(
      isRepositoryDispatchable(snapshot, { provider: "github", path: "acme/web" }),
    ).toBe(false);
    expect(
      isRepositoryDispatchable(snapshot, { provider: "gitlab", path: "group/team/tool" }),
    ).toBe(true);
    expect(
      isRepositoryDispatchable(snapshot, { provider: "github", path: "never/heard-of-it" }),
    ).toBe(false);
  });

  it("does not let an enabled row on one provider authorize the same path on another", async () => {
    await addRepository("gitlab", "group/tool", true);
    await activateRepositoryCatalog(db, { actorId: "user-1", reason: "the bridge is over" });

    const snapshot = await loadRepositoryCatalogSnapshot();

    expect(
      isRepositoryDispatchable(snapshot, { provider: "gitlab", path: "group/tool" }),
    ).toBe(true);
    expect(
      isRepositoryDispatchable(snapshot, { provider: "github", path: "group/tool" }),
    ).toBe(false);
  });

  // What a refused caller reads. It names the thing an operator can act on: the
  // catalog and the page that edits it, never an environment variable.
  it("names the catalog in the refusal", () => {
    expect(REPOSITORY_NOT_IN_CATALOG_REASON).toContain("repository catalog");
    expect(REPOSITORY_NOT_IN_CATALOG_REASON).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });
});
