import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_FALLBACK_DEFINITION_VERSION } from "./agent-input.js";
import type { Db } from "../db/client.js";
import { createTestDb } from "../db/test-db.js";
import { writeManySettings } from "../db/repositories/settings.js";
import {
  activateRepositoryCatalog,
  seedRepositoryCatalogEntries,
  setRepositoryEnabled,
} from "../db/repositories/repository-catalog.js";
import { repositories } from "../db/schema.js";

/**
 * A run finishes under the rules it started with.
 *
 * This is the promise `appliesToRunsInFlight: "next run"` makes in the settings
 * registry and the reason the engine wave exists: an operator who lowers a
 * timeout or switches a repository off at 14:03 must not move a run that
 * started at 14:00. A run outlives its read by hours, so a step that re-read
 * either store would answer differently on its first execution and on a replay,
 * and the Workflow journal would record a divergence nobody can explain.
 *
 * Every case below is written the same way: read the rules at run start, change
 * the STORE, prove a NEXT run sees the change (the positive control, without
 * which a green test could just mean the write never landed), then prove the
 * run already in flight does not.
 */
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
const { loadWorkflowDefinitionFor } = await import("./steps/definition-step.js");

let db: Db;

const owner = {
  subjectKey: "ticket:jira:AIW-400",
  ownerToken: "owner-1",
  runId: "run-1",
};

const repository = {
  provider: "github" as const,
  repoPath: "acme/api",
  defaultBranch: "main",
  selectedRationale: "selected",
  workflowOwnedBranch: { branchName: "blazebot/aiw-400" },
};

function openPullRequest(repositoryAccess: {
  activated: boolean;
  enabledKeys: readonly string[];
}) {
  return createOrFindWorkflowOwnedPullRequest({
    branchName: "blazebot/aiw-400",
    repository,
    title: "Fix the API",
    body: "",
    owner,
    repositoryAccess,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, {
    JOB_TIMEOUT_MS: 1_800_000,
    MAX_CONCURRENT_AGENTS: 7,
    AGENT_KIND: "claude",
    ENABLE_REVIEW_PHASE: true,
    ENABLE_LEAK_REVIEW: false,
  });
  mocks.assertActiveRunOwner.mockResolvedValue(undefined);
  mocks.findPR.mockResolvedValue(null);
  mocks.createPR.mockResolvedValue({ id: 7, url: "https://github.com/acme/api/pull/7" });
  mocks.createRepositoryVCS.mockReturnValue({
    createPR: mocks.createPR,
    findPR: mocks.findPR,
  });
});

describe("a run finishes under the rules it started with", () => {
  it("keeps the repository list it froze at run start when an operator disables a repository mid-run", async () => {
    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "seeded",
      enabled: true,
    });
    await activateRepositoryCatalog(db, { actorId: "user_admin", actorLabel: "Ada" });

    // 14:00. The run starts and freezes the list it may touch.
    const runStart = await loadRunStartSettingsStep();
    const carried = runStartRepositoryAccess(runStart);
    expect(carried).toEqual({ activated: true, enabledKeys: ["github:acme/api"] });

    // 14:03. An operator switches the repository off on the Repositories page.
    const [row] = await db.select().from(repositories);
    await setRepositoryEnabled(db, { id: row!.id, enabled: false });

    // The positive control: a run starting now would refuse this repository.
    const nextRun = await loadRunStartSettingsStep();
    expect(runStartRepositoryAccess(nextRun)).toEqual({
      activated: true,
      enabledKeys: [],
    });

    // The run already in flight opens its pull request, on the list it froze.
    await expect(openPullRequest(carried)).resolves.toMatchObject({
      id: 7,
      repoPath: "acme/api",
    });
    expect(mocks.createPR).toHaveBeenCalledTimes(1);
  });

  it("refuses, for the same in-flight run, a repository its start list never carried", async () => {
    // The mirror image, so the case above cannot pass by refusing nothing: a
    // repository enabled AFTER the run started is not reachable either.
    await activateRepositoryCatalog(db, { actorId: "user_admin" });

    const runStart = await loadRunStartSettingsStep();
    const carried = runStartRepositoryAccess(runStart);
    expect(carried.enabledKeys).toEqual([]);

    await seedRepositoryCatalogEntries(db, {
      repositories: [{ provider: "github", path: "acme/api" }],
      source: "manual",
      enabled: true,
    });
    const nextRun = await loadRunStartSettingsStep();
    expect(runStartRepositoryAccess(nextRun).enabledKeys).toEqual(["github:acme/api"]);

    await expect(openPullRequest(carried)).rejects.toThrow(
      "not enabled in the repository catalog",
    );
    expect(mocks.createPR).not.toHaveBeenCalled();
    expect(mocks.createRepositoryVCS).not.toHaveBeenCalled();
  });

  it("keeps the settings snapshot it froze at run start when an operator changes a setting mid-run", async () => {
    // 14:00. The run starts and freezes its snapshot.
    const runStart = await loadRunStartSettingsStep();
    const carried = runStart.settings;
    expect(carried.ENABLE_REVIEW_PHASE).toBe(true);
    expect(carried.JOB_TIMEOUT_MS).toBe(1_800_000);

    // The plan this run loads carries a review phase, because its snapshot does.
    const plan = await loadWorkflowDefinitionFor(
      carried,
      "trigger_ticket_ai",
      1,
      BUILTIN_FALLBACK_DEFINITION_VERSION,
    );
    expect(plan?.reviewEnabled).toBe(true);

    // 14:03. An operator turns the review phase off and shortens the budget.
    await writeManySettings(db, {
      patch: { ENABLE_REVIEW_PHASE: false, JOB_TIMEOUT_MS: 60_000 },
      actor: "user_admin",
      reason: "tuning",
    });

    // The positive control: a run starting now gets the new values.
    const nextRun = await loadRunStartSettingsStep();
    expect(nextRun.settings.ENABLE_REVIEW_PHASE).toBe(false);
    expect(nextRun.settings.JOB_TIMEOUT_MS).toBe(60_000);
    const nextPlan = await loadWorkflowDefinitionFor(
      nextRun.settings,
      "trigger_ticket_ai",
      1,
      BUILTIN_FALLBACK_DEFINITION_VERSION,
    );
    expect(nextPlan?.reviewEnabled).toBe(false);

    // The run already in flight reloads its plan (a replay does exactly this)
    // from the snapshot it carries, and gets the same plan it started with.
    const replayed = await loadWorkflowDefinitionFor(
      carried,
      "trigger_ticket_ai",
      1,
      BUILTIN_FALLBACK_DEFINITION_VERSION,
    );
    expect(replayed?.reviewEnabled).toBe(true);
    expect(replayed?.nodes).toEqual(plan?.nodes);
    expect(carried.JOB_TIMEOUT_MS).toBe(1_800_000);
  });
});
