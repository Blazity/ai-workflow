/**
 * The default-branch backfill that rides along with an import (matrix row L13).
 *
 * `import.test.ts` pins what the import itself does with the keys it was
 * handed. This pins the repair beside it: which rows it fills, which it
 * refuses to touch, and what happens to the import when the repair fails,
 * which is the half the matrix found nothing asserting. The failure path is
 * the interesting one, because `commitRepositoryImport` swallows it with a
 * bare `.catch(() => 0)`: an import whose repair never ran is reported exactly
 * like one whose repair landed, and the only trace is a row that still says
 * "not recorded".
 *
 * `vi.mock` is hoisted per file, so the mock block cannot be shared with the
 * sibling suite; everything else is imported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoriesResponse } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  directory: undefined as unknown as RepositoriesResponse,
  env: {} as Record<string, string>,
  /** When set, the backfill rejects with it instead of running. */
  backfillFailure: null as Error | null,
  backfillCalls: 0,
}));

vi.mock("../../infra/vcs-config.js", () => ({
  env: state.env,
  getConfiguredVcsProviders: () => [],
  getVcsProviderConfig: () => undefined,
}));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../repository-discovery/index.js", () => ({
  listCachedRepositoryDirectory: vi.fn(async () => state.directory),
}));
// The real module except for the one call this file is about, so the import
// path under test is the production one right up to the repair.
vi.mock("../../db/repositories/repository-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../db/repositories/repository-catalog.js")>();
  return {
    ...actual,
    backfillConnectedRepositoryDefaultBranches: async (
      ...args: Parameters<typeof actual.backfillConnectedRepositoryDefaultBranches>
    ) => {
      state.backfillCalls += 1;
      if (state.backfillFailure) throw state.backfillFailure;
      return actual.backfillConnectedRepositoryDefaultBranches(...args);
    },
  };
});

const { commitRepositoryImport } = await import("./import.js");
const { upsertRepositoryProfile } = await import(
  "../../db/repositories/repository-catalog.js"
);
const { loadRepositoryCatalogEntries } = await import("./store.js");

const ADMIN = { role: "admin" as const, id: "user_admin" };

function option(repoPath: string, defaultBranch: string) {
  const [owner, name] = repoPath.split("/");
  return {
    provider: "github" as const,
    repoPath,
    name: name ?? repoPath,
    owner: owner ?? "",
    defaultBranch,
    private: true,
    archived: false,
  };
}

/** A row as the allowlist seed leaves it: a path and nothing else, so the
 *  default branch is the empty string the backfill exists to repair. */
async function seedRow(path: string, defaultBranch?: string): Promise<void> {
  await upsertRepositoryProfile(db, {
    provider: "github",
    path,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    actorId: "user_admin",
    actorLabel: "Admin",
    reason: "",
  });
}

async function branchOf(path: string): Promise<string> {
  const { entries } = await loadRepositoryCatalogEntries();
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`no catalog row for ${path}`);
  return entry.defaultBranch;
}

let db: Db;

beforeEach(async () => {
  state.backfillFailure = null;
  state.backfillCalls = 0;
  db = await createTestDb();
  state.db = db;
  state.directory = {
    repositories: [
      option("acme/api", "main"),
      option("acme/web", "trunk"),
      option("acme/ops", "develop"),
    ],
    providers: [{ provider: "github", status: "ready" }],
  };
});

describe("commitRepositoryImport, the default-branch repair", () => {
  it("L13: fills only the rows that recorded no branch, and never overwrites one that did", async () => {
    await seedRow("acme/api");
    await seedRow("acme/web", "release");
    expect(await branchOf("acme/api")).toBe("");
    expect(await branchOf("acme/web")).toBe("release");

    // The import itself only adds acme/ops. The repair runs against the whole
    // listing this call already holds, which is how rows nobody selected get
    // fixed at all.
    const result = await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/ops"], enabled: false },
    });

    expect(result.imported).toBe(1);
    expect(state.backfillCalls).toBe(1);
    expect(await branchOf("acme/api")).toBe("main");
    // Left alone deliberately: the provider's default can change, and rewriting
    // a stored value from a listing would be the repair deciding something it
    // was not asked to decide.
    expect(await branchOf("acme/web")).toBe("release");
    // A row created by this import records its branch at creation, not through
    // the repair.
    expect(await branchOf("acme/ops")).toBe("develop");
  });

  it("L13: an import whose repair throws still reports success, and says nothing about the rows it left empty", async () => {
    await seedRow("acme/api");
    state.backfillFailure = new Error("connection reset");

    const result = await commitRepositoryImport({
      actor: ADMIN,
      request: { repositoryKeys: ["github:acme/web"], enabled: false },
    });

    // The import is not failed by the repair beside it, which is deliberate:
    // rows WERE created and reporting the call as failed would invite a retry
    // that finds them already present.
    expect(state.backfillCalls).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(await branchOf("acme/web")).toBe("trunk");

    // And this is the cost: the row the repair was for is exactly as it was,
    // the response carries no hint that the repair did not run, and nothing is
    // logged. An operator's only signal is "default branch: not recorded"
    // staying on the row (matrix open question O11).
    expect(await branchOf("acme/api")).toBe("");
    expect(Object.keys(result).sort()).toEqual([
      "alreadyPresent",
      "imported",
      "repositories",
      "skipped",
    ]);
  });
});
