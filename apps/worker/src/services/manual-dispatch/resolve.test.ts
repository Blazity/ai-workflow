import { beforeEach, describe, expect, it, vi } from "vitest";
import { RETIRED_SCHEMA_MESSAGE } from "@shared/contracts";
import type { ManualDispatchPullRequestSnapshot } from "../../adapters/vcs/types.js";
import type { PrTriggerPayload } from "../../engine/agent-input.js";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";

// The catalog snapshot is read through the connected reads, so this file needs a
// client mock; every other query here is stubbed outright.
const dbState = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../db/client.js", () => ({ getDb: () => dbState.db }));

vi.mock("../../infra/vcs-config.js", () => ({
  env: {},
  getConfiguredVcsProviders: () => [
    {
      kind: "github",
      host: "https://github.com",
      auth: {},
      legacyBaseBranch: "main",
    },
    {
      kind: "gitlab",
      host: "https://gitlab.example.com",
      token: "token",
      legacyBaseBranch: "main",
    },
  ],
}));

vi.mock("../vcs/index.js", () => ({
  getVcsBotLogin: () => "workflow-bot",
}));

const mocks = vi.hoisted(() => ({
  getDeployedWorkflowDefinitionVersion: vi.fn(),
  getManualDispatchPullRequest: vi.fn(),
  isConfiguredTriggerRepository: vi.fn(),
  findWorkflowOwnedPullRequest: vi.fn(),
  hasDispatchBlockingApprovalForTicket: vi.fn(),
}));

vi.mock("../../db/repositories/definitions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/repositories/definitions.js")>()),
  getDeployedWorkflowDefinitionVersion: mocks.getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinitionVersion: vi.fn(),
}));
vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createRepositoryVCS: () => ({
    getManualDispatchPullRequest: mocks.getManualDispatchPullRequest,
  }),
}));
// Only the provider-reachability probe is stubbed; the trigger-eligibility
// helpers this module shares with automatic dispatch stay real.
vi.mock("../dispatch/dispatch-trigger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatch/dispatch-trigger.js")>()),
  isConfiguredTriggerRepository: mocks.isConfiguredTriggerRepository,
}));
vi.mock("../../db/repositories/runs.js", () => ({
  findWorkflowOwnedPullRequest: mocks.findWorkflowOwnedPullRequest,
  findConnectedWorkflowOwnedPullRequest: mocks.findWorkflowOwnedPullRequest,
}));
vi.mock("../../db/repositories/approvals.js", () => ({
  hasDispatchBlockingApprovalForTicket: mocks.hasDispatchBlockingApprovalForTicket,
  hasConnectedDispatchBlockingApprovalForTicket:
    mocks.hasDispatchBlockingApprovalForTicket,
}));
vi.mock("../../post-pr-gate/config.js", () => ({
  loadPostPrGateConfig: () => ({ postPrGate: { steps: [] } }),
}));

const { parsePullRequestUrl, resolveManualDispatch, selectManualTriggerEvent } =
  await import("./resolve.js");
const {
  activateRepositoryCatalog,
  setRepositoryEnabled,
  upsertRepositoryProfile,
} = await import("../../db/repositories/repository-catalog.js");
const { loadRepositoryCatalogSnapshot } = await import(
  "../repository-catalog/index.js"
);
const { REPOSITORY_NOT_IN_CATALOG_REASON } = await import(
  "../dispatch/repo-allowlist.js"
);

const pr: PrTriggerPayload = {
  provider: "github",
  repoPath: "acme/api",
  prNumber: 42,
  prUrl: "https://github.com/acme/api/pull/42",
  headRef: "feature/manual",
  headSha: "head-sha",
  baseRef: "main",
  title: "Manual dispatch",
  author: "alice",
  isDraft: false,
};

function snapshot(
  overrides: Partial<ManualDispatchPullRequestSnapshot> = {},
): ManualDispatchPullRequestSnapshot {
  return {
    prNumber: 42,
    prUrl: pr.prUrl,
    headRef: pr.headRef,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    title: pr.title,
    author: pr.author,
    isDraft: false,
    state: "open",
    failedChecks: [],
    reviews: [],
    ...overrides,
  };
}

