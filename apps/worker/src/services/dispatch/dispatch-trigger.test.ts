import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PullRequestUnreadableError,
  type PullRequestFailedCheck,
  type PullRequestHead,
  type PullRequestHeadChecks,
} from "@integrations/sdk";
import type { Db } from "../../db/client.js";
import {
  prAutofixAttempts,
  triggerDeliveries,
  triggerRateLimits,
  triggerRejectionCounters,
  workflowDefinitions,
  workflowDefinitionVersions,
} from "../../db/schema.js";
import { createTestDb } from "../../db/test-db.js";
import {
  activateRepositoryCatalog,
  setRepositoryEnabled,
  upsertRepositoryProfile,
} from "../../db/repositories/repository-catalog.js";
import { loadRepositoryCatalogSnapshot } from "../repository-catalog/index.js";
import type { RepositoryCatalogSnapshot } from "../repository-catalog/index.js";
import { upsertWorkflowOwnedBranch } from "../../db/repositories/runs.js";
import { PostgresRunRegistry } from "../../db/repositories/active-runs.js";
import { prSubjectKey } from "../run-lifecycle/subject-key.js";
import type { TriggerEvent } from "./trigger-events.js";
import {
  acknowledgeStartedTriggerDelivery,
  getTriggerDelivery,
  listPendingTriggersForSubject,
} from "./trigger-delivery-store.js";

const testEnv = vi.hoisted(() => ({
  GITHUB_BOT_LOGIN: "github-app[bot]" as string | undefined,
  GITLAB_BOT_LOGIN: "gitlab-bot" as string | undefined,
}));
vi.mock("../../infra/vcs-config.js", () => ({
  env: testEnv,
  getConfiguredVcsProviders: vi.fn(() => []),
}));
// The catalog snapshot is loaded through the connected reads, which is the only
// reason this file needs a client mock: every other query here takes `db`.
const dbState = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../../db/client.js", () => ({ getDb: () => dbState.db }));
const botLoginReadable = vi.hoisted(() => ({ value: true }));
vi.mock("../vcs/index.js", () => ({
  readVcsBotLogin: vi.fn(async (provider: "github" | "gitlab") =>
    botLoginReadable.value
      ? {
          readable: true,
          login: provider === "github" ? testEnv.GITHUB_BOT_LOGIN : testEnv.GITLAB_BOT_LOGIN,
        }
      : { readable: false, reason: "settings unreadable" }),
}));
// The pin predicate is a pure helper in the same module and stays real; only the
// network-backed directory is stubbed.
vi.mock("../../adapters/vcs/repository-directory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/vcs/repository-directory.js")>()),
  createRepositoryDirectoryForProviders: vi.fn(() => ({ listRepositories: vi.fn(() => []) })),
}));
/**
 * The provider behind the production version control path: the real GitLab
 * integration reached through the lazy repository runtime, with only GitLab's
 * HTTP answers (below) and the connection store standing in. Off unless a case
 * turns it on, so every other case keeps reading the store it always read.
 */
const gitlabProvider = vi.hoisted(() => ({
  connected: false,
  mergeRequest: undefined as unknown,
  jobs: [] as unknown[],
  /** GitLab refusing the merge request read, with the JSON body its REST API
   *  answers (`{ message }`, or `{ error, error_description }` for a scope). */
  refusal: undefined as { status: number; body: Record<string, unknown> } | undefined,
}));
vi.mock("../integrations/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../integrations/runtime.js")>();
  return {
    ...actual,
    resolveUsableIntegrations: async (input: Parameters<typeof actual.resolveUsableIntegrations>[0]) => {
      if (!gitlabProvider.connected) return actual.resolveUsableIntegrations(input);
      const { integrationRuntime } = await import("@integrations/registry/worker");
      const { redactingRuntime } = await import("../integrations/usable.js");
      const { redactedError } = await import("../integrations/context.js");
      // Behind core's own boundary, as the resolver hands it out: what the
      // adapter throws reaches dispatch as core's redacted copy.
      const runtime = redactingRuntime(integrationRuntime("gitlab")!, (error) =>
        redactedError(error, (text) => text),
      );
      // The caller's lifetime ends every request, as the real context's does.
      const lifetime = input?.lifetime ?? new AbortController().signal;
      const entry = {
        manifest: runtime.manifest,
        runtime,
        ctx: {
          connection: { token: "token", host: "https://gitlab.example.com" },
          http: {
            fetch: (target: Parameters<typeof fetch>[0], init?: RequestInit) =>
              fetch(target, {
                ...init,
                signal: init?.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime,
              }),
          },
          log: { debug() {}, info() {}, warn() {}, error() {} },
          signal: lifetime,
        },
      };
      return {
        readable: true as const,
        usable: input.filter?.(runtime.manifest) === false ? [] : [entry],
        states: new Map([["gitlab", { integrationId: "gitlab", usable: true }]]),
      } as never;
    },
  };
});
const mockStart = vi.fn();
vi.mock("workflow/api", () => ({ start: (...args: any[]) => mockStart(...args) }));
vi.mock("../../engine/index.js", () => ({ agentWorkflow: "agentWorkflow_sentinel" }));
const mockCancelSubjectRun = vi.fn();
vi.mock("../run-lifecycle/cancel-run.js", () => ({
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
vi.mock("../../infra/logger.js", () => ({ logger: loggerMock }));
const { announceMock } = vi.hoisted(() => ({ announceMock: vi.fn() }));
vi.mock("./pr-autofix-exhaustion.js", () => ({
  announcePrAutofixExhaustion: (...args: any[]) => announceMock(...args),
}));
const mockGetEnabled = vi.fn();
const mockGetVersion = vi.fn();
vi.mock("../../engine/definition-trigger-routing.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
  getConnectedEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));
vi.mock("../../db/repositories/definitions.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
  getWorkflowDefinitionVersion: (...args: any[]) => mockGetVersion(...args),
  runnableDefinitionOf: (row: any) => row?.schema === "v2" ? row.definition : undefined,
}));

