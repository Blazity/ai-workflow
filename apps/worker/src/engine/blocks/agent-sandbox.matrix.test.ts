/**
 * The sandbox lifetime a repository's checks ceiling buys (matrix row R23).
 *
 * Two halves, and the matrix found only one of them pinned. The composition
 * half -- a run touching two repositories takes the LARGEST claim, not the
 * smallest and not the sum -- is already asserted at
 * `db/repositories/repository-catalog.test.ts` ("takes the highest claim among
 * the run's repositories only"). What nothing asserted is what that number is
 * then SPENT on: the sandbox is created with `JOB_TIMEOUT_MS + ceiling` as a
 * one-time `timeout`, and editing the profile afterwards moves nothing in
 * either direction, because a created sandbox's lifetime is a parameter to
 * `Sandbox.create` and there is no call anywhere that extends one.
 *
 * `agent-sandbox.test.ts` next door asserts the arithmetic with the DEFAULT
 * ceiling, against a stubbed database that makes the provisioning step fall
 * back. This file runs the real composition against pglite, so a profile that
 * claims 30 minutes is followed all the way to the number the platform is
 * handed.
 *
 * `vi.mock` is hoisted per file and cannot be shared; the context and settings
 * factories are imported from `blocks/support/test-support.ts`, as next door.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));

const mocks = vi.hoisted(() => ({
  env: {
    ANTHROPIC_API_KEY: "anthropic-key",
    CODEX_API_KEY: "codex-key",
    JOB_TIMEOUT_MS: 120_000,
    DASHBOARD_ORG_SLUG: "test-org",
  } as Record<string, unknown>,
  sandboxCreate: vi.fn(),
  sandboxGet: vi.fn(),
  stop: vi.fn(),
  runCommand: vi.fn(),
  writeFiles: vi.fn(),
  install: vi.fn(),
  configure: vi.fn(),
  createAgentAdapter: vi.fn(),
  registerSandbox: vi.fn(),
  dashboardOrganizationId: vi.fn(),
  resolveHarnessProfileVersion: vi.fn(),
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: mocks.env }));
vi.mock("@vercel/sandbox", () => ({
  Sandbox: { create: mocks.sandboxCreate, get: mocks.sandboxGet },
}));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
// The one difference from the sibling suite: a REAL database, so the
// provisioning step composes a ceiling out of stored profiles instead of
// falling back.
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
vi.mock("../definition/harness-profile-runtime.js", () => ({
  dashboardOrganizationId: mocks.dashboardOrganizationId,
}));
vi.mock("../../db/repositories/harness-profiles.js", () => ({
  resolveHarnessProfileVersion: mocks.resolveHarnessProfileVersion,
}));
vi.mock("../../db/repositories/auth.js", () => ({
  createConnectedAuthRepository: () => ({
    findOrganizationBySlug: async () => ({ id: "org-1" }),
  }),
}));
vi.mock("../../harness-profiles/resolved-version.js", () => ({
  resolveConnectedVerifiedHarnessProfileVersion: mocks.resolveHarnessProfileVersion,
}));
vi.mock("../../sandbox/agents/index.js", () => ({
  createAgentAdapter: mocks.createAgentAdapter,
}));
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({ runRegistry: { registerSandbox: mocks.registerSandbox } }),
}));

import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { upsertRepositoryProfile } from "../../db/repositories/repository-catalog.js";
import { ensureAgentSandbox } from "./agent-sandbox.js";
import { sandboxLifetimeMs } from "./prepare-workspace/execute.js";
import { checksCeilingMsOf } from "./pre-pr-checks.js";
import { makeCtx, makeRunSettings } from "./support/test-support.js";

const JOB_TIMEOUT_MS = 120_000;
const MINUTE_MS = 60_000;

let db: Db;

async function profile(path: string, batchTimeoutMinutes: number | null): Promise<void> {
  await upsertRepositoryProfile(db, {
    provider: "github",
    path,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: {
      provider: "github",
      repoPath: path,
      groups: { test: { commands: ["pnpm test"] } },
    },
    gateGroups: null,
    batchTimeoutMinutes,
    actorId: "user_admin",
    actorLabel: "Admin",
    reason: "seeded",
    enabled: true,
  });
}

function ctxTouching(paths: string[]) {
  return makeCtx({
    sandboxId: null,
    agentSandboxIds: {},
    sandboxIds: new Set<string>(),
    checksCeilingMs: null,
    workspaceManifest: null,
    selectedRepositories: paths.map((repoPath) => ({
      provider: "github" as const,
      repoPath,
      defaultBranch: "main",
      selectedRationale: "selected",
    })),
    settings: makeRunSettings({ JOB_TIMEOUT_MS }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createTestDb();
  state.db = db;
  mocks.stop.mockResolvedValue({ status: "stopped" });
  mocks.runCommand.mockResolvedValue({
    exitCode: 0,
    stdout: vi.fn().mockResolvedValue(""),
    stderr: vi.fn().mockResolvedValue(""),
  });
  mocks.writeFiles.mockResolvedValue(undefined);
  mocks.install.mockResolvedValue(undefined);
  mocks.configure.mockResolvedValue(undefined);
  mocks.registerSandbox.mockResolvedValue(undefined);
  mocks.dashboardOrganizationId.mockResolvedValue("org-1");
  mocks.sandboxCreate.mockResolvedValue({
    sandboxId: "scratch-1",
    status: "running",
    stop: mocks.stop,
    runCommand: mocks.runCommand,
    writeFiles: mocks.writeFiles,
  });
  mocks.sandboxGet.mockResolvedValue({
    sandboxId: "scratch-1",
    status: "running",
    runCommand: mocks.runCommand,
    writeFiles: mocks.writeFiles,
  });
  mocks.createAgentAdapter.mockReturnValue({
    install: mocks.install,
    configure: mocks.configure,
  });
});

describe("the lifetime a sandbox is created with", () => {
  it("R23: is the run's job timeout PLUS the largest ceiling the run's repositories claim", async () => {
    await profile("acme/api", 5);
    await profile("acme/web", 30);
    // A repository outside this run asking for more must not raise it, which is
    // what the scoped composition is for.
    await profile("acme/ops", 120);

    await ensureAgentSandbox(ctxTouching(["acme/api", "acme/web"]), "claude", "claude-model");

    // Added, not maxed and not substituted: the sandbox has to survive the
    // agent's own work AND the check batches it then hosts.
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      runtime: "node24",
      timeout: JOB_TIMEOUT_MS + 30 * MINUTE_MS,
    });
    // The same number, said by the two exported functions that compose it, so a
    // change to either is visible here rather than only in a platform argument.
    expect(sandboxLifetimeMs(JOB_TIMEOUT_MS, checksCeilingMsOf(30))).toBe(
      JOB_TIMEOUT_MS + 30 * MINUTE_MS,
    );
  });

  it("R23: an edit to the ceiling mid-run moves nothing, in either direction", async () => {
    await profile("acme/api", 30);
    const ctx = ctxTouching(["acme/api"]);

    const first = await ensureAgentSandbox(ctx, "claude", "claude-model");
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      runtime: "node24",
      timeout: JOB_TIMEOUT_MS + 30 * MINUTE_MS,
    });
    expect(ctx.checksCeilingMs).toBe(30 * MINUTE_MS);

    // 14:03. An operator raises the repository's claim on the Scripts tab.
    await profile("acme/api", 120);
    const raised = await ensureAgentSandbox(ctx, "claude", "claude-model");

    // The run in flight is unmoved: the ceiling is cached on the context and
    // the lifetime was a one-time argument to `Sandbox.create`. Nothing in the
    // codebase extends a created sandbox, so a longer claim cannot rescue a
    // batch that is about to be killed.
    expect(raised).toBe(first);
    expect(mocks.sandboxCreate).toHaveBeenCalledTimes(1);
    expect(ctx.checksCeilingMs).toBe(30 * MINUTE_MS);

    // And lowering it cannot shorten one either: the same context keeps the
    // number it resolved, so the sandbox outlives an operator's second thoughts.
    await profile("acme/api", 5);
    await ensureAgentSandbox(ctx, "claude", "claude-model");
    expect(mocks.sandboxCreate).toHaveBeenCalledTimes(1);
    expect(ctx.checksCeilingMs).toBe(30 * MINUTE_MS);

    // The edit is not lost, it simply belongs to the NEXT run: a fresh context
    // resolves the stored claim and sizes its own sandbox against it.
    mocks.sandboxCreate.mockClear();
    await ensureAgentSandbox(ctxTouching(["acme/api"]), "claude", "claude-model");
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      runtime: "node24",
      timeout: JOB_TIMEOUT_MS + 5 * MINUTE_MS,
    });
  });

  it("R23: a run whose repositories claim nothing falls back to the operator ceiling", async () => {
    await profile("acme/api", null);

    await ensureAgentSandbox(ctxTouching(["acme/api"]), "claude", "claude-model");

    // The default batch bound, which is what "use the operator ceiling" means
    // at this seam. Asserted so the fallback cannot quietly become zero, which
    // would size every sandbox at the job timeout alone and kill check batches
    // that used to fit.
    expect(mocks.sandboxCreate).toHaveBeenCalledWith({
      runtime: "node24",
      timeout: JOB_TIMEOUT_MS + checksCeilingMsOf(undefined),
    });
    expect(checksCeilingMsOf(undefined)).toBeGreaterThan(0);
  });
});