describe("manual pull request input", () => {
  it("parses only configured GitHub and nested GitLab MR URLs", () => {
    expect(parsePullRequestUrl("https://github.com/acme/api/pull/42")).toEqual({
      provider: "github",
      repoPath: "acme/api",
      prNumber: 42,
    });
    expect(
      parsePullRequestUrl(
        "https://gitlab.example.com/platform/services/api/-/merge_requests/17",
      ),
    ).toEqual({
      provider: "gitlab",
      repoPath: "platform/services/api",
      prNumber: 17,
    });
  });

  it.each([
    "https://example.com/acme/api/pull/42",
    "https://github.com/acme/api/issues/42",
    "https://gitlab.example.com/platform/api/merge_requests/17",
  ])("rejects unsupported provider input %s", (url) => {
    expect(() => parsePullRequestUrl(url)).toThrow();
  });

  it("requires created and merged triggers to match current lifecycle state", () => {
    expect(
      selectManualTriggerEvent(
        "trigger_pr_created",
        pr,
        snapshot({ state: "open" }),
        {},
      ),
    ).not.toBeNull();
    expect(
      selectManualTriggerEvent(
        "trigger_pr_created",
        pr,
        snapshot({ state: "closed" }),
        {},
      ),
    ).toBeNull();
    expect(
      selectManualTriggerEvent(
        "trigger_pr_merged",
        pr,
        snapshot({ state: "merged" }),
        {},
      ),
    ).not.toBeNull();
  });

  it("requires a configured current non-gate GitHub check failure", () => {
    const failed = snapshot({
      failedChecks: [
        {
          name: "ci / build",
          conclusion: "failure",
          checkRunId: 100,
          appSlug: "github-actions",
        },
      ],
    });
    expect(
      selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {
        checkNames: ["ci / build"],
        githubAppSlugs: ["github-actions"],
      })?.pr.failedChecks,
    ).toEqual(failed.failedChecks);
    expect(
      selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {
        checkNames: ["ci / lint"],
        githubAppSlugs: ["github-actions"],
      }),
    ).toBeNull();
  });

  it("uses the latest eligible non-bot review matching configured states", () => {
    const reviews = snapshot({
      reviews: [
        {
          state: "changes_requested",
          author: "human-reviewer",
          body: "Cover the retry path.",
        },
        {
          state: "changes_requested",
          author: "workflow-bot",
          body: "Automated review.",
        },
      ],
    });
    expect(
      selectManualTriggerEvent("trigger_pr_review", pr, reviews, {
        on: ["changes_requested"],
      })?.pr.review,
    ).toEqual({
      state: "changes_requested",
      author: "human-reviewer",
      body: "Cover the retry path.",
    });
  });
});

