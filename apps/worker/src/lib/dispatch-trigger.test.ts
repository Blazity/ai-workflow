import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import {
  prAutofixAttempts,
  triggerDeliveries,
  triggerRateLimits,
  triggerRejectionCounters,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { upsertWorkflowOwnedBranch } from "../db/queries/workflow-owned-branches.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
import { prSubjectKey } from "./subject-key.js";
import type { TriggerEvent } from "./trigger-events.js";
import {
  acknowledgeStartedTriggerDelivery,
  getTriggerDelivery,
  listPendingTriggersForSubject,
} from "./trigger-delivery-store.js";

const testEnv = vi.hoisted(() => ({
  GITLAB_PROJECT_ID: undefined as string | undefined,
  GITHUB_BOT_LOGIN: "github-app[bot]" as string | undefined,
  GITLAB_BOT_LOGIN: "gitlab-bot" as string | undefined,
  TRIGGER_RATE_LIMIT_MAX: undefined as number | undefined,
  TRIGGER_RATE_LIMIT_WINDOW: undefined as "minute" | "hour" | "day" | "month" | undefined,
}));
vi.mock("../../env.js", () => ({
  env: testEnv,
  getConfiguredVcsProviders: vi.fn(() => []),
  getVcsBotLogin: vi.fn((provider: "github" | "gitlab") =>
    provider === "github" ? testEnv.GITHUB_BOT_LOGIN : testEnv.GITLAB_BOT_LOGIN),
}));
// The pin predicate is a pure helper in the same module and stays real; only the
// network-backed directory is stubbed.
vi.mock("../adapters/vcs/repository-directory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/vcs/repository-directory.js")>()),
  createRepositoryDirectoryForProviders: vi.fn(() => ({ listRepositories: vi.fn(() => []) })),
}));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
const mockCancelSubjectRun = vi.fn();
vi.mock("./cancel-run.js", () => ({
  cancelSubjectRun: (...args: any[]) => mockCancelSubjectRun(...args),
}));
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  },
}));
loggerMock.child.mockReturnValue(loggerMock);
vi.mock("./logger.js", () => ({ logger: loggerMock }));
const { announceMock } = vi.hoisted(() => ({ announceMock: vi.fn() }));
vi.mock("./pr-autofix-exhaustion.js", () => ({
  announcePrAutofixExhaustion: (...args: any[]) => announceMock(...args),
}));
const mockGetEnabled = vi.fn();
const mockGetVersion = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
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
  mockCancelSubjectRun.mockReset().mockResolvedValue(true);
  mockGetEnabled.mockReset();
  mockGetVersion.mockReset().mockResolvedValue(null);
  loggerMock.info.mockClear();
  announceMock.mockReset().mockResolvedValue(undefined);
  testEnv.GITHUB_BOT_LOGIN = "github-app[bot]";
  testEnv.GITLAB_BOT_LOGIN = "gitlab-bot";
  testEnv.TRIGGER_RATE_LIMIT_MAX = undefined;
  testEnv.TRIGGER_RATE_LIMIT_WINDOW = undefined;
});

function enabled(
  params: Record<string, unknown> = { scope: "any" },
  triggerType: TriggerEvent["triggerType"] = "trigger_pr_created",
  repositoryScope?: Record<string, unknown>,
) {
  return {
    definition: { id: 5, name: "PR flow" },
    current: {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
        ...(repositoryScope ? { repositoryScope } : {}),
        nodes: [{ id: "trigger", type: triggerType, x: 0, y: 0, params, inputs: {} }],
        edges: [],
      },
    },
  };
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

function deps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    runRegistry: registry,
    maxConcurrentAgents: 3,
    getCurrentHead: vi.fn().mockResolvedValue("abc123"),
    getLatestCheckRuns: vi.fn().mockResolvedValue([]),
    issueTracker: { fetchTicket: vi.fn().mockResolvedValue({ identifier: "AIW-1" }) },
    isRepositoryConfigured: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as any;
}