let db: Db;
let registry: PostgresRunRegistry;

/**
 * What the provider reports about the pull request right now, declared by each
 * case rather than read back from the event it is judging. A double built from
 * the event agreed with every event by construction, so no case could observe
 * a check that was re-run, one running again, or a head that went green. The
 * default is an open pull request at `event()`'s head with its checks green; a
 * case about failed checks says what the provider reports failing.
 */
let providerReports: PullRequestHead;

function openPullRequest(
  checks: PullRequestHeadChecks = { state: "green", failed: [] },
): PullRequestHead {
  return { headSha: "abc123", headRef: "feature/owned", baseRef: "main", state: "open", checks };
}

/** The provider reporting these checks failed on the head. Each check is built
 *  by the caller, never taken from the event, the way a provider re-reading its
 *  own API mints its own handles. */
function providerReportsFailed(...failed: PullRequestFailedCheck[]): void {
  providerReports = openPullRequest({ state: "red", failed });
}
/** The bridge, read out of the test database rather than invented: an empty
 *  catalog nobody activated passes every repository, which is what every case
 *  below that is not about the catalog assumes. */
let repositoryCatalog: RepositoryCatalogSnapshot;

beforeEach(async () => {
  db = await createTestDb();
  dbState.db = db;
  repositoryCatalog = await loadRepositoryCatalogSnapshot();
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
  providerReports = openPullRequest();
  mockStart.mockReset().mockResolvedValue({ runId: "run-pr" });
  mockCancelSubjectRun.mockReset().mockResolvedValue(true);
  mockGetEnabled.mockReset();
  mockGetVersion.mockReset().mockResolvedValue(null);
  loggerMock.info.mockClear();
  announceMock.mockReset().mockResolvedValue(undefined);
  testEnv.GITHUB_BOT_LOGIN = "github-app[bot]";
  testEnv.GITLAB_BOT_LOGIN = "gitlab-bot";
  botLoginReadable.value = true;
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
      schema: "v2",
      definition: {
        schemaVersion: 2,
        ...(repositoryScope ? { repositoryScope } : {}),
        nodes: [{
          id: "trigger",
          type: triggerType,
          x: 0,
          y: 0,
          configuration: params,
          inputs: {},
          additionalInputs: [],
        }],
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

/** Put one repository in the catalog and switch the catalog on, then read the
 *  snapshot back the way an entry point would. */
async function activatedCatalogWith(
  entries: ReadonlyArray<{ provider: "github" | "gitlab"; path: string; enabled: boolean }>,
): Promise<RepositoryCatalogSnapshot> {
  for (const entry of entries) {
    const saved = await upsertRepositoryProfile(db, {
      provider: entry.provider,
      path: entry.path,
      description: "",
      rules: "",
      relationships: [],
      scriptGroups: { provider: entry.provider, repoPath: entry.path, groups: {} },
      gateGroups: null,
      actorId: "user-1",
      actorLabel: "Ada",
      reason: "",
      enabled: entry.enabled,
    });
    if (!entry.enabled) await setRepositoryEnabled(db, { id: saved.id, enabled: false });
  }
  await activateRepositoryCatalog(db, { actorId: "user-1", reason: "the bridge is over" });
  return loadRepositoryCatalogSnapshot();
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    runRegistry: registry,
    maxConcurrentAgents: 3,
    repositoryCatalog,
    ...(!("getCurrentHead" in overrides) && !("getCurrentPullRequest" in overrides)
      ? {
          // What the case declared (`providerReports`), read afresh on every
          // call. How two handles compare is the provider's own code.
          getCurrentPullRequest: vi.fn(async () => structuredClone(providerReports)),
        }
      : {}),
    issueTracker: { fetchTicket: vi.fn().mockResolvedValue({ identifier: "AIW-1" }) },
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

  // What the adapters throw when the provider refuses for good (see
  // `getPRHead` in both VCS integrations): a GitLab group webhook reports every
  // project in the group, including ones the token may not read. Answering that
  // as a failure would have the provider redeliver it, and GitLab switch the
  // webhook off after a few.
  it("ignores for good a pull request the provider says this connection cannot read", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(
        event(),
        deps({ getCurrentHead: vi.fn().mockRejectedValue(new PullRequestUnreadableError("403 Forbidden")) }),
      ),
    ).resolves.toEqual({ result: "ignored_pull_request_unreadable" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("closes an accepted delivery whose pull request stopped being readable", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    const getCurrentHead = vi
      .fn()
      .mockResolvedValueOnce("abc123")
      .mockRejectedValue(new PullRequestUnreadableError("404 Not Found"));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(event(), deps({ getCurrentHead }))).resolves.toEqual({
      result: "ignored_pull_request_unreadable",
    });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toMatchObject({
      pending: false,
      result: { result: "ignored_pull_request_unreadable" },
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
    expect(mockStart.mock.calls[0]?.[0]).toBe("agentWorkflow_sentinel");
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

  it("answers a workflow-owned delivery terminally when no issue tracker is connected", async () => {
    // Disconnecting or disabling the tracker is an admin's choice, not a
    // fault. A retryable answer would have the provider redeliver every such
    // delivery, and GitLab turn the webhook off after a few, so every other
    // trigger on it would stop too. The tracker is resolved for real here, on
    // a deployment whose settings are readable and connect none.
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

    await expect(
      dispatchTriggerEvent(event(), deps({ issueTracker: undefined })),
    ).resolves.toEqual({
      result: "ignored_issue_tracker_unavailable",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getTriggerDelivery(db, "github", "delivery-1")).resolves.toBeNull();
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

  // The gap the live gate alone leaves open: an event accepted while the
  // repository was enabled sits in the inbox until the deployment has room, and
  // the tick that finally drains it must ask the catalog again rather than
  // dispatching on an answer given before somebody flipped the switch.
  it("drops a pending event whose repository the catalog disabled while it waited", async () => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }, "trigger_pr_created"));
    mockStart.mockResolvedValueOnce({ runId: "run-1" });
    const { dispatchTriggerEvent, drainOldestPendingTrigger } = await import(
      "./dispatch-trigger.js"
    );
    const subjectKey = "pr:github:acme/app#7";

    await dispatchTriggerEvent(event(), deps());
    const first = (await listPendingTriggersForSubject(db, subjectKey))[0]!;
    expect(await acknowledgeStartedTriggerDelivery(db, first, "run-1")).toBe(true);
    await expect(
      dispatchTriggerEvent(
        event({ delivery: { provider: "github", producer: "bob", deliveryId: "delivery-2" } }),
        deps(),
      ),
    ).resolves.toEqual({ result: "coalesced" });
    const owner = await registry.get(subjectKey);
    expect(await registry.release(subjectKey, owner!.ownerToken, "run-1")).toBe(true);

    const disabled = await activatedCatalogWith([
      { provider: "github", path: "acme/app", enabled: false },
    ]);
    await expect(
      drainOldestPendingTrigger(subjectKey, deps({ repositoryCatalog: disabled })),
    ).resolves.toBeNull();

    // No second run, nothing left pending, and the inbox says why rather than
    // leaving a row an operator cannot tell from a provider mismatch.
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(await listPendingTriggersForSubject(db, subjectKey)).toHaveLength(0);
    const stored = await getTriggerDelivery(db, "github", "delivery-2");
    expect(stored?.result).toEqual({ result: "ignored_repository_not_enabled" });
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", repoPath: "acme/app" }),
      "trigger_repo_not_enabled_in_catalog",
    );
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

  it("dispatches an any-scope PR whose repository the activated catalog enables", async () => {
    const repositoryCatalog = await activatedCatalogWith([
      { provider: "github", path: "Acme/App", enabled: true },
    ]);
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }, "trigger_pr_created"));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(event(), deps({ repositoryCatalog })),
    ).resolves.toEqual({ result: "started", runId: "run-pr" });
  });

  it("ignores an any-scope PR whose repository the activated catalog has disabled", async () => {
    const repositoryCatalog = await activatedCatalogWith([
      { provider: "github", path: "acme/app", enabled: false },
    ]);
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }, "trigger_pr_created"));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    // Its own outcome, not ignored_provider: the inbox has to distinguish "no
    // definition wanted this provider" from "an operator can enable this row".
    await expect(
      dispatchTriggerEvent(event(), deps({ repositoryCatalog })),
    ).resolves.toEqual({ result: "ignored_repository_not_enabled" });
    expect(mockStart).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github", repoPath: "acme/app" }),
      "trigger_repo_not_enabled_in_catalog",
    );
  });

  // The pin used to be a grant. Since the catalog decides, it selects INSIDE the
  // catalog: a definition that pins a repository nobody enabled reaches nothing.
  it("does not let a definition pin reach a repository the catalog leaves disabled", async () => {
    const repositoryCatalog = await activatedCatalogWith([
      { provider: "github", path: "acme/app", enabled: false },
      { provider: "github", path: "acme/other", enabled: true },
    ]);
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any" }, "trigger_pr_created", {
        repositories: [{ provider: "github", repoPath: "Acme/App" }],
      }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(event(), deps({ repositoryCatalog })),
    ).resolves.toEqual({ result: "ignored_repository_not_enabled" });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(db.select().from(triggerDeliveries)).resolves.toEqual([]);
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

  it("honours a custom trust list a check trigger was published with before S10", async () => {
    // The deployed graph reaches dispatch through the one reader of a stored
    // row, as trigger routing hands it over (that routing does upgrade it is
    // proved in `engine/definition-trigger-routing.test.ts`). Here: the
    // per-provider list this node was saved with is what decides trust, so a
    // non-default app is trusted and the provider's default runner, which the
    // list left out, is not.
    const { parseStoredWorkflowDefinition } = await import(
      "../../engine/definition/stored-definition.js"
    );
    const stored = enabled(
      {
        scope: "any",
        checkNames: ["ci / build"],
        githubAppSlugs: ["circleci"],
        gitlabPipelineSources: ["merge_request_event"],
      },
      "trigger_pr_checks_failed",
    );
    mockGetEnabled.mockResolvedValue({
      ...stored,
      current: {
        ...stored.current,
        ...parseStoredWorkflowDefinition(stored.current.definition),
      },
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    providerReportsFailed({
      name: "ci / build",
      conclusion: "failure",
      handle: { id: 101, owner: "ci" } as never,
    });
    const failedCheck = (producer: string, deliveryId: string) =>
      event({
        delivery: { provider: "github", producer, deliveryId },
        triggerType: "trigger_pr_checks_failed",
        pr: {
          ...event().pr,
          failedChecks: [
            { name: "ci / build", conclusion: "failure", handle: { id: 101, owner: "ci" } },
          ],
        },
      });

    await expect(
      dispatchTriggerEvent(failedCheck("github-actions", "ci-default"), deps()),
    ).resolves.toEqual({ result: "ignored_untrusted_event" });
    await expect(getTriggerDelivery(db, "github", "ci-default")).resolves.toBeNull();
    await expect(
      dispatchTriggerEvent(failedCheck("circleci", "ci-custom"), deps()),
    ).resolves.toEqual({ result: "started", runId: "run-pr" });
  });
});