describe("manual dispatch against a definition repository pin", () => {
  const definitionDb = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ name: "PR flow" }] }),
      }),
    }),
  } as unknown as Parameters<typeof resolveManualDispatch>[0]["db"];

  const issueTracker = {
    fetchTicket: vi.fn().mockResolvedValue({ identifier: "AIW-1" }),
  } as unknown as Parameters<typeof resolveManualDispatch>[0]["issueTracker"];

  function deployed(
    scope: "any" | "workflow_owned",
    repositoryScope: Record<string, unknown>,
  ) {
    return {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 2,
        repositoryScope,
        nodes: [
          {
            id: "trigger",
            type: "trigger_pr_created",
            x: 0,
            y: 0,
            configuration: { scope },
            inputs: {},
            additionalInputs: [],
          },
        ],
        edges: [],
      },
    };
  }

  let catalogDb: Db;
  /** The bridge, read out of the test database rather than invented: an empty
   *  catalog nobody activated passes every repository. */
  let repositoryCatalog: Awaited<ReturnType<typeof loadRepositoryCatalogSnapshot>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getManualDispatchPullRequest.mockResolvedValue(snapshot());
    mocks.isConfiguredTriggerRepository.mockResolvedValue(true);
    mocks.hasDispatchBlockingApprovalForTicket.mockResolvedValue(false);
    mocks.findWorkflowOwnedPullRequest.mockResolvedValue({ ticketKey: "AIW-1" });
    catalogDb = await createTestDb();
    dbState.db = catalogDb;
    repositoryCatalog = await loadRepositoryCatalogSnapshot();
  });

  /** Put these repositories in the catalog, switch it on, and read the snapshot
   *  back the way an entry point would. */
  async function activatedCatalogWith(
    entries: ReadonlyArray<{ path: string; enabled: boolean }>,
  ) {
    for (const entry of entries) {
      const saved = await upsertRepositoryProfile(catalogDb, {
        provider: "github",
        path: entry.path,
        description: "",
        rules: "",
        relationships: [],
        scriptGroups: { provider: "github", repoPath: entry.path, groups: {} },
        gateGroups: null,
        actorId: "user-1",
        actorLabel: "Ada",
        reason: "",
        enabled: entry.enabled,
      });
      if (!entry.enabled) {
        await setRepositoryEnabled(catalogDb, { id: saved.id, enabled: false });
      }
    }
    await activateRepositoryCatalog(catalogDb, { actorId: "user-1" });
    return loadRepositoryCatalogSnapshot();
  }

  it("rejects an any-scope pull request outside the pin", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "acme/other" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).rejects.toThrow("outside the repositories pinned to this workflow");
  });

  it("accepts an any-scope pull request inside the pin, matching case-insensitively", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "Acme/API" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).resolves.toMatchObject({
      inputPayload: { scope: "any", pr: expect.objectContaining({ repoPath: "acme/api" }) },
    });
  });

  it("accepts a pull request whose repository the activated catalog enables", async () => {
    const catalog = await activatedCatalogWith([{ path: "Acme/Api", enabled: true }]);
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "Acme/API" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog: catalog,
      }),
    ).resolves.toMatchObject({
      inputPayload: { scope: "any", pr: expect.objectContaining({ repoPath: "acme/api" }) },
    });
  });

  it("refuses a pull request the activated catalog has disabled, naming the catalog", async () => {
    const catalog = await activatedCatalogWith([{ path: "acme/api", enabled: false }]);
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { providers: ["github"] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog: catalog,
      }),
    ).rejects.toThrow(REPOSITORY_NOT_IN_CATALOG_REASON);
  });

  // A pin used to be a grant. It is a selection inside the catalog now, so
  // pinning a repository nobody enabled reaches nothing.
  it("does not let a definition pin reach a repository the catalog leaves disabled", async () => {
    const catalog = await activatedCatalogWith([
      { path: "acme/api", enabled: false },
      { path: "acme/other", enabled: true },
    ]);
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "Acme/API" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog: catalog,
      }),
    ).rejects.toThrow(REPOSITORY_NOT_IN_CATALOG_REASON);
  });

  it("rejects a trigger type manual dispatch cannot start", async () => {
    const webhook = deployed("any", {});
    webhook.definition.nodes[0]!.type = "trigger_webhook";
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(webhook);

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).rejects.toThrow("not present in the deployed workflow");
  });

  it("rejects a retired deployed definition with the retirement reason", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue({
      definitionId: 5,
      version: 12,
      definition: { schemaVersion: 1, nodes: [], edges: [] },
    });

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "not_eligible",
      message: RETIRED_SCHEMA_MESSAGE,
    });
  });

  it("still accepts a workflow-owned pull request outside the pin", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("workflow_owned", {
        repositories: [{ provider: "github", repoPath: "acme/other" }],
      }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).resolves.toMatchObject({ ticketKey: "AIW-1" });
  });

  it("reserves a workflow-owned pull request on the pull request, not its ticket", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("workflow_owned", {}),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTracker,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).resolves.toMatchObject({
      subjectKey: "pr:github:acme/api#42",
      ticketKey: "AIW-1",
    });
  });
});
