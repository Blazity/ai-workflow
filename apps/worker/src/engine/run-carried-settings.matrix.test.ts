/**
 * A run suspended before the catalog existed, resumed after activation
 * (matrix row R15).
 *
 * `run-carried-settings.test.ts` next door pins what a run does with the list
 * it FROZE. Every one of its cases goes through `loadRunStartSettingsStep`,
 * which always writes a `repositories` field, so none of them can reach the
 * case this file is about: a stored run-start result from a deployment whose
 * code predates that field.
 *
 * The Workflow DevKit replays a suspended run against the stored result of
 * every step it already took, so such a record is not hypothetical. What
 * `runStartRepositoryAccess` does with it is deliberate and is also the sharpest
 * edge in the feature: an absent field is read as the BRIDGE, which means a run
 * suspended before the catalog shipped resumes unrestricted on a deployment
 * that has since activated. Nothing in the code closes that; the production
 * drain before the merge is what closes it, and a drain is a procedure rather
 * than a guard. So it is pinned here, loudly, rather than left to be discovered
 * by a run that touched a repository an operator had switched off.
 *
 * `vi.mock` is hoisted per file and cannot be shared with the sibling suite;
 * everything else is imported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import {
  activateRepositoryCatalog,
  seedRepositoryCatalogEntries,
  setRepositoryEnabled,
} from "../db/repositories/repository-catalog.js";
import { repositories } from "../db/schema.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {} as Record<string, unknown>,
}));

const mocks = vi.hoisted(() => ({
  createPR: vi.fn(),
  findPR: vi.fn(),
  createRepositoryVCS: vi.fn(),
  assertActiveRunOwner: vi.fn(),
}));

vi.mock("../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./support/vcs-runtime.js", () => ({
  createRepositoryVCS: mocks.createRepositoryVCS,
}));
vi.mock("../db/repositories/active-runs.js", () => ({
  assertConnectedActiveRunOwner: mocks.assertActiveRunOwner,
  assertActiveRunOwner: mocks.assertActiveRunOwner,
}));

const { loadRunStartSettingsStep, runStartRepositoryAccess } = await import(
  "./steps/run-start-settings.js"
);
const { createOrFindWorkflowOwnedPullRequest } = await import(
  "./steps/repository-prs.js"
);

const owner = {
  subjectKey: "ticket:jira:AIW-401",
  ownerToken: "owner-1",
  runId: "run-1",
};

const repository = {
  provider: "github" as const,
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "selected",
  workflowOwnedBranch: { branchName: "blazebot/aiw-401" },
};

function openPullRequest(repositoryAccess: {
  activated: boolean;
  enabledKeys: readonly string[];
}) {
  return createOrFindWorkflowOwnedPullRequest({
    branchName: "blazebot/aiw-401",
    repository,
    title: "Fix the API",
    body: "",
    owner,
    repositoryAccess,
  });
}

let db: Db;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, {
    JOB_TIMEOUT_MS: 1_800_000,
    MAX_CONCURRENT_AGENTS: 7,
    AGENT_KIND: "claude",
  });
  mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  mocks.findPR.mockResolvedValue(null);
  mocks.createPR.mockResolvedValue({ id: 7, url: "https://github.com/acme/api/pull/7" });
  mocks.createRepositoryVCS.mockReturnValue({
    createPR: mocks.createPR,
    findPR: mocks.findPR,
  });
});

describe("a stored run-start result with no repositories field", () => {
  it("R15: resumes as the bridge, so it reaches a repository this catalog does not enable", async () => {
    // The deployment as it is TODAY: activated, and nothing enabled.
    await activateRepositoryCatalog(db, {
      actorId: "user_admin",
      actorLabel: "Ada",
      reason: "the bridge is over",
    });
    const today = await loadRunStartSettingsStep();
    expect(runStartRepositoryAccess(today)).toEqual({
      activated: true,
      enabledKeys: [],
    });
    // The positive control: a run starting now is refused this repository.
    await expect(openPullRequest(runStartRepositoryAccess(today))).rejects.toThrow(
      "not enabled in the repository catalog",
    );

    // The record a run suspended before the field existed replays against: the
    // step's stored output, with `repositories` simply absent.
    const suspended = { settings: today.settings };
    const carried = runStartRepositoryAccess(suspended);

    // `activated: false` is the bridge, not "activated and empty": the reader
    // that consumes this asks `activated` FIRST and passes everything when it
    // is false. So an absent record is the most permissive answer there is,
    // and it is more permissive than the deployment it is resuming on.
    expect(carried).toEqual({ activated: false, enabledKeys: [] });

    mocks.createPR.mockClear();
    mocks.createRepositoryVCS.mockClear();
    await expect(openPullRequest(carried)).resolves.toMatchObject({
      id: 7,
      repoPath: "acme/api",
    });
    expect(mocks.createPR).toHaveBeenCalledTimes(1);
  });

  it("R15: and the same absent record outranks a repository an operator switched off", async () => {
    // Sharper still: the repository is IN the catalog and was deliberately
    // disabled. A resumed run holding no record reaches it anyway, so
    // "disable it and the runs stop" is true only of runs whose start the
    // catalog was there for.
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });
    await activateRepositoryCatalog(db, {
      actorId: "user_admin",
      actorLabel: "Ada",
      reason: "the bridge is over",
    });
    const [row] = await db.select().from(repositories);
    await setRepositoryEnabled(db, { id: row!.id, enabled: false });

    const today = await loadRunStartSettingsStep();
    expect(runStartRepositoryAccess(today).enabledKeys).toEqual([]);

    const carried = runStartRepositoryAccess({ settings: today.settings });
    await expect(openPullRequest(carried)).resolves.toMatchObject({ repoPath: "acme/api" });

    // Deliberate, and there is no flag that changes it. What closes this is
    // draining the production queue of suspended runs before the deployment
    // that introduced the field, which is a step in the release plan and not a
    // guard in the code. If this test ever starts failing because the fallback
    // became restrictive, that is a behaviour change to announce, not a fix to
    // make quietly: it would strand every run still suspended.
    expect(runStartRepositoryAccess({ settings: today.settings }).activated).toBe(false);
  });
});
