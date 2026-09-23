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
vi.mock("../../db/repositories/settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/repositories/settings.js")>()),
  readAllSettings: vi.fn().mockResolvedValue([]),
}));

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

const botLogin = vi.hoisted(() => ({
  reading: { readable: true, login: "workflow-bot" } as
    | { readable: true; login: string | undefined }
    | { readable: false; reason: string },
}));
vi.mock("../vcs/index.js", () => ({
  readVcsBotLogin: async () => botLogin.reading,
}));

const mocks = vi.hoisted(() => ({
  getDeployedWorkflowDefinitionVersion: vi.fn(),
  getManualDispatchPullRequest: vi.fn(),
  findWorkflowOwnedPullRequest: vi.fn(),
  hasDispatchBlockingApprovalForTicket: vi.fn(),
}));

vi.mock("../../db/repositories/definitions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/repositories/definitions.js")>()),
  getDeployedWorkflowDefinitionVersion: mocks.getDeployedWorkflowDefinitionVersion,
  getWorkflowDefinitionVersion: vi.fn(),
}));
vi.mock("../../engine/support/vcs-runtime.js", () => ({
  createManualDispatchPrReader: () => ({
    getManualDispatchPullRequest: mocks.getManualDispatchPullRequest,
  }),
  resolveConfiguredPullRequestUrl: async (url: URL) => {
    if (url.host === "settings-unreadable.example") {
      const { IntegrationSettingsUnreadableError } = await import("../integrations/usable.js");
      throw new IntegrationSettingsUnreadableError(
        "so the pull request URL could not be matched to a provider",
        "connection terminated unexpectedly",
      );
    }
    if (url.host === "github.com") {
      const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
      return match
        ? { provider: "github", repoPath: `${match[1]}/${match[2]}`, prNumber: Number(match[3]) }
        : null;
    }
    if (url.host === "gitlab.example.com") {
      const match = /^\/(.+)\/-\/merge_requests\/(\d+)$/.exec(url.pathname);
      return match
        ? { provider: "gitlab", repoPath: match[1], prNumber: Number(match[2]) }
        : null;
    }
    return null;
  },
}));
// Only the provider-reachability probe is stubbed; the trigger-eligibility
// helpers this module shares with automatic dispatch stay real.
vi.mock("../dispatch/dispatch-trigger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dispatch/dispatch-trigger.js")>()),
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
  it("parses only configured GitHub and nested GitLab MR URLs", async () => {
    await expect(parsePullRequestUrl("https://github.com/acme/api/pull/42")).resolves.toEqual({
      provider: "github",
      repoPath: "acme/api",
      prNumber: 42,
    });
    await expect(
      parsePullRequestUrl(
        "https://gitlab.example.com/platform/services/api/-/merge_requests/17",
      ),
    ).resolves.toEqual({
      provider: "gitlab",
      repoPath: "platform/services/api",
      prNumber: 17,
    });
  });

  it.each([
    "https://example.com/acme/api/pull/42",
    "https://github.com/acme/api/issues/42",
    "https://gitlab.example.com/platform/api/merge_requests/17",
  ])("rejects unsupported provider input %s", async (url) => {
    await expect(parsePullRequestUrl(url)).resolves.toBeNull();
  });

  it("answers settings that could not be read retryably, never as a provider that is not configured", async () => {
    // "The pull request provider is not configured" sent a person to the
    // Integrations page to connect a provider that was connected; a queued
    // dispatch took it as final and gave up.
    const refusal = parsePullRequestUrl("https://settings-unreadable.example/acme/api/pull/42");

    await expect(refusal).rejects.toMatchObject({
      name: "ManualDispatchError",
      statusCode: 503,
      code: "integration_unavailable",
    });
    await expect(refusal).rejects.toThrow(/integration settings could not be read/);
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
          handle: { id: 100, owner: "github-actions" } as never,
          producer: "github-actions",
        },
      ],
    });
    expect(
      selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {
        checkNames: ["ci / build"],
        trustedProducers: ["github-actions"],
      })?.pr.failedChecks,
    ).toEqual(failed.failedChecks);
    expect(
      selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {
        checkNames: ["ci / lint"],
        trustedProducers: ["github-actions"],
      }),
    ).toBeNull();
  });

  it("finds a failed GitLab pipeline eligible from the adapter's own snapshot", async () => {
    // Built by the real GitLab adapter, not by hand: the defect was in what the
    // adapter reported (checks with no producer), which a hand-made snapshot
    // would have papered over.
    const { GitLabAdapter } = await import("../../../../../integrations/gitlab/vcs.js");
    const { gitLabRestAnswers } = await import("../../test-support/gitlab-rest.js");
    const project = "/api/v4/projects/platform/api";
    const answers: Record<string, unknown> = {
      [`${project}/merge_requests/17`]: {
        web_url: "https://gitlab.example.com/platform/api/-/merge_requests/17",
        source_branch: "feature/manual",
        target_branch: "main",
        title: "Manual dispatch",
        author: { username: "alice" },
        state: "opened",
        diff_refs: { head_sha: "head-sha" },
        head_pipeline: { id: 901, status: "failed" },
      },
      [`${project}/pipelines/901/jobs`]: [{ id: 11, name: "lint", status: "failed" }],
      [`${project}/pipelines/901`]: { id: 901, source: "merge_request_event" },
      [`${project}/merge_requests/17/notes`]: [],
      [`${project}/merge_requests/17/discussions`]: [],
    };
    const gitLabSnapshot = await new GitLabAdapter({
      http: gitLabRestAnswers((path) => answers[path]),
      token: "t",
      projectId: "platform/api",
      baseBranch: "main",
    }).getManualDispatchPullRequest(17);
    const gitLabPr: PrTriggerPayload = {
      ...pr,
      provider: "gitlab",
      repoPath: "platform/api",
      prNumber: 17,
      prUrl: "https://gitlab.example.com/platform/api/-/merge_requests/17",
    };

    const selected = selectManualTriggerEvent(
      "trigger_pr_checks_failed",
      gitLabPr,
      gitLabSnapshot,
      {},
    );

    expect(selected?.delivery).toMatchObject({
      producer: "gitlab-ci",
      source: "merge_request_event",
    });
    expect(selected?.pr.failedChecks?.map((check) => check.name)).toEqual(["lint"]);
  });

  it("trusts a producer by the integration's own rule, not core's list of old names", () => {
    // An integration this build ships later reports its own default producer;
    // core's list for envelopes recorded before the bit existed knows only two
    // names and must not be what decides a manual dispatch.
    const failed = snapshot({
      failedChecks: [
        {
          name: "build",
          conclusion: "failure",
          producer: "acme-ci",
          trustedByDefault: true,
        },
      ],
    });

    expect(selectManualTriggerEvent("trigger_pr_checks_failed", pr, failed, {})).not.toBeNull();
    expect(
      selectManualTriggerEvent(
        "trigger_pr_checks_failed",
        pr,
        snapshot({
          failedChecks: [{ ...failed.failedChecks[0]!, trustedByDefault: false }],
        }),
        {},
      ),
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
      }, "workflow-bot")?.pr.review,
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
  };
  const issueTrackerResolution = {
    ok: true,
    id: "jira",
    name: "Jira",
    adapter: issueTracker,
    wiring: { projectKey: "AIW", baseUrl: "https://tracker.example" },
  } as unknown as Parameters<typeof resolveManualDispatch>[0]["issueTrackerResolution"];

  function deployed(
    scope: "any" | "workflow_owned",
    repositoryScope: Record<string, unknown>,
    extraNodes: Array<{ id: string; type: string }> = [],
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
          ...extraNodes.map((node, index) => ({
            id: node.id,
            type: node.type,
            x: 0,
            y: index + 1,
            configuration: {},
            inputs: {},
            additionalInputs: [],
          })),
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
    await activateRepositoryCatalog(catalogDb, { actorId: "user-1", reason: "the bridge is over" });
    return loadRepositoryCatalogSnapshot();
  }

  it("rejects an any-scope pull request outside the pin", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "acme/other" }] }),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTrackerResolution,
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
        issueTrackerResolution,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).resolves.toMatchObject({
      inputPayload: { scope: "any", pr: expect.objectContaining({ repoPath: "acme/api" }) },
    });
  });

  it("never starts a run off a check our own gate reported", async () => {
    // The gate's checks carry a managed prefix in either naming generation. A
    // run started off one would have the gate chase its own tail.
    const graph = deployed("any", { repositories: [{ provider: "github", repoPath: "acme/api" }] });
    graph.definition.nodes[0]!.type = "trigger_pr_checks_failed";
    graph.definition.nodes[0]!.configuration = { scope: "any", trustedProducers: ["github-actions"] } as never;
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(graph);
    const failed = (name: string, id: number) => ({
      name,
      conclusion: "failure",
      handle: { id, owner: "github-actions" } as never,
      producer: "github-actions",
    });
    const request = {
      db: definitionDb,
      issueTrackerResolution,
      definitionId: 5,
      triggerNodeId: "trigger",
      dispatchInput: { kind: "pull_request" as const, url: pr.prUrl },
      repositoryCatalog,
    };

    mocks.getManualDispatchPullRequest.mockResolvedValue(
      snapshot({
        failedChecks: [failed("AI Workflow / code-hygiene", 1), failed("blazebot / lint", 2)],
      }),
    );
    await expect(resolveManualDispatch(request)).rejects.toThrow("does not match this trigger");

    mocks.getManualDispatchPullRequest.mockResolvedValue(
      snapshot({
        failedChecks: [failed("AI Workflow / code-hygiene", 1), failed("ci / build", 3)],
      }),
    );
    const resolved = await resolveManualDispatch(request);
    expect(
      (resolved.inputPayload as { pr: PrTriggerPayload }).pr.failedChecks?.map((check) => check.name),
    ).toEqual(["ci / build"]);
  });

  function pullRequestRequest() {
    return {
      db: definitionDb,
      issueTrackerResolution,
      definitionId: 5,
      triggerNodeId: "trigger",
      dispatchInput: { kind: "pull_request" as const, url: pr.prUrl },
      repositoryCatalog,
    };
  }

  // A mistyped number, or a pull request the connection may not see, is the
  // person's to fix: waiting would not change the answer.
  it("tells the person a pull request this connection cannot read is not eligible", async () => {
    const { PullRequestUnreadableError } = await import("@integrations/sdk");
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(deployed("any", {}));
    mocks.getManualDispatchPullRequest.mockRejectedValue(
      new PullRequestUnreadableError("GitHub PR #42 in acme/api cannot be read"),
    );

    await expect(resolveManualDispatch(pullRequestRequest())).rejects.toMatchObject({
      statusCode: 422,
      code: "not_eligible",
    });
  });

  it("tells the person when the provider cannot read pull requests at all", async () => {
    const { ManualDispatchUnsupportedError } = await import("../../adapters/vcs/types.js");
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(deployed("any", {}));
    mocks.getManualDispatchPullRequest.mockRejectedValue(
      new ManualDispatchUnsupportedError("github"),
    );

    await expect(resolveManualDispatch(pullRequestRequest())).rejects.toMatchObject({
      statusCode: 422,
      code: "not_eligible",
      message: expect.stringContaining("cannot read pull requests"),
    });
  });

  it("calls any other failure to read the pull request an outage", async () => {
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(deployed("any", {}));
    mocks.getManualDispatchPullRequest.mockRejectedValue(
      Object.assign(new Error("Bad credentials"), { status: 401 }),
    );

    await expect(resolveManualDispatch(pullRequestRequest())).rejects.toMatchObject({
      statusCode: 502,
      code: "provider_unavailable",
    });
  });

  it("blames our settings, not the provider, when they could not be read a second time", async () => {
    // The URL was matched on the first read; building the provider's adapter
    // reads the settings again, and that read is the one that failed. Filed as
    // an outage, the person was told GitHub could not be reached.
    const { IntegrationSettingsUnreadableError } = await import("../integrations/usable.js");
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(deployed("any", {}));
    mocks.getManualDispatchPullRequest.mockRejectedValue(
      new IntegrationSettingsUnreadableError(
        "so version control provider github could not be used",
        "connection terminated unexpectedly",
      ),
    );

    const refusal = await resolveManualDispatch(pullRequestRequest()).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ statusCode: 503, code: "integration_unavailable" });
    expect((refusal as Error).message).not.toContain("connection terminated");
  });

  // Without the account, a review the workflow itself left would look like a
  // person's, and the run would answer its own comment.
  it("refuses a review dispatch while the automation account cannot be read", async () => {
    const graph = deployed("any", {});
    graph.definition.nodes[0]!.type = "trigger_pr_review";
    graph.definition.nodes[0]!.configuration = { scope: "any", on: ["commented"] } as never;
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(graph);
    botLogin.reading = { readable: false, reason: "connection terminated unexpectedly" };

    try {
      const refusal = await resolveManualDispatch(pullRequestRequest()).catch(
        (error: unknown) => error,
      );
      // The same answer every unread settings read gives, and nothing the
      // database said.
      expect(refusal).toMatchObject({ statusCode: 503, code: "integration_unavailable" });
      expect((refusal as Error).message).toContain("automation account for github");
      expect((refusal as Error).message).not.toContain("connection terminated");
    } finally {
      botLogin.reading = { readable: true, login: "workflow-bot" };
    }
  });

  it("reports every block type the deployed graph carries, so the preflight can ask about its integrations", async () => {
    // The preflight decides whether an integration this workflow uses is in a
    // state to run, and this list is the only thing it has to ask about.
    mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
      deployed("any", { repositories: [{ provider: "github", repoPath: "Acme/API" }] }, [
        { id: "announce", type: "acmenotify_announce" },
        { id: "comment", type: "post_pr_comment" },
      ]),
    );

    await expect(
      resolveManualDispatch({
        db: definitionDb,
        issueTrackerResolution,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "pull_request", url: pr.prUrl },
        repositoryCatalog,
      }),
    ).resolves.toMatchObject({
      blockTypes: ["trigger_pr_created", "acmenotify_announce", "post_pr_comment"],
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
        issueTrackerResolution,
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
        issueTrackerResolution,
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
        issueTrackerResolution,
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
        issueTrackerResolution,
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
        issueTrackerResolution,
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
        issueTrackerResolution,
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
        issueTrackerResolution,
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

  describe("on a deployment with no usable issue tracker", () => {
    const NOTHING_CONNECTED =
      "No issue tracker is connected on this deployment, so there is no ticket to work from. Connect one on the Integrations page.";
    const nothingConnected = {
      ok: false,
      refusal: "not_connected",
      reason: NOTHING_CONNECTED,
    } as Parameters<typeof resolveManualDispatch>[0]["issueTrackerResolution"];
    const unreadable = {
      ok: false,
      refusal: "unreadable",
      reason:
        "This deployment's integration settings could not be read (neon: connection reset), so its issue tracker was not used.",
    } as Parameters<typeof resolveManualDispatch>[0]["issueTrackerResolution"];

    it("resolves a pull request whose trigger accepts any pull request", async () => {
      // The subject is the pull request alone, so a GitHub-only deployment has
      // everything this dispatch needs.
      mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(deployed("any", {}));

      await expect(
        resolveManualDispatch({
          db: definitionDb,
          issueTrackerResolution: nothingConnected,
          definitionId: 5,
          triggerNodeId: "trigger",
          dispatchInput: { kind: "pull_request", url: pr.prUrl },
          repositoryCatalog,
        }),
      ).resolves.toMatchObject({ subjectKey: "pr:github:acme/api#42", ticketKey: null });
    });

    it("refuses a workflow-owned pull request, whose ticket it cannot verify, as a refusal and not an outage", async () => {
      mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(
        deployed("workflow_owned", {}),
      );

      await expect(
        resolveManualDispatch({
          db: definitionDb,
          issueTrackerResolution: nothingConnected,
          definitionId: 5,
          triggerNodeId: "trigger",
          dispatchInput: { kind: "pull_request", url: pr.prUrl },
          repositoryCatalog,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "integration_unavailable",
        message: NOTHING_CONNECTED,
      });
    });

    it("refuses a ticket input with the sentence that says where to fix it", async () => {
      const ticketTrigger = deployed("any", {});
      ticketTrigger.definition.nodes[0]!.type = "trigger_ticket_ai";
      mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(ticketTrigger);

      await expect(
        resolveManualDispatch({
          db: definitionDb,
          issueTrackerResolution: nothingConnected,
          definitionId: 5,
          triggerNodeId: "trigger",
          dispatchInput: { kind: "ticket", ticketKey: "AIW-1" },
          repositoryCatalog,
        }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "integration_unavailable",
        message: NOTHING_CONNECTED,
      });
    });

    it("answers settings it could not read as retryable, without the database's words", async () => {
      const ticketTrigger = deployed("any", {});
      ticketTrigger.definition.nodes[0]!.type = "trigger_ticket_ai";
      mocks.getDeployedWorkflowDefinitionVersion.mockResolvedValue(ticketTrigger);

      const refusal = await resolveManualDispatch({
        db: definitionDb,
        issueTrackerResolution: unreadable,
        definitionId: 5,
        triggerNodeId: "trigger",
        dispatchInput: { kind: "ticket", ticketKey: "AIW-1" },
        repositoryCatalog,
      }).catch((error: unknown) => error);

      expect(refusal).toMatchObject({ statusCode: 503, code: "integration_unavailable" });
      expect((refusal as Error).message).not.toContain("neon");
    });
  });
});
