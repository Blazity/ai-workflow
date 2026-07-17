import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RunRegistryAdapter } from "../adapters/run-registry/types.js";
import type { TriggerEvent } from "./trigger-events.js";

vi.mock("../../env.js", () => ({
  env: { JIRA_PROJECT_KEY: "AIW", COLUMN_AI: "AI" },
}));

const mockStart = vi.fn();
const mockGetRun = vi.fn();
vi.mock("workflow/api", () => ({
  start: (...args: any[]) => mockStart(...args),
  getRun: (...args: any[]) => mockGetRun(...args),
}));

vi.mock("../workflows/agent.js", () => ({
  agentWorkflow: "agentWorkflow_sentinel",
}));

const mockStopTicketSandboxes = vi.fn();
vi.mock("../sandbox/stop-ticket-sandboxes.js", () => ({
  stopTicketSandboxes: (...args: any[]) => mockStopTicketSandboxes(...args),
}));

const mockGetEnabled = vi.fn();
vi.mock("../workflow-definition/store.js", () => ({
  getEnabledWorkflowDefinitionForTrigger: (...args: any[]) => mockGetEnabled(...args),
}));

function makeRegistry(
  overrides: Partial<Record<keyof RunRegistryAdapter, ReturnType<typeof vi.fn>>> = {},
): RunRegistryAdapter {
  let claimedValue: string | undefined;
  return {
    claim:
      overrides.claim ??
      vi.fn().mockImplementation(async (_key: string, value: string) => {
        claimedValue = value;
        return true;
      }),
    register: overrides.register ?? vi.fn().mockResolvedValue(undefined),
    unregister: overrides.unregister ?? vi.fn().mockResolvedValue(undefined),
    unregisterIfRunId: vi.fn().mockResolvedValue(undefined),
    getRunId: overrides.getRunId ?? vi.fn().mockImplementation(async () => claimedValue),
    listAll: overrides.listAll ?? vi.fn().mockResolvedValue([]),
    registerSandbox: vi.fn().mockResolvedValue(undefined),
    getSandboxId: vi.fn().mockResolvedValue(null),
    getEntryCreatedAt: vi.fn().mockResolvedValue(null),
    markFailed: vi.fn().mockResolvedValue(undefined),
    isTicketFailed: vi.fn().mockResolvedValue(false),
    listAllFailed: vi.fn().mockResolvedValue([]),
    clearFailedMark: vi.fn().mockResolvedValue(undefined),
  };
}

function makeEnabledDefinition(params: Record<string, unknown> = {}) {
  return {
    definition: { id: 5, name: "PR flow" },
    current: {
      definitionId: 5,
      version: 12,
      definition: {
        schemaVersion: 1,
        nodes: [
          {
            id: "t1",
            type: "trigger_pr_created",
            x: 0,
            y: 0,
            params,
          },
        ],
        edges: [],
      },
    },
  };
}

function prEvent(headRef = "blazebot/aiw-1"): TriggerEvent {
  return {
    triggerType: "trigger_pr_created",
    pr: {
      provider: "github",
      repoPath: "acme/app",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      headRef,
      headSha: "abc123",
      baseRef: "main",
      title: "Fix",
      author: "blazebot[bot]",
      isDraft: false,
    },
  };
}

describe("dispatchTriggerEvent", () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockGetRun.mockReset();
    mockGetEnabled.mockReset();
    mockStopTicketSandboxes.mockReset();
    mockStart.mockResolvedValue({ runId: "run_pr" });
    mockStopTicketSandboxes.mockResolvedValue(0);
  });

  it("returns no_definition when no enabled definition matches the trigger", async () => {
    mockGetEnabled.mockResolvedValue(null);
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "no_definition" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("ignores a PR on a non-blazebot branch", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition());
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent("feature/foo"), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "ignored_not_workflow_owned" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("coalesces when the ticket is already claimed", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition());
    const registry = makeRegistry({ claim: vi.fn().mockResolvedValue(false) });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "coalesced" });
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("returns at_capacity when the run registry is full", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition());
    const registry = makeRegistry({
      listAll: vi.fn().mockResolvedValue([
        { ticketKey: "AIW-1", runId: "run_a", kind: "ticket" },
        { ticketKey: "AIW-2", runId: "run_b", kind: "ticket" },
        { ticketKey: "AIW-3", runId: "run_c", kind: "ticket" },
      ]),
    });
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "at_capacity" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("starts the agent workflow and registers with kind pr_trigger", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition());
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const evt = prEvent();
    const result = await dispatchTriggerEvent(evt, {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "started", runId: "run_pr" });
    expect(registry.claim).toHaveBeenCalledWith(
      "AIW-1",
      expect.stringMatching(/^claiming:\d+$/),
      "pr_trigger",
    );
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      {
        kind: "pr_trigger",
        triggerType: "trigger_pr_created",
        ticketKey: "AIW-1",
        definitionId: 5,
        definitionVersion: 12,
        pr: evt.pr,
      },
    ]);
    expect(registry.register).toHaveBeenCalledWith("AIW-1", "run_pr", "pr_trigger");
  });

  it("ignores an event whose provider is not in the configured providers list", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition({ providers: ["gitlab"] }));
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    // prEvent() has provider "github", which is excluded by the gitlab-only list.
    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "ignored_provider" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("dispatches when the event provider is in the configured providers list", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition({ providers: ["github", "gitlab"] }));
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent(), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "started", runId: "run_pr" });
  });

  it("enforces workflow-owned by default: ignores a non-blazebot branch", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition({ onlyWorkflowOwned: true }));
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent("feature/x"), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "ignored_not_workflow_owned" });
    expect(registry.claim).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("allows a non-workflow-owned PR under a synthetic key when onlyWorkflowOwned is false", async () => {
    mockGetEnabled.mockResolvedValue(makeEnabledDefinition({ onlyWorkflowOwned: false }));
    const registry = makeRegistry();
    const { dispatchTriggerEvent } = await import("./dispatch-trigger.js");

    const result = await dispatchTriggerEvent(prEvent("feature/x"), {
      db: {} as any,
      runRegistry: registry,
      maxConcurrentAgents: 3,
    });

    expect(result).toEqual({ result: "started", runId: "run_pr" });
    // Non-workflow-owned PRs have no ticket key, so the run is keyed by PR identity.
    expect(registry.claim).toHaveBeenCalledWith(
      "pr:github:acme/app:7",
      expect.stringMatching(/^claiming:\d+$/),
      "pr_trigger",
    );
    expect(mockStart).toHaveBeenCalledWith("agentWorkflow_sentinel", [
      expect.objectContaining({ kind: "pr_trigger", ticketKey: "pr:github:acme/app:7" }),
    ]);
  });
});
