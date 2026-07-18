import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { upsertWorkflowOwnedBranch } from "../db/queries/workflow-owned-branches.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import { IssueTrackerNotFoundError } from "../adapters/issue-tracker/types.js";
import type { TriggerEvent } from "./trigger-events.js";
import {
  acceptTriggerDelivery,
  acknowledgeStartedTriggerDelivery,
  coalescePendingTrigger,
  completeTriggerDelivery,
  deletePendingTrigger,
  getPendingTrigger,
  getTriggerDelivery,
  listRecoverableAcceptedTriggerDeliveries,
  listPendingSubjectKeys,
} from "./trigger-delivery-store.js";
import {
  recoverAcceptedTriggerDeliveries,
  recoverOrphanedPendingTriggers,
} from "./pending-trigger-recovery.js";

const testEnv = vi.hoisted(() => ({
  JIRA_PROJECT_KEY: "AIW",
  COLUMN_AI: "AI",
  GITLAB_PROJECT_ID: undefined as string | undefined,
}));
vi.mock("../../env.js", () => ({
  env: testEnv,
  getConfiguredVcsProviders: vi.fn(() => []),
}));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
const mockGetPRHead = vi.fn();
const mockGetBranchSha = vi.fn();
vi.mock("./vcs-runtime.js", () => ({
  createRepositoryVCS: vi.fn(() => ({
    getPRHead: mockGetPRHead,
    getBranchSha: mockGetBranchSha,
  })),
}));

let db: Db;
let registry: PostgresRunRegistry;

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(workflowDefinitions).values({
    id: 5,
    name: "PR flow",
    createdById: "test",
    createdByLabel: "Test",
  });
  await db.insert(workflowDefinitionVersions).values({
    definitionId: 5,
    version: 12,
    definition: {},
    createdById: "test",
    createdByLabel: "Test",
  });
  registry = new PostgresRunRegistry(db);
  mockStart.mockReset().mockResolvedValue({ runId: "run-pr" });
  mockGetEnabled.mockReset();
  mockGetPRHead.mockReset().mockResolvedValue({ headSha: "abc123" });
  mockGetBranchSha.mockReset().mockResolvedValue("abc123");
  testEnv.GITLAB_PROJECT_ID = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function enabled(
  params: Record<string, unknown> = { scope: "workflow_owned" },
  triggerType: TriggerEvent["triggerType"] = "trigger_pr_created",
) {
  return {
    definition: { id: 5, name: "PR flow" },
    current: {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: triggerType, x: 0, y: 0, params, inputs: {} },
        ],
        edges: [],
      },
    },
  };
}

function enabledReview(params: Record<string, unknown>) {
  const result = enabled(params);
  result.current.definition.nodes[0]!.type = "trigger_pr_review";
  return result;
}

function enabledTrigger(type: TriggerEvent["triggerType"], params: Record<string, unknown>) {
  const result = enabled(params);
  result.current.definition.nodes[0]!.type = type;
  return result;
}

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    delivery: { provider: "github", producer: "alice", deliveryId: "delivery-1" },
    triggerType: "trigger_pr_created",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      headRef: "feature/owned",
      headSha: "abc123",
      baseRef: "main",
      title: "Fix",
      author: "alice",
      isDraft: false,
    },
    ...overrides,
  };
}

function checksEvent(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return event({
    delivery: {
      provider: "github",
      producer: "github-actions",
      deliveryId: "checks-delivery-1",
    },
    triggerType: "trigger_pr_checks_failed",
    pr: {
      ...event().pr,
      failedChecks: [
        {
          name: "ci / build",
          conclusion: "failure",
          checkRunId: 101,
          appSlug: "github-actions",
        },
      ],
    },
    ...overrides,
  });
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    runRegistry: registry,
    maxConcurrentAgents: 3,
    getCurrentHead: vi.fn().mockResolvedValue("abc123"),
    getLatestCheckRuns: vi.fn().mockResolvedValue([
      {
        id: 101,
        name: "ci / build",
        appSlug: "github-actions",
        status: "completed",
        conclusion: "failure",
      },
    ]),
    issueTracker: {
      fetchTicket: vi.fn().mockResolvedValue({ identifier: "AIW-1" }),
    },
    isRepositoryConfigured: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as any;
}

async function correlate(publishedHeadSha = "abc123") {
  await upsertWorkflowOwnedBranch(db, {
    ticketKey: "AIW-1",
    provider: "github",
    repoPath: "acme/app",
    branchName: "feature/owned",
    publishedHeadSha,
    pr: {
      id: 7,
      url: "https://github.com/acme/app/pull/7",
      branch: "feature/owned",
    },
  });
}

