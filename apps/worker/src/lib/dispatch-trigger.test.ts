import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import {
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../db/schema.js";
import { createTestDb } from "../db/test-db.js";
import { upsertWorkflowOwnedBranch } from "../db/queries/workflow-owned-branches.js";
import { PostgresRunRegistry } from "../adapters/run-registry/postgres.js";
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
}));
vi.mock("../../env.js", () => ({
  env: testEnv,
  getConfiguredVcsProviders: vi.fn(() => []),
  getVcsBotLogin: vi.fn((provider: "github" | "gitlab") =>
    provider === "github" ? testEnv.GITHUB_BOT_LOGIN : testEnv.GITLAB_BOT_LOGIN),
}));
vi.mock("../adapters/vcs/repository-directory.js", () => ({
  createRepositoryDirectoryForProviders: vi.fn(() => ({ listRepositories: vi.fn(() => []) })),
}));
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../workflows/agent.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
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
  testEnv.GITHUB_BOT_LOGIN = "github-app[bot]";
  testEnv.GITLAB_BOT_LOGIN = "gitlab-bot";
});

function enabled(
  params: Record<string, unknown> = { scope: "any" },
  triggerType: TriggerEvent["triggerType"] = "trigger_pr_created",
) {
  return {
    definition: { id: 5, name: "PR flow" },
    current: {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
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
    ).resolves.toEqual({ result: "error" });
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
      subjectKey: "ticket:jira:AIW-1",
      ticketKey: "AIW-1",
      scope: "workflow_owned",
    });
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
    expect(owner?.state).toBe("reserved");
    expect(await registry.bindRun(subjectKey, owner!.ownerToken, "run-1")).toBe(true);
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
