import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));

const {
  activateRepositoryCatalog,
  upsertRepositoryProfile,
  setRepositoryEnabled,
} = await import("../../db/repositories/repository-catalog.js");
const { loadRepositoryCatalogSnapshot } = await import("./store.js");
const { isRepositoryEnabled, reportBridge } = await import("./policy.js");
const { getCurrentRepositoryProfile, listRepositoryProfileVersions } = await import(
  "./versions.js"
);

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
  state.db = db;
});

async function addRepository(path: string, enabled: boolean): Promise<number> {
  const saved = await upsertRepositoryProfile(db, {
    provider: "github",
    path,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: { provider: "github", repoPath: path, groups: {} },
    gateGroups: null,
    actorId: "user-1",
    actorLabel: "Ada",
    reason: "",
    enabled,
  });
  if (!enabled) await setRepositoryEnabled(db, { id: saved.id, enabled: false });
  return saved.id;
}

describe("loadRepositoryCatalogSnapshot", () => {
  it("reports the bridge and passes everything on a deployment that never activated", async () => {
    await addRepository("acme/api", true);
    await addRepository("acme/web", false);

    const snapshot = await loadRepositoryCatalogSnapshot();
    expect(snapshot.activated).toBe(false);
    expect(snapshot.state.bridge).toBe(true);
    expect(reportBridge(snapshot).bridge).toBe(true);
    expect(isRepositoryEnabled(snapshot, "github:acme/web")).toBe(true);
    expect(isRepositoryEnabled(snapshot, "github:never/heard-of-it")).toBe(true);
  });

  it("lets the enabled list decide once the catalog is activated", async () => {
    await addRepository("Acme/Api", true);
    await addRepository("acme/web", false);
    await activateRepositoryCatalog(db, { actorId: "user-1" });

    const snapshot = await loadRepositoryCatalogSnapshot();
    expect(snapshot.activated).toBe(true);
    expect(snapshot.state.bridge).toBe(false);
    expect(isRepositoryEnabled(snapshot, "github:acme/api")).toBe(true);
    expect(isRepositoryEnabled(snapshot, "github:acme/web")).toBe(false);
    expect(isRepositoryEnabled(snapshot, "github:never/heard-of-it")).toBe(false);
  });

  it("carries every row, disabled ones included, so the list screen can show them", async () => {
    await addRepository("acme/api", true);
    await addRepository("acme/web", false);

    const snapshot = await loadRepositoryCatalogSnapshot();
    expect(snapshot.entries.map((entry) => [entry.path, entry.enabled])).toEqual([
      ["acme/api", true],
      ["acme/web", false],
    ]);
    expect(snapshot.entries[0]).toMatchObject({ source: "manual", profileVersion: 1 });
  });
});

describe("repository profile versions", () => {
  it("resolves a repository key to its current profile", async () => {
    const id = await addRepository("Acme/Api", true);
    await upsertRepositoryProfile(db, {
      provider: "github",
      path: "acme/api",
      description: "second",
      rules: "",
      relationships: [],
      scriptGroups: null,
      gateGroups: null,
      actorId: "user-1",
      actorLabel: "Ada",
      reason: "dropped the scripts",
    });

    await expect(getCurrentRepositoryProfile("github:acme/api")).resolves.toMatchObject({
      version: 2,
      description: "second",
      scriptGroups: null,
    });
    await expect(listRepositoryProfileVersions(id)).resolves.toHaveLength(2);
  });

  it("answers null for a repository the catalog has never heard of", async () => {
    await expect(getCurrentRepositoryProfile("github:never/heard-of-it")).resolves.toBe(
      null,
    );
  });
});