describe("resolveEnabledReviewStates", () => {
  it("keeps GitHub changes requested support without a bot identity", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledReview({
        providers: ["github"],
        on: ["changes_requested", "commented"],
      }),
    );
    const { resolveEnabledReviewStates } = await import("./dispatch-trigger.js");

    await expect(resolveEnabledReviewStates(db, "github", undefined)).resolves.toEqual([
      "changes_requested",
    ]);
  });

  it("fails closed for legacy GitLab changes-requested definitions", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledReview({ providers: ["gitlab"], on: ["changes_requested"] }),
    );
    const { resolveEnabledReviewStates } = await import("./dispatch-trigger.js");

    await expect(resolveEnabledReviewStates(db, "gitlab", "gitlab-bot")).resolves.toEqual([]);
  });

  it("fails closed for legacy commented definitions without a provider bot identity", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledReview({ providers: ["github", "gitlab"], on: ["commented"] }),
    );
    const { resolveEnabledReviewStates } = await import("./dispatch-trigger.js");

    await expect(resolveEnabledReviewStates(db, "gitlab", undefined)).resolves.toEqual([]);
    await expect(resolveEnabledReviewStates(db, "gitlab", "gitlab-bot")).resolves.toEqual([
      "commented",
    ]);
  });

  it("fails closed for commented definitions with a whitespace-only bot identity", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledReview({ providers: ["github", "gitlab"], on: ["commented"] }),
    );
    const { resolveEnabledReviewStates } = await import("./dispatch-trigger.js");

    await expect(resolveEnabledReviewStates(db, "github", "   ")).resolves.toEqual([]);
    await expect(resolveEnabledReviewStates(db, "gitlab", "   ")).resolves.toEqual([]);
  });
});