describe("provider trigger dispatch", () => {
  it("rejects malformed or unconfigured events without writing an inbox row", async () => {
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    await expect(
      dispatchTriggerEvent(
        event({ delivery: { provider: "github", producer: "alice", deliveryId: "" } }),
        deps(),
      ),
    ).resolves.toEqual({ result: "ignored_malformed_delivery" });
    mockGetEnabled.mockResolvedValue(null);
    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "no_definition",
    });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toBeNull();
  });

  it("normalizes and verifies current provider state before accepting the event", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    await expect(
      dispatchTriggerEvent(
        event(),
        deps({ getCurrentHead: vi.fn().mockRejectedValue(new Error("provider down")) }),
      ),
    ).resolves.toMatchObject({
      result: "error",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toBeNull();
  });

  it("rechecks the current head before start and terminally rejects a changed head", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const getCurrentHead = vi
      .fn()
      .mockResolvedValueOnce("abc123")
      .mockResolvedValueOnce("new-head");
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps({ getCurrentHead }))).resolves.toEqual({
      result: "ignored_stale_head",
    });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      pending: false,
      result: { result: "ignored_stale_head" },
    });
  });

  it("reuses one safe diagnostic while a durable failure retries and recovers", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const getCurrentHead = vi
      .fn()
      .mockResolvedValueOnce("abc123")
      .mockRejectedValue(new Error("provider secret detail"));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const first = await dispatchTriggerEvent(event(), deps({ getCurrentHead }));
    expect(first).toMatchObject({
      result: "error",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    expect(JSON.stringify(first)).not.toContain("provider secret detail");

    const stored = await getTriggerDelivery(db, "github", "delivery-1");
    expect(stored).toMatchObject({
      pending: true,
      result: first,
    });

    await expect(
      dispatchTriggerEvent(event(), deps({ getCurrentHead })),
    ).resolves.toEqual(first);

    getCurrentHead.mockResolvedValue("abc123");
    await expect(
      dispatchTriggerEvent(event(), deps({ getCurrentHead })),
    ).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      pending: true,
      result: { result: "candidate_started", runId: "run-pr" },
    });
  });

  it("keeps an accepted retryable failure available for poll recovery", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const getCurrentHead = vi
      .fn()
      .mockResolvedValueOnce("abc123")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockRejectedValueOnce(new Error("provider still unavailable"))
      .mockResolvedValue("abc123");
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );

    const failure = await dispatchTriggerEvent(event(), deps({ getCurrentHead }));
    expect(failure).toMatchObject({
      result: "error",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });

    await expect(
      drainOldestPendingTrigger("pr:github:acme/app#7", deps({ getCurrentHead })),
    ).resolves.toEqual(failure);

    await expect(
      drainOldestPendingTrigger("pr:github:acme/app#7", deps({ getCurrentHead })),
    ).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
  });

  it("returns a safe diagnostic when the initial definition lookup fails", async () => {
    mockGetEnabled.mockRejectedValue(new Error("database secret detail"));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(event(), deps());
    expect(result).toMatchObject({
      result: "error",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    expect(JSON.stringify(result)).not.toContain("database secret detail");
  });

  it("starts an arbitrary human PR in review-only scope without inventing a ticket", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    const input = mockStart.mock.calls[0]?.[1]?.[0];
    expect(input).toMatchObject({
      kind: "pr_trigger",
      subjectKey: "pr:github:acme/app#7",
      scope: "any",
      definitionId: 5,
      definitionVersion: 12,
    });
    expect(input).not.toHaveProperty("ticketKey");
  });

  it("uses exact workflow ownership for mutation-capable PR scope", async () => {
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/app",
      branchName: "feature/owned",
      publishedHeadSha: "abc123",
      targetBranch: "main",
      pr: { id: 7, url: "https://github.com/acme/app/pull/7", branch: "feature/owned" },
    });
    mockGetEnabled.mockResolvedValue(enabled({ scope: "workflow_owned" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toMatchObject({
      result: "started",
    });
    expect(mockStart.mock.calls[0]?.[1]?.[0]).toMatchObject({
      // Keyed on the pull request, not the ticket: the ticket key still travels
      // with the run, but it no longer decides who may run.
      subjectKey: "pr:github:acme/app#7",
      ticketKey: "AIW-1",
      scope: "workflow_owned",
    });
  });

  it("keys every pull request of one ticket on its own subject", async () => {
    for (const pr of [
      { id: 7, repoPath: "acme/app", branch: "feature/owned" },
      { id: 11, repoPath: "acme/api", branch: "feature/owned" },
    ]) {
      await upsertWorkflowOwnedBranch(db, {
        ticketKey: "AIW-1",
        provider: "github",
        repoPath: pr.repoPath,
        branchName: pr.branch,
        publishedHeadSha: "abc123",
        targetBranch: "main",
        pr: {
          id: pr.id,
          url: `https://github.com/${pr.repoPath}/pull/${pr.id}`,
          branch: pr.branch,
        },
      });
    }
    mockGetEnabled.mockResolvedValue(enabled({ scope: "workflow_owned" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await dispatchTriggerEvent(event(), deps());
    await dispatchTriggerEvent(
      event({
        delivery: { provider: "github", producer: "alice", deliveryId: "delivery-2" },
        pr: {
          provider: "github",
          repoPath: "acme/api",
          prNumber: 11,
          prUrl: "https://github.com/acme/api/pull/11",
          headRef: "feature/owned",
          headSha: "abc123",
          baseRef: "main",
          title: "Fix",
          author: "alice",
          isDraft: false,
        },
      }),
      deps(),
    );

    // A shared ticket subject let the first pull request claim the key and the
    // single pending slot overwrite the second, so one repository of a multi-repo
    // change was never reviewed.
    expect(mockStart.mock.calls.map((call) => call[1]?.[0]?.subjectKey)).toEqual([
      "pr:github:acme/app#7",
      "pr:github:acme/api#11",
    ]);
  });

  it("returns the durable winner for a provider retry without starting twice", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toMatchObject({
      result: "started",
      runId: "run-pr",
    });
    await expect(dispatchTriggerEvent(event(), deps())).resolves.toMatchObject({
      result: "started",
      runId: "run-pr",
    });
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it("keeps one coalesced successor and starts it only after exact terminal release", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    mockStart
      .mockResolvedValueOnce({ runId: "run-1" })
      .mockResolvedValueOnce({ runId: "run-2" });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );
    const subjectKey = "pr:github:acme/app#7";

    await dispatchTriggerEvent(event(), deps());
    const owner = await registry.get(subjectKey);
    expect(owner).toMatchObject({ state: "bound", runId: "run-1" });
    const first = (await listPendingTriggersForSubject(db, subjectKey))[0]!;
    expect(await acknowledgeStartedTriggerDelivery(db, first, "run-1")).toBe(true);

    await expect(
      dispatchTriggerEvent(
        event({ delivery: { provider: "github", producer: "bob", deliveryId: "delivery-2" } }),
        deps(),
      ),
    ).resolves.toEqual({ result: "coalesced" });
    await expect(
      dispatchTriggerEvent(
        event({
          delivery: { provider: "github", producer: "carol", deliveryId: "delivery-3" },
          pr: { ...event().pr, title: "Newest feedback" },
        }),
        deps(),
      ),
    ).resolves.toEqual({ result: "coalesced" });
    expect(await listPendingTriggersForSubject(db, subjectKey)).toHaveLength(1);
    expect(mockStart).toHaveBeenCalledTimes(1);

    expect(await registry.release(subjectKey, owner!.ownerToken, "run-1")).toBe(true);
    await expect(drainOldestPendingTrigger(subjectKey, deps())).resolves.toEqual({
      result: "started",
      runId: "run-2",
    });
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  // AIW-219: an event from another repository the same connection can reach must
  // neither run nor claim the delivery, so the whole inbox stays empty rather than
  // just this delivery id.
  it("ignores an any-scope PR outside the definition pin without writing an inbox row", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any" }, "trigger_pr_created", {
        repositories: [{ provider: "github", repoPath: "acme/other" }],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "ignored_provider",
    });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toBeNull();
    await expect(db.select().from(triggerDeliveries)).resolves.toEqual([]);
  });

  it("accepts an any-scope PR inside the definition pin, matching case-insensitively", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any" }, "trigger_pr_created", {
        repositories: [{ provider: "github", repoPath: "Acme/App" }],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
  });

  it("lets an exact definition pin extend the global allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any" }, "trigger_pr_created", {
        repositories: [{ provider: "github", repoPath: "Acme/App" }],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    try {
      await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
        result: "started",
        runId: "run-pr",
      });
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("does not let provider-only scope extend the global allowlist", async () => {
    const original = process.env.AGENT_ALLOWED_REPOS;
    process.env.AGENT_ALLOWED_REPOS = "acme/other";
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any" }, "trigger_pr_created", {
        providers: ["github"],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    try {
      await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
        result: "ignored_provider",
      });
    } finally {
      if (original === undefined) delete process.env.AGENT_ALLOWED_REPOS;
      else process.env.AGENT_ALLOWED_REPOS = original;
    }
  });

  it("persists a retryable supersession cancellation failure on the accepted delivery", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any" }, "trigger_pr_updated"),
    );
    const subjectKey = "pr:github:acme/app#7";
    await registry.reserve({
      subjectKey,
      ticketKey: null,
      kind: "pr_trigger",
      ownerToken: "owner:old",
    });
    await registry.commitStartedRun({
      subjectKey,
      ticketKey: null,
      kind: "pr_trigger",
      ownerToken: "owner:old",
      runId: "run-old",
    });
    mockCancelSubjectRun.mockResolvedValue(false);
    const updated = event({ triggerType: "trigger_pr_updated" });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const first = await dispatchTriggerEvent(updated, deps());
    expect(first).toMatchObject({
      result: "error",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    await expect(
      getTriggerDelivery(db, "github", "delivery-1"),
    ).resolves.toMatchObject({
      pending: true,
      result: first,
    });

    await expect(dispatchTriggerEvent(updated, deps())).resolves.toEqual(first);
    expect(mockCancelSubjectRun).toHaveBeenCalledTimes(2);
  });

  it("still accepts a workflow-owned PR outside the definition pin", async () => {
    await upsertWorkflowOwnedBranch(db, {
      ticketKey: "AIW-1",
      provider: "github",
      repoPath: "acme/app",
      branchName: "feature/owned",
      publishedHeadSha: "abc123",
      targetBranch: "main",
      pr: { id: 7, url: "https://github.com/acme/app/pull/7", branch: "feature/owned" },
    });
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "workflow_owned" }, "trigger_pr_created", {
        repositories: [{ provider: "github", repoPath: "acme/other" }],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toMatchObject({
      result: "started",
    });
  });

  // The exemption above is safe because ownership, not the pin, is what admits a
  // workflow_owned event: without a workflow_owned_branches row the delivery stops
  // before acceptTriggerDelivery anyway, leaving the inbox empty.
  it("ignores an unowned PR outside the definition pin without writing an inbox row", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "workflow_owned" }, "trigger_pr_created", {
        repositories: [{ provider: "github", repoPath: "acme/other" }],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "ignored_not_workflow_owned",
    });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(db.select().from(triggerDeliveries)).resolves.toEqual([]);
  });

  it("filters untrusted CI producers before accepting a delivery", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled(
        { scope: "any", checkNames: ["ci / build"], githubAppSlugs: ["github-actions"] },
        "trigger_pr_checks_failed",
      ),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const untrusted = event({
      delivery: { provider: "github", producer: "unknown-app", deliveryId: "ci-1" },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        failedChecks: [{ name: "ci / build", conclusion: "failure" }],
      },
    });

    await expect(dispatchTriggerEvent(untrusted, deps())).resolves.toEqual({
      result: "ignored_untrusted_event",
    });
    await expect(getTriggerDelivery(db, "github", "ci-1")).resolves.toBeNull();
  });
});