/**
 * A "commented" review may start a run only while the automation account is
 * known. The workflow comments on every pull request it works on, and without
 * its login those comments read as a person's, so it would start a run off its
 * own comment and answer itself.
 */
describe("a commented review and the automation account", () => {
  function commentedReview(deliveryId: string): TriggerEvent {
    return event({
      delivery: { provider: "github", producer: "carol", deliveryId },
      triggerType: "trigger_pr_review",
      pr: {
        ...event().pr,
        review: { state: "commented", author: "carol", body: "please rename this" },
      },
    });
  }

  it("is dropped when the provider's bot login is not configured, saying so", async () => {
    // Its own word rather than the untrusted-producer one: naming the bot
    // login is what the operator reading the provider's log has to do.
    testEnv.GITHUB_BOT_LOGIN = undefined;
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any", on: ["changes_requested", "commented"] }, "trigger_pr_review"),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(commentedReview("rv-no-bot"), deps())).resolves.toEqual({
      result: "ignored_bot_login_unknown",
    });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts a run once the bot login is known", async () => {
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any", on: ["changes_requested", "commented"] }, "trigger_pr_review"),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(dispatchTriggerEvent(commentedReview("rv-bot"), deps())).resolves.toEqual({
      result: "started",
      runId: "run-pr",
    });
  });

  it("answers retryably when the bot login could not be read at all", async () => {
    botLoginReadable.value = false;
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any", on: ["changes_requested", "commented"] }, "trigger_pr_review"),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(commentedReview("rv-unreadable"), deps()),
    ).resolves.toMatchObject({ result: "error", diagnosticId: expect.any(String) });
    expect(mockStart).not.toHaveBeenCalled();
    await expect(getTriggerDelivery(db, "github", "rv-unreadable")).resolves.toBeNull();
  });

  // The webhook route reads the account once per delivery and hands that
  // reading down; dispatch reading its own again would cost a second settings
  // read per event and could disagree with the first.
  it("decides on the reading its caller hands it instead of reading its own", async () => {
    botLoginReadable.value = false;
    mockGetEnabled.mockResolvedValue(
      enabled({ scope: "any", on: ["changes_requested", "commented"] }, "trigger_pr_review"),
    );
    const { readVcsBotLogin } = await import("../vcs/index.js");
    vi.mocked(readVcsBotLogin).mockClear();
    const readBotLogin = vi.fn(async () => ({ readable: true as const, login: "github-app[bot]" }));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(commentedReview("rv-handed"), deps({ readBotLogin })),
    ).resolves.toEqual({ result: "started", runId: "run-pr" });
    expect(readBotLogin).toHaveBeenCalledExactlyOnceWith("github");
    expect(readVcsBotLogin).not.toHaveBeenCalled();
  });

  it("keeps a changes-requested review eligible without a bot login", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");
    const review = event({
      triggerType: "trigger_pr_review",
      pr: {
        ...event().pr,
        review: { state: "changes_requested", author: "carol", body: "blocking" },
      },
    });

    expect(
      selectEligibleEvent(review, { on: ["changes_requested", "commented"] }, undefined),
    ).not.toBeNull();
    expect(
      selectEligibleEvent(commentedReview("unit"), { on: ["commented"] }, undefined),
    ).toBeNull();
  });
});