describe("dispatchTriggerEvent durable envelope", () => {
  it("rejects a missing provider delivery identity before definition lookup", async () => {
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const malformed = event({
      delivery: { provider: "github", producer: "alice", deliveryId: "" },
    });
    expect(await dispatchTriggerEvent(malformed, deps())).toEqual({
      result: "ignored_malformed_delivery",
    });
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("returns no_definition without persisting a delivery", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "no_definition" });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toBeNull();
  });

  it("durably records a stale-head decision after receiving the authenticated delivery", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(
      await dispatchTriggerEvent(event(), deps({ getCurrentHead: vi.fn().mockResolvedValue("new") })),
    ).toEqual({ result: "ignored_stale_head" });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toMatchObject({
      status: "completed",
      subjectKey: null,
      result: { result: "ignored_stale_head" },
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("validates a fork PR by authoritative PR number instead of a same-named base branch", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    mockGetPRHead.mockResolvedValue({ headSha: "abc123" });
    mockGetBranchSha.mockResolvedValue("different-base-branch-head");
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(
      event({ pr: { ...event().pr, headRef: "feature/from-fork" } }),
      deps({ getCurrentHead: undefined }),
    );

    expect(result).toEqual({ result: "started", runId: "run-pr" });
    expect(mockGetPRHead).toHaveBeenCalledWith(7);
    expect(mockGetBranchSha).not.toHaveBeenCalled();
  });

  it("durably receives a delivery before a retryable provider-head lookup", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        event(),
        deps({ getCurrentHead: vi.fn().mockRejectedValue(new Error("provider unavailable")) }),
      ),
    ).toEqual({ result: "error" });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toMatchObject({
      status: "received",
      subjectKey: null,
      result: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("uses the provider PR API head for a merged event whose source branch was deleted", async () => {
    mockGetEnabled.mockResolvedValue(enabledTrigger("trigger_pr_merged", { scope: "any" }));
    const getCurrentPullRequest = vi.fn().mockResolvedValue({ headSha: "abc123" });
    const getCurrentHead = vi.fn().mockRejectedValue(new Error("branch ref not found"));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(
        event({ triggerType: "trigger_pr_merged" }),
        deps({ getCurrentPullRequest, getCurrentHead }),
      ),
    ).resolves.toEqual({ result: "started", runId: "run-pr" });
    expect(getCurrentPullRequest).toHaveBeenCalledWith(event().pr);
    expect(getCurrentHead).not.toHaveBeenCalled();
  });

  it("rejects a GitLab failure from a superseded MR head pipeline", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        checkNames: ["lint"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const gitlabEvent = event({
      delivery: {
        provider: "gitlab",
        producer: "alice",
        source: "merge_request_event",
        deliveryId: "gitlab-delivery-1",
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        provider: "gitlab",
        repoPath: "group/app",
        providerProjectId: 5,
        prUrl: "https://gitlab.com/group/app/-/merge_requests/7",
        headSha: "source-head-sha",
        pipelineId: 901,
        failedChecks: [{ name: "lint", conclusion: "failed" }],
      },
    });
    const getCurrentPullRequest = vi.fn().mockResolvedValue({
      headSha: "source-head-sha",
      headPipelineId: 902,
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(gitlabEvent, deps({ getCurrentPullRequest })),
    ).resolves.toEqual({ result: "ignored_stale_head" });
    await expect(
      getTriggerDelivery(db, "gitlab", "gitlab-delivery-1"),
    ).resolves.toMatchObject({
      status: "completed",
      subjectKey: null,
      result: { result: "ignored_stale_head" },
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("persists GitLab delivery before installed-repository lookup and poll-recovers it", async () => {
    testEnv.GITLAB_PROJECT_ID = "5";
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_created", { scope: "any", providers: ["gitlab"] }),
    );
    const gitlabEvent = event({
      delivery: {
        provider: "gitlab",
        producer: "alice",
        deliveryId: "gitlab-scope-recovery",
      },
      pr: {
        ...event().pr,
        provider: "gitlab",
        repoPath: "group/app",
        providerProjectId: 5,
        prUrl: "https://gitlab.com/group/app/-/merge_requests/7",
      },
    });
    const isRepositoryConfigured = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitLab unavailable"));
    const getCurrentPullRequest = vi.fn().mockResolvedValue({ headSha: "abc123" });
    const { dispatchTriggerEvent, recoverAcceptedTriggerDelivery } = await import(
      "./dispatch-trigger.js"
    );

    await expect(
      dispatchTriggerEvent(
        gitlabEvent,
        deps({ isRepositoryConfigured, getCurrentPullRequest }),
      ),
    ).resolves.toEqual({ result: "error" });
    await expect(
      getTriggerDelivery(db, "gitlab", "gitlab-scope-recovery"),
    ).resolves.toMatchObject({
      status: "received",
      subjectKey: null,
      result: null,
      pr: { providerProjectId: 5, repoPath: "group/app" },
    });
    expect(getCurrentPullRequest).not.toHaveBeenCalled();

    const metrics = await recoverAcceptedTriggerDeliveries({
      listDeliveries: () =>
        listRecoverableAcceptedTriggerDeliveries(
          db,
          new Date(Date.now() + 60_000),
        ),
      getActive: (subjectKey) => registry.get(subjectKey),
      resume: (stored) =>
        recoverAcceptedTriggerDelivery(
          stored,
          deps({ isRepositoryConfigured: undefined, getCurrentPullRequest }),
        ),
    });

    expect(metrics).toMatchObject({ scanned: 1, attempted: 1, started: 1, errors: 0 });
    expect(isRepositoryConfigured).toHaveBeenCalledOnce();
    expect(getCurrentPullRequest).toHaveBeenCalledOnce();
  });

  it("terminally ignores a durably received GitLab delivery denied by repository scope", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_created", { scope: "any", providers: ["gitlab"] }),
    );
    const denied = event({
      delivery: {
        provider: "gitlab",
        producer: "alice",
        deliveryId: "gitlab-scope-denied",
      },
      pr: {
        ...event().pr,
        provider: "gitlab",
        repoPath: "group/denied",
        providerProjectId: 9,
      },
    });
    const getCurrentPullRequest = vi.fn();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(
        denied,
        deps({
          isRepositoryConfigured: vi.fn().mockResolvedValue(false),
          getCurrentPullRequest,
        }),
      ),
    ).resolves.toEqual({ result: "ignored_provider" });
    await expect(
      getTriggerDelivery(db, "gitlab", "gitlab-scope-denied"),
    ).resolves.toMatchObject({
      status: "completed",
      subjectKey: null,
      result: { result: "ignored_provider" },
    });
    expect(getCurrentPullRequest).not.toHaveBeenCalled();
  });

  it("binds a documented GitLab pipeline hook to the authoritative MR source head", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        checkNames: ["lint"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const gitlabEvent = event({
      delivery: {
        provider: "gitlab",
        producer: "gitlab-ci",
        source: "merge_request_event",
        deliveryId: "gitlab-delivery-documented-payload",
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        provider: "gitlab",
        repoPath: "group/app",
        prUrl: "https://gitlab.com/group/app/-/merge_requests/7",
        headSha: "",
        pipelineId: 901,
        failedChecks: [{ name: "lint", conclusion: "failed" }],
      },
    });
    const getCurrentPullRequest = vi.fn().mockResolvedValue({
      headSha: "source-head-sha",
      headPipelineId: 901,
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(gitlabEvent, deps({ getCurrentPullRequest })),
    ).resolves.toEqual({ result: "started", runId: "run-pr" });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        pr: expect.objectContaining({
          headSha: "source-head-sha",
          pipelineId: 901,
        }),
      }),
    ]);
  });

  it("fails closed when a checks trigger has no exact check-name selectors", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(checksEvent(), deps())).resolves.toEqual({
      result: "ignored_untrusted_event",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("requires both the exact GitHub App slug and exact check name", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        checkNames: ["ci / build"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(
        checksEvent({
          delivery: {
            provider: "github",
            producer: "circleci-checks",
            deliveryId: "checks-untrusted-producer",
          },
        }),
        deps(),
      ),
    ).resolves.toEqual({ result: "ignored_untrusted_event" });
    await expect(
      dispatchTriggerEvent(
        checksEvent({
          delivery: {
            provider: "github",
            producer: "github-actions",
            deliveryId: "checks-wrong-name",
          },
          pr: {
            ...checksEvent().pr,
            failedChecks: [{ name: "CI / Build", conclusion: "failure" }],
          },
        }),
        deps(),
      ),
    ).resolves.toEqual({ result: "ignored_untrusted_event" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("passes only exact selected failed checks into an accepted GitHub run", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        checkNames: ["ci / build"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const accepted = checksEvent({
      pr: {
        ...checksEvent().pr,
        failedChecks: [
          {
            name: "untrusted / deploy",
            conclusion: "failure",
            checkRunId: 201,
            appSlug: "github-actions",
          },
          {
            name: "ci / build",
            conclusion: "failure",
            checkRunId: 101,
            appSlug: "github-actions",
          },
        ],
      },
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(accepted, deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        pr: expect.objectContaining({
          failedChecks: [
            {
              name: "ci / build",
              conclusion: "failure",
              checkRunId: 101,
              appSlug: "github-actions",
            },
          ],
        }),
      }),
    ]);
  });

  it("invalidates a queued GitHub failure after a same-head rerun succeeds", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        checkNames: ["ci / build"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const failed = checksEvent({
      delivery: {
        provider: "github",
        producer: "github-actions",
        deliveryId: "checks-failed-run-101",
      },
      pr: {
        ...checksEvent().pr,
        failedChecks: [
          {
            name: "ci / build",
            conclusion: "failure",
            checkRunId: 101,
            appSlug: "github-actions",
          },
        ],
      } as any,
    });
    const latestChecks = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 101,
          name: "ci / build",
          appSlug: "github-actions",
          status: "completed",
          conclusion: "failure",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 102,
          name: "ci / build",
          appSlug: "github-actions",
          status: "completed",
          conclusion: "success",
        },
      ]);
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );

    await expect(
      dispatchTriggerEvent(failed, deps({ getLatestCheckRuns: latestChecks })),
    ).resolves.toEqual({ result: "coalesced" });
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");
    await expect(
      drainOldestPendingTrigger(
        "pr:github:acme/app#7",
        deps({ getLatestCheckRuns: latestChecks }),
      ),
    ).resolves.toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getTriggerDelivery(db, "github", "checks-failed-run-101")).resolves.toMatchObject({
      result: { result: "ignored_stale_head" },
    });
  });

  it("requires an exact trusted GitLab pipeline source", async () => {
    mockGetEnabled.mockResolvedValue(
      enabledTrigger("trigger_pr_checks_failed", {
        scope: "any",
        checkNames: ["lint"],
        githubAppSlugs: ["github-actions"],
        gitlabPipelineSources: ["merge_request_event"],
      }),
    );
    const gitlabEvent = checksEvent({
      delivery: {
        provider: "gitlab",
        producer: "alice",
        source: "web",
        deliveryId: "gitlab-manual-pipeline",
      },
      pr: {
        ...checksEvent().pr,
        provider: "gitlab",
        repoPath: "group/app",
        headSha: "source-head-sha",
        pipelineId: 901,
        failedChecks: [{ name: "lint", conclusion: "failed" }],
      },
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(
        gitlabEvent,
        deps({
          getCurrentPullRequest: vi.fn().mockResolvedValue({
            headSha: "source-head-sha",
            headPipelineId: 901,
          }),
        }),
      ),
    ).resolves.toEqual({ result: "ignored_untrusted_event" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("never treats a ticket-looking branch prefix as workflow ownership", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const prefixed = event({ pr: { ...event().pr, headRef: "blazebot/aiw-1" } });
    expect(await dispatchTriggerEvent(prefixed, deps())).toEqual({
      result: "ignored_not_workflow_owned",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("requires durable correlation plus a valid ticket and starts under the ticket subject", async () => {
    await correlate();
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        kind: "pr_trigger",
        subjectKey: "ticket:jira:AIW-1",
        ticketKey: "AIW-1",
        ownerToken: expect.stringMatching(/^owner:/),
        definitionId: 5,
        definitionVersion: 12,
        scope: "workflow_owned",
      }),
    ]);
    expect(await registry.get("ticket:jira:AIW-1")).toMatchObject({
      state: "reserved",
      runId: null,
    });
  });

  it("rejects workflow ownership after a human advances the correlated branch", async () => {
    await correlate("abc123");
    mockGetEnabled.mockResolvedValue(enabled());
    const pushedByHuman = event({ pr: { ...event().pr, headSha: "human456" } });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        pushedByHuman,
        deps({ getCurrentHead: vi.fn().mockResolvedValue("human456") }),
      ),
    ).toEqual({ result: "ignored_not_workflow_owned" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("rejects a durable correlation whose ticket no longer exists", async () => {
    await correlate();
    mockGetEnabled.mockResolvedValue(enabled());
    const issueTracker = {
      fetchTicket: vi.fn().mockRejectedValue(new IssueTrackerNotFoundError("ticket", "AIW-1")),
    };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps({ issueTracker }))).toEqual({
      result: "ignored_not_workflow_owned",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("durably receives a delivery before a retryable correlated-ticket lookup", async () => {
    await correlate();
    mockGetEnabled.mockResolvedValue(enabled());
    const issueTracker = {
      fetchTicket: vi.fn().mockRejectedValue(new Error("Jira unavailable")),
    };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(await dispatchTriggerEvent(event(), deps({ issueTracker }))).toEqual({
      result: "error",
    });
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toMatchObject({
      status: "received",
      subjectKey: null,
      result: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("poll-enriches and dispatches a received delivery after Jira recovers", async () => {
    await correlate();
    mockGetEnabled.mockResolvedValue(enabled());
    const fetchTicket = vi
      .fn()
      .mockRejectedValueOnce(new Error("Jira unavailable"))
      .mockResolvedValue({ identifier: "AIW-1" });
    const issueTracker = { fetchTicket };
    const { dispatchTriggerEvent, recoverAcceptedTriggerDelivery } = await import(
      "./dispatch-trigger.js"
    );

    await expect(dispatchTriggerEvent(event(), deps({ issueTracker }))).resolves.toEqual({
      result: "error",
    });

    const metrics = await recoverAcceptedTriggerDeliveries({
      listDeliveries: () =>
        listRecoverableAcceptedTriggerDeliveries(
          db,
          new Date(Date.now() + 60_000),
        ),
      getActive: (subjectKey) => registry.get(subjectKey),
      resume: (stored) => recoverAcceptedTriggerDelivery(stored, deps({ issueTracker })),
    });

    expect(metrics).toMatchObject({ scanned: 1, attempted: 1, started: 1, errors: 0 });
    expect(mockStart).toHaveBeenCalledOnce();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      status: "completed",
      subjectKey: "ticket:jira:AIW-1",
      result: { result: "candidate_started", runId: "run-pr" },
    });
  });

  it("holds a PR-created delivery until its exact provider PR correlation is durable", async () => {
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/app",
      branchName: "feature/owned",
      publishedHeadSha: "abc123",
    });
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent, recoverAcceptedTriggerDelivery } = await import(
      "./dispatch-trigger.js"
    );

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({ result: "error" });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      status: "accepted",
      result: null,
      subjectKey: "ticket:jira:AIW-1",
      ticketKey: "AIW-1",
      pr: expect.objectContaining({ prNumber: 7, headSha: "abc123" }),
    });
    expect(mockStart).not.toHaveBeenCalled();

    await correlate();

    const metrics = await recoverAcceptedTriggerDeliveries({
      listDeliveries: () =>
        listRecoverableAcceptedTriggerDeliveries(db, new Date(Date.now() + 60_000)),
      getActive: (subjectKey) => registry.get(subjectKey),
      resume: (stored) => recoverAcceptedTriggerDelivery(stored, deps()),
    });

    expect(metrics).toMatchObject({ scanned: 1, attempted: 1, started: 1, errors: 0 });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("never dispatches a held PR-created delivery for a different provider PR id", async () => {
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/app",
      branchName: "feature/owned",
      publishedHeadSha: "abc123",
    });
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent, recoverAcceptedTriggerDelivery } = await import(
      "./dispatch-trigger.js"
    );
    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({ result: "error" });

    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/app",
      branchName: "feature/owned",
      publishedHeadSha: "abc123",
      pr: {
        id: 8,
        url: "https://github.com/acme/app/pull/8",
        branch: "feature/owned",
      },
    });
    const held = await getTriggerDelivery(db, "github", "delivery-1");
    expect(held).not.toBeNull();

    await expect(recoverAcceptedTriggerDelivery(held!, deps())).resolves.toEqual({
      result: "ignored_not_workflow_owned",
    });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      status: "completed",
      result: { result: "ignored_not_workflow_owned" },
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("scope:any uses a stable synthetic subject and never calls Jira", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any", providers: ["github"] }));
    const issueTracker = { fetchTicket: vi.fn() };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps({ issueTracker }))).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(issueTracker.fetchTicket).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        subjectKey: "pr:github:acme/app#7",
        scope: "any",
      }),
    ]);
    expect(Object.hasOwn(mockStart.mock.calls[0][1][0], "ticketKey")).toBe(false);
  });

  it("rejects an off-allowlist scope:any event before current-head reads or persistence", async () => {
    vi.stubEnv("AGENT_ALLOWED_REPOS", "acme/allowed");
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any", providers: ["github"] }));
    const getCurrentHead = vi.fn().mockResolvedValue("abc123");
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(await dispatchTriggerEvent(event(), deps({ getCurrentHead }))).toEqual({
      result: "ignored_provider",
    });
    expect(getCurrentHead).not.toHaveBeenCalled();
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("redelivery returns the stored result and never starts twice", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "started", runId: "run-pr" });
    const input = mockStart.mock.calls[0]![1][0];
    expect(await registry.bindRun(input.subjectKey, input.ownerToken, "run-pr")).toBe(true);
    expect(await acknowledgeStartedTriggerDelivery(db, input, "run-pr")).toBe(true);
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "started", runId: "run-pr" });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("records a recoverable candidate without acknowledging it as owner-bound", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      status: "completed",
      result: { result: "candidate_started", runId: "run-pr" },
    });
    await expect(
      getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).resolves.toMatchObject({
      delivery: { deliveryId: "delivery-1" },
      definitionId: 5,
      definitionVersion: 12,
    });
  });

  it("recovers the exact pinned envelope when a started candidate dies before binding", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    const crashedInput = mockStart.mock.calls[0]![1][0];
    expect(
      await registry.releaseReservation(crashedInput.subjectKey, crashedInput.ownerToken),
    ).toBe(true);

    mockStart.mockResolvedValueOnce({ runId: "run-recovered" });
    const metrics = await recoverOrphanedPendingTriggers({
      listSubjects: () => listPendingSubjectKeys(db),
      getActive: (subjectKey) => registry.get(subjectKey),
      drain: (subjectKey) => drainOldestPendingTrigger(subjectKey, deps()),
    });

    expect(metrics).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 1,
      started: 1,
      errors: 0,
    });
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockStart.mock.calls[1]![1][0]).toEqual(
      expect.objectContaining({
        definitionId: 5,
        definitionVersion: 12,
        delivery: expect.objectContaining({ deliveryId: "delivery-1" }),
        pr: expect.objectContaining({ headSha: "abc123" }),
        pendingEvent: {
          headSha: "abc123",
          triggerType: "trigger_pr_created",
          deliveryId: "delivery-1",
        },
      }),
    );
    await expect(registry.get("pr:github:acme/app#7")).resolves.toMatchObject({
      state: "reserved",
      runId: null,
    });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      result: { result: "candidate_started", runId: "run-recovered" },
    });
  });

  it("lets only one poll recovery candidate win the owner CAS", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );
    await dispatchTriggerEvent(event(), deps());
    const crashedInput = mockStart.mock.calls[0]![1][0];
    await registry.releaseReservation(crashedInput.subjectKey, crashedInput.ownerToken);
    mockStart.mockResolvedValue({ runId: "run-recovered" });

    const recover = () =>
      recoverOrphanedPendingTriggers({
        listSubjects: () => listPendingSubjectKeys(db),
        getActive: vi.fn().mockResolvedValue(null),
        drain: (subjectKey) => drainOldestPendingTrigger(subjectKey, deps()),
      });
    const [left, right] = await Promise.all([recover(), recover()]);

    expect(left.started + right.started).toBe(1);
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it("does not let an older accepted redelivery overwrite newer queued feedback", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    await dispatchTriggerEvent(event(), deps());
    await dispatchTriggerEvent(
      event({
        delivery: { provider: "github", producer: "alice", deliveryId: "delivery-2" },
        pr: {
          ...event().pr,
          reviews: [{ state: "commented", author: "reviewer", body: "new feedback" }],
        },
      }),
      deps(),
    );

    await dispatchTriggerEvent(event(), deps());

    await expect(
      getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).resolves.toMatchObject({
      delivery: { deliveryId: "delivery-2" },
      pr: {
        reviews: [{ state: "commented", author: "reviewer", body: "new feedback" }],
      },
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("resumes an accepted delivery whose result was not stored before a crash", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await acceptTriggerDelivery(db, {
      ...event(),
      scope: "any",
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(await dispatchTriggerEvent(event(), deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockGetEnabled).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("poll-recovers an exact pinned delivery after a crash between acceptance and queueing", async () => {
    const accepted = {
      ...event({
        delivery: {
          provider: "github" as const,
          producer: "alice",
          deliveryId: "accepted-before-queue",
        },
      }),
      scope: "any" as const,
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    };
    await acceptTriggerDelivery(db, accepted);
    await expect(
      getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).resolves.toBeNull();
    const { recoverAcceptedTriggerDelivery } = await import("./dispatch-trigger.js");

    const metrics = await recoverAcceptedTriggerDeliveries({
      listDeliveries: () =>
        listRecoverableAcceptedTriggerDeliveries(
          db,
          new Date(Date.now() + 60_000),
        ),
      getActive: (subjectKey) => registry.get(subjectKey),
      resume: (stored) => recoverAcceptedTriggerDelivery(stored, deps()),
    });

    expect(metrics).toEqual({
      scanned: 1,
      blocked: 0,
      attempted: 1,
      started: 1,
      errors: 0,
    });
    expect(mockGetEnabled).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({
        definitionId: 5,
        definitionVersion: 12,
        delivery: expect.objectContaining({ deliveryId: "accepted-before-queue" }),
        pr: expect.objectContaining({ headSha: "abc123" }),
      }),
    ]);
    await expect(
      getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).resolves.toMatchObject({
      delivery: { deliveryId: "accepted-before-queue" },
    });
    await expect(
      getTriggerDelivery(db, "github", "accepted-before-queue"),
    ).resolves.toMatchObject({
      result: { result: "candidate_started", runId: "run-pr" },
    });
  });

  it("lets only one concurrent accepted-delivery poller start a candidate", async () => {
    const accepted = {
      ...event({
        delivery: {
          provider: "github" as const,
          producer: "alice",
          deliveryId: "accepted-concurrent-poll",
        },
      }),
      scope: "any" as const,
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    };
    await acceptTriggerDelivery(db, accepted);
    const { recoverAcceptedTriggerDelivery } = await import("./dispatch-trigger.js");
    const recover = () =>
      recoverAcceptedTriggerDeliveries({
        listDeliveries: () =>
          listRecoverableAcceptedTriggerDeliveries(
            db,
            new Date(Date.now() + 60_000),
          ),
        // Deliberately stale advisory reads: the dispatcher reservation is the
        // authoritative CAS under concurrent poll invocations.
        getActive: vi.fn().mockResolvedValue(null),
        resume: (stored) => recoverAcceptedTriggerDelivery(stored, deps()),
      });

    const [left, right] = await Promise.all([recover(), recover()]);

    expect(left.started + right.started).toBe(1);
    expect(mockStart).toHaveBeenCalledOnce();
    await expect(
      getTriggerDelivery(db, "github", "accepted-concurrent-poll"),
    ).resolves.toMatchObject({
      result: { result: "candidate_started", runId: "run-pr" },
    });
  });

  it("revalidates an accepted-but-unfinished delivery before crash recovery", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await acceptTriggerDelivery(db, {
      ...event({
        delivery: { provider: "github", producer: "alice", deliveryId: "accepted-stale" },
      }),
      scope: "any",
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        event({
          delivery: { provider: "github", producer: "alice", deliveryId: "accepted-stale" },
        }),
        deps({ getCurrentHead: vi.fn().mockResolvedValue("new-head") }),
      ),
    ).toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
    expect(await getTriggerDelivery(db, "github", "accepted-stale")).toMatchObject({
      result: { result: "ignored_stale_head" },
    });
  });

  it("revalidates accepted-delivery recovery against the authoritative PR head", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await acceptTriggerDelivery(db, {
      ...event({
        delivery: { provider: "github", producer: "alice", deliveryId: "accepted-fork-stale" },
      }),
      scope: "any",
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    });
    mockGetPRHead.mockResolvedValue({ headSha: "new-pr-head" });
    mockGetBranchSha.mockResolvedValue("abc123");
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(
      event({
        delivery: { provider: "github", producer: "alice", deliveryId: "accepted-fork-stale" },
      }),
      deps({ getCurrentHead: undefined }),
    );

    expect(result).toEqual({ result: "ignored_stale_head" });
    expect(mockGetPRHead).toHaveBeenCalledWith(7);
    expect(mockGetBranchSha).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("does not queue a duplicate when the winning workflow records started during recovery", async () => {
    const accepted = {
      ...event({
        delivery: { provider: "github", producer: "alice", deliveryId: "accepted-race" },
      }),
      scope: "any" as const,
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    };
    await acceptTriggerDelivery(db, accepted);
    await registry.reserve({
      subjectKey: accepted.subjectKey,
      ticketKey: null,
      ownerToken: "owner-original",
      kind: "pr_trigger",
    });
    await registry.bindRun(accepted.subjectKey, "owner-original", "run-original");

    const racingRegistry = {
      listAll: () => registry.listAll(),
      reserve: async () => {
        await completeTriggerDelivery(db, "github", "accepted-race", {
          result: "started",
          runId: "run-original",
        });
        return false;
      },
    };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    expect(
      await dispatchTriggerEvent(
        event({
          delivery: { provider: "github", producer: "alice", deliveryId: "accepted-race" },
        }),
        deps({ runRegistry: racingRegistry }),
      ),
    ).toEqual({ result: "started", runId: "run-original" });
    expect(
      await getPendingTrigger(
        db,
        accepted.subjectKey,
        accepted.pr.headSha,
        accepted.triggerType,
      ),
    ).toBeNull();
  });

  it("redelivery returns the original result without re-evaluating changed head or definition", async () => {
    mockGetEnabled.mockResolvedValueOnce(enabled({ scope: "any" })).mockResolvedValueOnce(null);
    const getCurrentHead = vi.fn().mockResolvedValueOnce("abc123").mockResolvedValueOnce("new-head");
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps({ getCurrentHead }))).toEqual({
      result: "started",
      runId: "run-pr",
    });
    const input = mockStart.mock.calls[0]![1][0];
    expect(await registry.bindRun(input.subjectKey, input.ownerToken, "run-pr")).toBe(true);
    expect(await acknowledgeStartedTriggerDelivery(db, input, "run-pr")).toBe(true);
    expect(await dispatchTriggerEvent(event(), deps({ getCurrentHead }))).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(mockGetEnabled).toHaveBeenCalledTimes(1);
    expect(getCurrentHead).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("durably coalesces when another owner already holds the subject", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "existing-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).toMatchObject({ definitionVersion: 12 });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("lets the winning workflow consume pending without a dispatcher-side delete", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    expect(
      await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner"),
    ).toBe(true);

    mockStart.mockImplementationOnce(async (_workflow, [input]) => {
      expect(input.pendingEvent).toEqual({
        headSha: "abc123",
        triggerType: "trigger_pr_created",
        deliveryId: "delivery-1",
      });
      expect(await registry.bindRun(input.subjectKey, input.ownerToken, "run-pr")).toBe(true);
      expect(await acknowledgeStartedTriggerDelivery(db, input, "run-pr")).toBe(true);
      return { runId: "run-pr" };
    });
    const dispatcherDelete = vi.fn();
    expect(
      await drainOldestPendingTrigger(
        "pr:github:acme/app#7",
        deps({ deletePending: dispatcherDelete }),
      ),
    ).toEqual({ result: "started", runId: "run-pr" });
    expect(dispatcherDelete).not.toHaveBeenCalled();
    expect(
      await registry.release(
        "pr:github:acme/app#7",
        (await registry.get("pr:github:acme/app#7"))!.ownerToken,
        "run-pr",
      ),
    ).toBe(true);
    expect(
      await drainOldestPendingTrigger("pr:github:acme/app#7", deps()),
    ).toBeNull();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("leaves a started pending snapshot for the bound workflow to acknowledge", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    await dispatchTriggerEvent(event(), deps());
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");

    await expect(drainOldestPendingTrigger("pr:github:acme/app#7", deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    await expect(
      getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).resolves.not.toBeNull();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      result: { result: "candidate_started", runId: "run-pr" },
    });
  });

  it("retires a dead candidate when its queued PR snapshot becomes stale", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );
    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    const crashedInput = mockStart.mock.calls[0]![1][0];
    await registry.releaseReservation(crashedInput.subjectKey, crashedInput.ownerToken);

    await expect(
      drainOldestPendingTrigger(
        crashedInput.subjectKey,
        deps({ getCurrentHead: vi.fn().mockResolvedValue("new-head") }),
      ),
    ).resolves.toBeNull();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      result: { result: "ignored_stale_head" },
    });
    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "ignored_stale_head",
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("drops an already-started stale pending snapshot without launching a successor", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const accepted = {
      ...event(),
      scope: "any" as const,
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      definitionId: 5,
      definitionVersion: 12,
    };
    await acceptTriggerDelivery(db, accepted);
    await registry.reserve({
      subjectKey: accepted.subjectKey,
      ticketKey: null,
      ownerToken: "owner-original",
      kind: "pr_trigger",
    });
    await registry.bindRun(accepted.subjectKey, "owner-original", "run-original");
    await acknowledgeStartedTriggerDelivery(db, accepted, "run-original");
    await coalescePendingTrigger(db, accepted);
    await registry.release(accepted.subjectKey, "owner-original", "run-original");

    const { drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    await expect(drainOldestPendingTrigger(accepted.subjectKey, deps())).resolves.toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
    await expect(
      getPendingTrigger(db, accepted.subjectKey, accepted.pr.headSha, accepted.triggerType),
    ).resolves.toBeNull();
  });

  it("retains feedback merged while a pending successor starts", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");

    mockStart.mockImplementationOnce(async (_workflow, [input]) => {
      await coalescePendingTrigger(db, {
        ...event({
          delivery: { provider: "github", producer: "github-actions", deliveryId: "delivery-2" },
          pr: {
            ...event().pr,
            failedChecks: [{ name: "test", conclusion: "failure" }],
          },
        }),
        scope: "any",
        subjectKey: "pr:github:acme/app#7",
        ticketKey: null,
        definitionId: 5,
        definitionVersion: 12,
      });
      expect(await registry.bindRun(input.subjectKey, input.ownerToken, "run-pr")).toBe(true);
      return { runId: "run-pr" };
    });

    expect(await drainOldestPendingTrigger("pr:github:acme/app#7", deps())).toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).toMatchObject({ delivery: { deliveryId: "delivery-2" } });
  });

  it("retains a pending event when its current head cannot be revalidated", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");

    expect(
      await drainOldestPendingTrigger(
        "pr:github:acme/app#7",
        deps({ getCurrentHead: vi.fn().mockRejectedValue(new Error("provider unavailable")) }),
      ),
    ).toEqual({ result: "error" });
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).not.toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("drops pending feedback when the authoritative PR head moved despite a matching base branch", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    await registry.reserve({
      subjectKey: "pr:github:acme/app#7",
      ticketKey: null,
      ownerToken: "blocking-owner",
      kind: "pr_trigger",
    });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import("./dispatch-trigger.js");
    expect(await dispatchTriggerEvent(event(), deps())).toEqual({ result: "coalesced" });
    await registry.releaseReservation("pr:github:acme/app#7", "blocking-owner");
    mockGetPRHead.mockResolvedValue({ headSha: "new-pr-head" });
    mockGetBranchSha.mockResolvedValue("abc123");

    await expect(
      drainOldestPendingTrigger(
        "pr:github:acme/app#7",
        deps({ getCurrentHead: undefined }),
      ),
    ).resolves.toBeNull();

    expect(mockGetPRHead).toHaveBeenCalledWith(7);
    expect(mockGetBranchSha).not.toHaveBeenCalled();
    expect(
      await getPendingTrigger(
        db,
        "pr:github:acme/app#7",
        "abc123",
        "trigger_pr_created",
      ),
    ).toBeNull();
    expect(await getTriggerDelivery(db, "github", "delivery-1")).toMatchObject({
      result: { result: "ignored_stale_head" },
    });
    expect(mockStart).not.toHaveBeenCalled();
  });
});