describe("resolveEnabledReviewStates", () => {
  it("allows comments only when the provider bot identity is known", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled(
        { providers: ["github", "gitlab"], on: ["changes_requested", "commented"] },
        "trigger_pr_review",
      ),
    );
    const { resolveEnabledReviewStates } = await import("./dispatch-trigger.js");

    await expect(resolveEnabledReviewStates(db, "github", undefined)).resolves.toEqual([
      "changes_requested",
    ]);
    await expect(resolveEnabledReviewStates(db, "gitlab", "gitlab-bot")).resolves.toEqual([
      "commented",
    ]);
  });

  it("reads trigger configuration from a v2 definition without v1 params", async () => {
    mockGetEnabled.mockResolvedValue({
      definition: { id: 5, name: "PR flow" },
      current: {
        definitionId: 5,
        version: 12,
        definition: {
          schemaVersion: 2,
          nodes: [
            {
              id: "review-trigger",
              type: "trigger_pr_review",
              x: 0,
              y: 0,
              configuration: {
                providers: ["gitlab"],
                on: ["commented"],
                scope: "workflow_owned",
              },
              inputs: {},
              additionalInputs: [],
            },
          ],
          edges: [],
        },
      },
    });
    const { resolveEnabledReviewStates } = await import("./dispatch-trigger.js");

    await expect(resolveEnabledReviewStates(db, "gitlab", "gitlab-bot")).resolves.toEqual([
      "commented",
    ]);
    await expect(resolveEnabledReviewStates(db, "github", "github-app[bot]")).resolves.toEqual([]);
  });
});