describe("PR trigger rate limit", () => {
  function pinnedWithTriggerParams(params: Record<string, unknown>) {
    return {
      definitionId: 5,
      version: 12,
      schema: "v2",
      definition: {
        schemaVersion: 2,
        nodes: [
          {
            id: "trigger",
            type: "trigger_pr_created",
            x: 0,
            y: 0,
            configuration: params,
            inputs: {},
            additionalInputs: [],
          },
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
      result: "rate_limited",
    });

    expect(mockStart).toHaveBeenCalledOnce();
    await expect(getTriggerDelivery(db, "github", "delivery-2")).resolves.toMatchObject({
      pending: false,
      result: { result: "rate_limited" },
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

  it("uses the node's own rate-limit params", async () => {
    mockGetEnabled.mockResolvedValue(enabled());
    mockGetVersion.mockResolvedValue(
      pinnedWithTriggerParams({ rateLimitMax: 1, rateLimitWindow: "day" }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await dispatchTriggerEvent(event(), deps());
    await expect(dispatchTriggerEvent(secondEvent(), deps())).resolves.toEqual({
      result: "rate_limited",
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
      delivery: {
        provider: "github",
        producer,
        deliveryId: "ci-1",
        ...(producer === "github-actions" ? { trustedByDefault: true } : {}),
      },
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

  it("keeps the pre-field default trust for a recorded GitHub Actions event", async () => {
    const { selectEligibleEvent } = await import("./dispatch-trigger.js");
    const recorded = checksEvent();
    delete recorded.delivery.trustedByDefault;

    expect(selectEligibleEvent(recorded, {})?.pr.failedChecks).toEqual(failing);
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
    // GitLab still reports the pipeline every delivery below names as failed.
    providerReportsFailed({
      name: "pipeline",
      conclusion: "failed",
      handle: { kind: "aggregate", id: 31 } as never,
    });
  });

  function checksEvent(deliveryId: string): TriggerEvent {
    return event({
      delivery: {
        provider: "gitlab",
        producer: "gitlab-ci",
        source: "merge_request_event",
        deliveryId,
        trustedByDefault: true,
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        provider: "gitlab",
        prUrl: "https://gitlab.com/acme/app/-/merge_requests/7",
        failedChecks: [
          { name: "pipeline", conclusion: "failed", handle: { kind: "aggregate", id: 31 } },
        ],
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
      result: "autofix_cap_reached",
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
      result: { result: "autofix_cap_reached" },
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
        schema: "v2",
        definition: {
          schemaVersion: 2,
          nodes: [
            {
              id: "loose",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              configuration: { scope: "any", maxFixAttemptsPerPr: 5 },
              inputs: {},
              additionalInputs: [],
            },
            {
              id: "tight",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              configuration: { scope: "any", maxFixAttemptsPerPr: 1 },
              inputs: {},
              additionalInputs: [],
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
      result: "autofix_cap_reached",
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
        schema: "v2",
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
      result: "autofix_cap_reached",
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
      result: "autofix_cap_reached",
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
      result: "autofix_cap_reached",
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
      result: "autofix_cap_reached",
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
        schema: "v2",
        definition: {
          schemaVersion: 2,
          nodes: [
            {
              id: "checks",
              type: "trigger_pr_checks_failed",
              x: 0,
              y: 0,
              configuration: { scope: "any", maxFixAttemptsPerPr: 1 },
              inputs: {},
              additionalInputs: [],
            },
            {
              id: "review",
              type: "trigger_pr_review",
              x: 0,
              y: 0,
              configuration: { scope: "any", on: ["commented"] },
              inputs: {},
              additionalInputs: [],
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

/**
 * Binding a failed check through the path production takes: dispatch asks the
 * lazy repository runtime for the merge request's head and the provider for
 * how its handles compare, and the real GitLab integration answers both. The
 * other cases here hand dispatch a provider state and a comparison of their
 * own, which is how a comparison that answered "same" for everything stayed
 * invisible to them.
 */
/**
 * A failed check starts a fix only while the provider still reports that same
 * check failed. The delivery says what failed when it was sent; by the time it
 * is dispatched the check may have been re-run (a new check run, a new handle),
 * be running again, or have gone green, and a fix started from the stale
 * delivery works on a failure that no longer exists. Handles are compared by
 * GitHub's own identity (`integrations/github/handles.ts`), reached through the
 * registry the way production reaches it.
 */
describe("binding a failed check to what the provider reports now", () => {
  const build = { name: "ci / build", conclusion: "failure" } as const;
  const lint = { name: "lint", conclusion: "failure" } as const;

  function failedChecks(...checks: Array<{ name: string; conclusion: string; id: number }>) {
    return event({
      delivery: { provider: "github", producer: "github-actions", deliveryId: "check-1" },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        failedChecks: checks.map(({ id, name, conclusion }) => ({
          name,
          conclusion,
          handle: { id, owner: "github-actions" } as never,
        })),
      },
    });
  }

  /** A check the provider reports, with a handle it minted itself. */
  function reported(check: { name: string; conclusion: string }, id: number): PullRequestFailedCheck {
    return { ...check, handle: { id, owner: "github-actions" } as never };
  }

  beforeEach(() => {
    mockGetEnabled.mockResolvedValue(enabled({ scope: "any" }, "trigger_pr_checks_failed"));
  });

  it("starts a fix for only the delivered checks the provider still reports failed", async () => {
    // Lint was re-run and passed after the delivery; build still fails.
    providerReportsFailed(reported(build, 101));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(failedChecks({ ...build, id: 101 }, { ...lint, id: 202 }), deps()),
    ).resolves.toEqual({ result: "started", runId: "run-pr" });
    expect(mockStart.mock.calls[0]?.[1]?.[0]?.pr.failedChecks).toEqual([
      { ...build, handle: { id: 101, owner: "github-actions" } },
    ]);
  });

  it("drops a failure whose check was re-run and failed again as a new check run", async () => {
    // Same name, same conclusion, a different check run: the re-run's own
    // failure arrives as its own delivery, and this one names a run that is gone.
    providerReportsFailed(reported(build, 102));
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(failedChecks({ ...build, id: 101 }), deps()),
    ).resolves.toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("drops a failure while its check is running again", async () => {
    providerReports = openPullRequest({ state: "running", failed: [] });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(failedChecks({ ...build, id: 101 }), deps()),
    ).resolves.toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("drops a failure once the provider reports the head green", async () => {
    providerReports = openPullRequest({ state: "green", failed: [] });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(failedChecks({ ...build, id: 101 }), deps()),
    ).resolves.toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("binding a failed pipeline through the production version control path", () => {
  const sourceHead = "5f2d4c1e9a7b3d6f8e0c2a4b6d8f0e1c3a5b7d9f";

  beforeEach(() => {
    gitlabProvider.connected = true;
    // GitLab's REST API as the real client calls it: the merge request, then
    // the jobs of its head pipeline. Anything else is a request this path was
    // not expected to make.
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
      const refusal = gitlabProvider.refusal;
      if (refusal && path.endsWith("/merge_requests/7")) {
        return new Response(JSON.stringify(refusal.body), {
          status: refusal.status,
          headers: { "content-type": "application/json" },
        });
      }
      const body = path.endsWith("/merge_requests/7")
        ? gitlabProvider.mergeRequest
        : /\/pipelines\/\d+\/jobs$/u.test(path)
          ? gitlabProvider.jobs
          : undefined;
      if (body === undefined) return new Response("unexpected request", { status: 500 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    let starts = 0;
    mockStart.mockImplementation(async () => ({ runId: `run-${++starts}` }));
    const definition = enabled({ scope: "any" }, "trigger_pr_checks_failed");
    mockGetEnabled.mockResolvedValue(definition);
    mockGetVersion.mockResolvedValue(definition.current);
  });

  afterEach(() => {
    gitlabProvider.connected = false;
    gitlabProvider.refusal = undefined;
    vi.unstubAllGlobals();
  });

  /** The merge request as GitLab reports it now: its head pipeline, failed,
   *  with a job of the same name as the one the delivery named. */
  function headPipeline(id: number, failedJobId: number) {
    gitlabProvider.mergeRequest = {
      diff_refs: { head_sha: sourceHead },
      source_branch: "feature/owned",
      target_branch: "main",
      state: "opened",
      head_pipeline: { id, status: "failed" },
    };
    gitlabProvider.jobs = [{ id: failedJobId, name: "test-build", status: "failed" }];
  }

  function failedPipeline(
    deliveryId: string,
    pr: Partial<TriggerEvent["pr"]> & Record<string, unknown>,
  ): TriggerEvent {
    return event({
      delivery: {
        provider: "gitlab",
        producer: "gitlab-ci",
        source: "merge_request_event",
        deliveryId,
        trustedByDefault: true,
      },
      triggerType: "trigger_pr_checks_failed",
      pr: {
        ...event().pr,
        provider: "gitlab",
        prUrl: "https://gitlab.com/acme/app/-/merge_requests/7",
        headSha: "",
        ...pr,
      } as TriggerEvent["pr"],
    });
  }

  /** As the webhook writes it today: the job's handle names its pipeline. */
  const deliveredFromPipeline31 = (deliveryId: string) =>
    failedPipeline(deliveryId, {
      failedChecks: [
        {
          name: "test-build",
          conclusion: "failed",
          handle: { kind: "job", container: 31, id: 378 } as never,
        },
      ],
    });

  /** As main's webhook wrote it, still stored when this build deploys. */
  const recordedByMainFromPipeline31 = (deliveryId: string) =>
    failedPipeline(deliveryId, {
      pipelineId: 31,
      failedChecks: [{ name: "test-build", conclusion: "failed" }],
    });

  const provider = () => deps({ getCurrentPullRequest: undefined });

  it("starts a fix for the pipeline that is still the merge request's failed head", async () => {
    headPipeline(31, 378);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(deliveredFromPipeline31("gl-current"), provider()),
    ).resolves.toEqual({ result: "started", runId: "run-1" });
  });

  it("drops a failed pipeline once a newer pipeline is the merge request's head", async () => {
    // Pipeline 32 failed a job of the same name. Without the pipeline in the
    // handle deciding it, the fix would start for a failure nobody delivered.
    headPipeline(32, 400);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(deliveredFromPipeline31("gl-superseded"), provider()),
    ).resolves.toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("answers unreachable, with a diagnostic, when GitLab does not answer before the webhook's deadline", async () => {
    // The read happens before the trigger is saved. Bounded only per attempt,
    // a GitLab that kept failing slowly outlived the invocation, and the
    // delivery left nothing behind: no answer, no diagnostic, nothing to retry.
    vi.stubGlobal(
      "fetch",
      (_target: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const started = Date.now();

    const result = await dispatchTriggerEvent(deliveredFromPipeline31("gl-never-answers"), {
      ...provider(),
      lifetime: AbortSignal.timeout(200),
    });

    expect(result).toEqual({ result: "error", diagnosticId: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts a fix from an envelope main recorded, while its pipeline is the head", async () => {
    headPipeline(31, 378);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(recordedByMainFromPipeline31("gl-legacy-current"), provider()),
    ).resolves.toEqual({ result: "started", runId: "run-1" });
  });

  /** A fix running for the merge request, and a second failure queued behind
   *  it, waiting for the subject to be free. */
  async function queueBehindARunningFix(queuedDeliveryId: string) {
    headPipeline(31, 378);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");
    const subjectKey = prSubjectKey("gitlab", "acme/app", 7);
    await expect(
      dispatchTriggerEvent(deliveredFromPipeline31("gl-running"), provider()),
    ).resolves.toEqual({ result: "started", runId: "run-1" });
    const running = (await listPendingTriggersForSubject(db, subjectKey))[0]!;
    expect(await acknowledgeStartedTriggerDelivery(db, running, "run-1")).toBe(true);
    await expect(
      dispatchTriggerEvent(deliveredFromPipeline31(queuedDeliveryId), provider()),
    ).resolves.toEqual({ result: "coalesced" });
    const owner = await registry.get(subjectKey);
    expect(await registry.release(subjectKey, owner!.ownerToken, "run-1")).toBe(true);
    return subjectKey;
  }

  // A token GitLab stopped accepting refuses every merge request. Fixing the
  // connection makes the same work possible again, so the queued failure has
  // to survive the refusal rather than be closed as unreadable.
  it("keeps a queued failure through a refused token and starts it once the token works", async () => {
    const subjectKey = await queueBehindARunningFix("gl-queued");
    const { drainOldestPendingTrigger } = await import("./dispatch-trigger.js");

    gitlabProvider.refusal = { status: 401, body: { message: "401 Unauthorized" } };
    await expect(drainOldestPendingTrigger(subjectKey, provider())).resolves.toMatchObject({
      result: "error",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    expect(await listPendingTriggersForSubject(db, subjectKey)).toHaveLength(1);
    await expect(getTriggerDelivery(db, "gitlab", "gl-queued")).resolves.toMatchObject({
      pending: true,
      result: { result: "error" },
    });

    gitlabProvider.refusal = undefined;
    await expect(drainOldestPendingTrigger(subjectKey, provider())).resolves.toEqual({
      result: "started",
      runId: "run-2",
    });
  });

  // GitLab's documented answer for a token without the scope (REST
  // authentication docs): refuses every merge request, so the queued failure
  // waits for the connection rather than being closed.
  it("keeps a queued failure through a token without the scope, as GitLab answers it", async () => {
    const subjectKey = await queueBehindARunningFix("gl-queued-scope");
    const { drainOldestPendingTrigger } = await import("./dispatch-trigger.js");

    gitlabProvider.refusal = {
      status: 403,
      body: {
        error: "insufficient_scope",
        error_description: "The request requires higher privileges than provided by the access token.",
        scope: "api read_api",
      },
    };
    await expect(drainOldestPendingTrigger(subjectKey, provider())).resolves.toMatchObject({
      result: "error",
    });
    expect(await listPendingTriggersForSubject(db, subjectKey)).toHaveLength(1);

    gitlabProvider.refusal = undefined;
    await expect(drainOldestPendingTrigger(subjectKey, provider())).resolves.toEqual({
      result: "started",
      runId: "run-2",
    });
  });

  // A delivery not yet accepted, whose read the token was refused on. The
  // refusal lasts until somebody rotates the token, so it is answered as a
  // fault the health row shows, never as a failure GitLab would count towards
  // switching the webhook off. Nothing is written for it.
  it("answers a delivery read with a refused token as a credential fault", async () => {
    headPipeline(31, 378);
    gitlabProvider.refusal = { status: 401, body: { message: "401 Unauthorized" } };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(deliveredFromPipeline31("gl-refused-token"), provider()),
    ).resolves.toEqual({
      result: "vcs_credential_refused",
      diagnosticId: expect.stringMatching(/^AIW-DIAG-ingest-/),
    });
    await expect(getTriggerDelivery(db, "gitlab", "gl-refused-token")).resolves.toBeNull();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("answers a GitLab that did not answer as a failure to redeliver", async () => {
    headPipeline(31, 378);
    gitlabProvider.refusal = { status: 502, body: { message: "502 Bad Gateway" } };
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(deliveredFromPipeline31("gl-outage"), provider()),
    ).resolves.toMatchObject({ result: "error" });
  });

  it("closes a queued failure whose merge request this token can no longer read", async () => {
    const subjectKey = await queueBehindARunningFix("gl-queued-gone");
    const { drainOldestPendingTrigger } = await import("./dispatch-trigger.js");

    gitlabProvider.refusal = { status: 404, body: { message: "404 Not found" } };
    await expect(drainOldestPendingTrigger(subjectKey, provider())).resolves.toBeNull();
    expect(await listPendingTriggersForSubject(db, subjectKey)).toHaveLength(0);
    await expect(getTriggerDelivery(db, "gitlab", "gl-queued-gone")).resolves.toMatchObject({
      pending: false,
      result: { result: "ignored_pull_request_unreadable" },
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("drops an envelope main recorded once a newer pipeline is the head", async () => {
    headPipeline(32, 400);
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    await expect(
      dispatchTriggerEvent(recordedByMainFromPipeline31("gl-legacy-superseded"), provider()),
    ).resolves.toEqual({ result: "ignored_stale_head" });
    expect(mockStart).not.toHaveBeenCalled();
  });
});