describe("PR trigger rate limit", () => {
  function pinnedWithTriggerParams(params: Record<string, unknown>) {
    return {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger_pr_created", x: 0, y: 0, params, inputs: {} },
        ],
        edges: [],
      },
    };
  }

  function secondEvent(): TriggerEvent {
    return event({
      delivery: { provider: "github", producer: "alice", deliveryId: "delivery-2" },
      pr: {
        ...event().pr,
        prNumber: 8,
        prUrl: "https://github.com/acme/app/pull/8",
      },
    });
  }

  it("drops the start once the node limit is spent and tallies the refusal", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    mockGetVersion.mockResolvedValue(
      pinnedWithTriggerParams({ rateLimitMax: 1, rateLimitWindow: "day" }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    // A refused start is a terminal drop, not a queued retry: the delivery is
    // settled and the refusal tallied.
    await expect(dispatchTriggerEvent(secondEvent(), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledOnce();
    await expect(getTriggerDelivery(db, "github", "delivery-2")).resolves.toMatchObject({
      pending: false,
      result: { result: "coalesced" },
    });
    expect(await db.select().from(triggerRateLimits)).toEqual([
      expect.objectContaining({ definitionId: "5", nodeId: "trigger", count: 2 }),
    ]);
    expect(await db.select().from(triggerRejectionCounters)).toEqual([
      expect.objectContaining({
        definitionId: "5",
        nodeId: "trigger",
        reason: "rate_limited",
        count: 1,
      }),
    ]);
  });

  it("never spends the limit on a replayed or already-claimed delivery", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    mockGetVersion.mockResolvedValue(
      pinnedWithTriggerParams({ rateLimitMax: 1, rateLimitWindow: "day" }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await dispatchTriggerEvent(event(), deps());
    // Provider resend of the same delivery id replays the stored result.
    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });

    expect(mockStart).toHaveBeenCalledOnce();
    expect(await db.select().from(triggerRateLimits)).toEqual([
      expect.objectContaining({ definitionId: "5", nodeId: "trigger", count: 1 }),
    ]);
    expect(await db.select().from(triggerRejectionCounters)).toEqual([]);
  });

  it("writes nothing when no limit is configured", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
    expect(await db.select().from(triggerRateLimits)).toEqual([]);
    expect(await db.select().from(triggerRejectionCounters)).toEqual([]);
  });

  it("applies the env default when the node has no params of its own", async () => {
    testEnv.TRIGGER_RATE_LIMIT_MAX = 1;
    testEnv.TRIGGER_RATE_LIMIT_WINDOW = "day";
    mockGetEnabled.mockResolvedValue(enabled());
    mockGetVersion.mockResolvedValue(pinnedWithTriggerParams({}));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await dispatchTriggerEvent(event(), deps());
    await expect(dispatchTriggerEvent(secondEvent(), deps())).resolves.toEqual({
      result: "coalesced",
    });

    // A limit that is purely the env default is keyed under the definition's
    // first trigger node of this type.
    expect(await db.select().from(triggerRejectionCounters)).toEqual([
      expect.objectContaining({
        definitionId: "5",
        nodeId: "trigger",
        reason: "rate_limited",
        count: 1,
      }),
    ]);
  });

  it("prefers the node's own params over the env default", async () => {
    testEnv.TRIGGER_RATE_LIMIT_MAX = 5;
    testEnv.TRIGGER_RATE_LIMIT_WINDOW = "day";
    mockGetEnabled.mockResolvedValue(enabled());
    mockGetVersion.mockResolvedValue(
      pinnedWithTriggerParams({ rateLimitMax: 1, rateLimitWindow: "day" }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await dispatchTriggerEvent(event(), deps());
    await expect(dispatchTriggerEvent(secondEvent(), deps())).resolves.toEqual({
      result: "coalesced",
    });
  });
});

describe("trigger_pr_checks_failed check selection", () => {
  const failing = [
    { name: "ci / build", conclusion: "failure" },
    { name: "lint", conclusion: "failure" },
  ];

  function checksEvent(producer = "github-actions"): TriggerEvent {
    return event({
      delivery: { provider: "github", producer, deliveryId: "ci-1" },
      triggerType: "trigger_pr_checks_failed",
      pr: { ...event().pr, failedChecks: failing },
    });
  }

  it("matches every failing check when no allow-list is configured", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");

    // [] is the block registry's own default for checkNames, so this is exactly
    // what adding the trigger and saving it produces.
    expect(selectEligibleEvent(checksEvent(), {})?.pr.failedChecks).toEqual(failing);
  });

  it("still fails closed on an untrusted producer without an allow-list", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");

    expect(selectEligibleEvent(checksEvent("random-scanner"), {})).toBeNull();
  });

  it("narrows to the exact names when an allow-list is configured", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");

    expect(
      selectEligibleEvent(checksEvent(), { checkNames: ["ci / build"] })?.pr.failedChecks,
    ).toEqual([failing[0]]);
    expect(selectEligibleEvent(checksEvent(), { checkNames: ["typecheck"] })).toBeNull();
  });

  it("drops an ignored check and keeps the event alive on the rest", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");

    expect(
      selectEligibleEvent(checksEvent(), { ignoreCheckNames: ["lint"] })?.pr.failedChecks,
    ).toEqual([failing[0]]);
    // Applied after the allow-list, so it removes a name the allow-list admitted.
    expect(
      selectEligibleEvent(checksEvent(), {
        checkNames: ["ci / build", "lint"],
        ignoreCheckNames: ["lint"],
      })?.pr.failedChecks,
    ).toEqual([failing[0]]);
  });

  it("yields no event when every failing check is ignored", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");

    expect(
      selectEligibleEvent(checksEvent(), { ignoreCheckNames: ["ci / build", "lint"] }),
    ).toBeNull();
    expect(
      selectEligibleEvent(checksEvent(), {
        checkNames: ["lint"],
        ignoreCheckNames: ["lint"],
      }),
    ).toBeNull();
  });
});

describe("pull request auto-fix cap", () => {
  const subjectKey = prSubjectKey("gitlab", "acme/app", 7);

  beforeEach(() => {
    // Every start needs its own run id: the registry refuses to commit a second
    // run under an id it already holds, which would read as a cap refusal.
    let starts = 0;
    mockStart.mockImplementation(async () => ({ runId: `run-${++starts}` }));
  });

  function checksEvent(deliveryId: string): TriggerEvent {
    return event({
      delivery: {
        provider: "gitlab",
        producer: "gitlab-ci",
        source: "merge_request_event",
        deliveryId,
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        provider: "gitlab",
        prUrl: "https://gitlab.com/acme/app/-/merge_requests/7",
        failedChecks: [{ name: "pipeline", conclusion: "failed" }],
      },
    });
  }

  // "commented" rather than the github-only default "changes_requested": this
  // keeps the review event on gitlab, so it shares checksEvent's subject key
  // (same provider, repo, and PR number) for the mixed-trigger-type test below.
  function reviewEvent(deliveryId: string): TriggerEvent {
    return event({
      delivery: {
        provider: "gitlab",
        producer: "carol",
        deliveryId,
      },
      triggerType: "trigger_pr_review",
      pr: {
        ...event().pr,
        provider: "gitlab",
        prUrl: "https://gitlab.com/acme/app/-/merge_requests/7",
        review: { state: "commented", author: "carol", body: "please address this" },
      },
    });
  }

  /** The fix run binds, consumes its pending snapshot, and reaches its terminal
   * release. Without it the next failing check merges into the still-pending
   * snapshot and never reaches the cap at all. */
  async function finishRun(runId: string) {
    const pending = (await listPendingTriggersForSubject(db, subjectKey))[0]!;
    expect(await acknowledgeStartedTriggerDelivery(db, pending, runId)).toBe(true);
    const entry = await registry.get(subjectKey);
    expect(await registry.release(subjectKey, entry!.ownerToken, entry!.runId!)).toBe(true);
  }

  async function pendingDeliveryIds(): Promise<string[]> {
    const pending = await listPendingTriggersForSubject(db, subjectKey);
    return pending.map((entry) => entry.delivery.deliveryId);
  }

  it("refuses the dispatch that would exceed the configured maximum", async () => {
    const definition = enabled(
      { scope: "any", maxFixAttemptsPerPr: 1 },
      "trigger_pr_checks_failed",
    );
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(checksEvent("ci-1"), deps())).resolves.toEqual({
      result: "started",
      runId: "run-1",
    });
    await finishRun("run-1");
    await expect(dispatchTriggerEvent(checksEvent("ci-2"), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledOnce();
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({
        definitionId: "5",
        nodeId: "trigger",
        provider: "gitlab",
        repoPath: "acme/app",
        prNumber: 7,
        attempts: 2,
      }),
    ]);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 7, max: 1, attempts: 2 }),
      "pr_autofix_cap_reached",
    );
    // A terminal drop, like the rate limit's: the delivery is settled and its
    // pending snapshot is gone, so the drain cannot retry it into a run.
    await expect(getTriggerDelivery(db, "gitlab", "ci-2")).resolves.toMatchObject({
      pending: false,
      result: { result: "coalesced" },
    });
    await expect(pendingDeliveryIds()).resolves.not.toContain("ci-2");
  });

  it("takes the tightest maximum when the graph has sibling trigger nodes", async () => {
    // The delivery is matched by trigger type, so the node it belongs to cannot
    // be known: the smallest authored maximum wins and names the key.
    const definition = {
      definition: { id: 5, name: "PR flow" },
      current: {
        definitionId: 5,
        version: 12,
        definition: {
          schemaVersion: 1,
          nodes: [
            {
              id: "loose",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              params: { scope: "any", maxFixAttemptsPerPr: 5 },
              inputs: {},
            },
            {
              id: "tight",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              params: { scope: "any", maxFixAttemptsPerPr: 1 },
              inputs: {},
            },
          ],
          edges: [],
        },
      },
    };
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(checksEvent("ci-1"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-1");
    await expect(dispatchTriggerEvent(checksEvent("ci-2"), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledOnce();
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({ nodeId: "tight", attempts: 2 }),
    ]);
  });

  it("hands the exhaustion notice the dispatch that crosses the cap", async () => {
    const definition = enabled(
      { scope: "any", maxFixAttemptsPerPr: 1 },
      "trigger_pr_checks_failed",
    );
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await dispatchTriggerEvent(checksEvent("ci-1"), deps());
    await finishRun("run-1");
    // Nothing is announced while the loop still has budget.
    expect(announceMock).not.toHaveBeenCalled();

    await dispatchTriggerEvent(checksEvent("ci-2"), deps());
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith({
      provider: "gitlab",
      repoPath: "acme/app",
      baseRef: "main",
      prNumber: 7,
      prUrl: "https://gitlab.com/acme/app/-/merge_requests/7",
      ticketKey: null,
      subjectKey,
      triggerType: "trigger_pr_checks_failed",
      decision: { max: 1, allowed: false, attempts: 2 },
    });

    // A later refusal is handed on as well, carrying a decision past the
    // crossing. Recognising that transition is the notice's own job, and it
    // stays silent on everything after it.
    await dispatchTriggerEvent(checksEvent("ci-3"), deps());
    expect(announceMock).toHaveBeenCalledTimes(2);
    expect(announceMock.mock.calls[1]![0].decision).toEqual({
      max: 1,
      allowed: false,
      attempts: 3,
    });
  });

  it("reads a v2 configuration carrying neither new key as the documented defaults", async () => {
    const v2 = {
      definition: { id: 5, name: "PR flow" },
      current: {
        definitionId: 5,
        version: 12,
        definition: {
          schemaVersion: 2,
          nodes: [
            {
              id: "checks-trigger",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              configuration: { scope: "any" },
              inputs: {},
              additionalInputs: [],
            },
          ],
          edges: [],
        },
      },
    };
    mockGetEnabled.mockResolvedValue(v2);
    mockGetVersion.mockResolvedValue(v2.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    // No checkNames stored: the failing check is admitted on the strength of the
    // trusted pipeline source alone.
    await expect(dispatchTriggerEvent(checksEvent("ci-1"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-1");
    await expect(dispatchTriggerEvent(checksEvent("ci-2"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-2");
    // No maxFixAttemptsPerPr stored either: the third dispatch crosses the
    // registry default of 2.
    await expect(dispatchTriggerEvent(checksEvent("ci-3"), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({ nodeId: "checks-trigger", attempts: 3 }),
    ]);
  });

  it("counts a repeated failure on an unchanged head", async () => {
    const definition = enabled(
      { scope: "any", maxFixAttemptsPerPr: 2 },
      "trigger_pr_checks_failed",
    );
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    // Every delivery here carries the same head: a GitLab pipeline retry, or a
    // fix run that changed nothing, must not buy a free attempt.
    await expect(dispatchTriggerEvent(checksEvent("ci-1"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-1");
    await expect(dispatchTriggerEvent(checksEvent("ci-2"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-2");
    await expect(dispatchTriggerEvent(checksEvent("ci-3"), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it("refunds the cap spend on a failed start, so a cron redrain is the only real attempt counted", async () => {
    // The guard has to spend the cap unit before start is attempted, to hold
    // the reservation. If start then fails, the delivery stays pending for
    // cron to redraw; without a refund, that redraw would spend a second unit
    // for the one human action that produced it (this applies identically to
    // trigger_pr_review, since both share this same guard machinery).
    const definition = enabled(
      { scope: "any", maxFixAttemptsPerPr: 2 },
      "trigger_pr_checks_failed",
    );
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );

    mockStart.mockRejectedValueOnce(new Error("workflow start unavailable"));

    await expect(dispatchTriggerEvent(checksEvent("ci-1"), deps())).resolves.toEqual({
      result: "coalesced",
    });
    expect(mockStart).toHaveBeenCalledTimes(1);

    // Spent then refunded: the net effect of the failed start is zero, not one.
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({ nodeId: "trigger", attempts: 0 }),
    ]);

    // Cron's redrain of the same still-pending delivery is the real first
    // attempt, and the only one that should ever count.
    await expect(drainOldestPendingTrigger(subjectKey, deps())).resolves.toMatchObject({
      result: "started",
    });
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({ nodeId: "trigger", attempts: 1 }),
    ]);
  });

  it("writes nothing for a trigger the cap does not govern", async () => {
    const definition = enabled({ scope: "any" }, "trigger_pr_created");
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps())).resolves.toMatchObject({
      result: "started",
    });
    expect(await db.select().from(prAutofixAttempts)).toEqual([]);
  });

  it("refuses the 11th trigger_pr_review dispatch under the default maximum", async () => {
    const definition = enabled({ scope: "any", on: ["commented"] }, "trigger_pr_review");
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    for (let i = 1; i <= 10; i++) {
      await expect(
        dispatchTriggerEvent(reviewEvent(`rv-${i}`), deps()),
      ).resolves.toMatchObject({ result: "started" });
      await finishRun(`run-${i}`);
    }
    await expect(dispatchTriggerEvent(reviewEvent("rv-11"), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledTimes(10);
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({
        definitionId: "5",
        nodeId: "trigger",
        provider: "gitlab",
        repoPath: "acme/app",
        prNumber: 7,
        attempts: 11,
      }),
    ]);
  });

  it("refuses the 3rd trigger_pr_review dispatch under a configured maximum", async () => {
    const definition = enabled(
      { scope: "any", on: ["commented"], maxRunsPerPr: 2 },
      "trigger_pr_review",
    );
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(reviewEvent("rv-1"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-1");
    await expect(dispatchTriggerEvent(reviewEvent("rv-2"), deps())).resolves.toMatchObject({
      result: "started",
    });
    await finishRun("run-2");
    await expect(dispatchTriggerEvent(reviewEvent("rv-3"), deps())).resolves.toEqual({
      result: "coalesced",
    });

    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(await db.select().from(prAutofixAttempts)).toEqual([
      expect.objectContaining({ nodeId: "trigger", attempts: 3 }),
    ]);
  });

  it("counts trigger_pr_review runs separately from the trigger_pr_checks_failed budget on the same PR", async () => {
    // One definition with a sibling node of each capped trigger type, both
    // scoped to the same pull request: the review budget must never touch the
    // checks-failed counter, and vice versa.
    const definition = {
      definition: { id: 5, name: "PR flow" },
      current: {
        definitionId: 5,
        version: 12,
        definition: {
          schemaVersion: 1,
          nodes: [
            {
              id: "checks",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              params: { scope: "any", maxFixAttemptsPerPr: 1 },
              inputs: {},
            },
            {
              id: "review",
              type: "trigger_pr_review",
              x: 0,
              y: 0,
              params: { scope: "any", on: ["commented"] },
              inputs: {},
            },
          ],
          edges: [],
        },
      },
    };
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    // Five review runs, well under the default review budget of 10...
    for (let i = 1; i <= 5; i++) {
      await expect(
        dispatchTriggerEvent(reviewEvent(`rv-${i}`), deps()),
      ).resolves.toMatchObject({ result: "started" });
      await finishRun(`run-${i}`);
    }

    // ...but the checks-failed trigger on the same pull request, capped at 1,
    // still starts: its budget was never touched by the review deliveries.
    await expect(dispatchTriggerEvent(checksEvent("ci-1"), deps())).resolves.toMatchObject({
      result: "started",
    });

    expect(mockStart).toHaveBeenCalledTimes(6);
    expect(await db.select().from(prAutofixAttempts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "review", attempts: 5 }),
        expect.objectContaining({ nodeId: "checks", attempts: 1 }),
      ]),
    );
  });
});
