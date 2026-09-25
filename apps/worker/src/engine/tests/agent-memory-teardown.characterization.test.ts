/**
 * CHARACTERIZATION: the memory gates inside `agentWorkflow`, the part of the
 * run the memory steps cannot see: when teardown captures the notebook, when
 * it distils, what it hands the distill, how long it lets it take, and how the
 * prompt compiler reads what recall answered. 6a and 6b change the call sites;
 * the tests named after them are rewritten then.
 *
 * The harness is the one `send-message-run.test.ts` established: the steps
 * around the executor are mocked, the executor and the scheduler are real, and
 * a fake `finalize_workspace` block stands in for everything that would put a
 * workspace and a publication on the run context. The memory steps themselves
 * are recorders, so what is asserted is exactly what the workflow asked of
 * them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkflowInput } from "../agent-input.js";

const memory = vi.hoisted(() => ({
  persist: vi.fn(),
  distill: vi.fn(),
  load: vi.fn(),
  teardown: vi.fn(async () => undefined),
}));
/** What the fake finalize block does to the run context, per case. */
const scenario = vi.hoisted(() => ({
  onFinalize: (_ctx: Record<string, unknown>): unknown => ({ kind: "next", output: { status: "finalized", repositories: [] } }),
  settings: [] as Array<{ key: string; value: unknown }>,
  budgets: undefined as undefined | { maxDurationMs: number },
  /** Budget clock: `start` until the fake block says the run is late. */
  clock: { start: 1_000, late: null as number | null, isLate: false },
  harnessNodes: [] as string[],
  compiled: [] as unknown[],
}));
const graph = vi.hoisted(() => ({
  nodes: [] as Array<Record<string, unknown>>,
  edges: [] as Array<Record<string, unknown>>,
}));

vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  createHook: vi.fn(),
  getWorkflowMetadata: () => ({ workflowRunId: "run-memory-teardown" }),
}));
vi.mock("../../infra/vcs-config.js", () => ({
  env: { COLUMN_AI: "AI", COLUMN_AI_REVIEW: "AI Review", COLUMN_BACKLOG: "Backlog", JIRA_BASE_URL: "https://jira.example" },
  getConfiguredVcsProviders: vi.fn(),
}));
vi.mock("../steps/run-ownership-steps.js", () => ({
  bindWorkflowCandidateStep: vi.fn(async () => true),
  acknowledgeManualDispatchStep: vi.fn(async () => undefined),
  acknowledgeApprovalDispatchStep: vi.fn(async () => undefined),
  acknowledgePrTriggerDispatchStep: vi.fn(async () => true),
  acknowledgeWebhookDispatchStep: vi.fn(async () => true),
  acknowledgeScheduleDispatchStep: vi.fn(async () => true),
  acknowledgePendingTriggerStep: vi.fn(async () => undefined),
}));
vi.mock("../steps/prompts-step.js", () => ({ loadPrompts: vi.fn(async () => ({})) }));
vi.mock("../steps/definition-step.js", () => ({
  loadWorkflowDefinitionFor: vi.fn(async () => ({
    definition: { schemaVersion: 2, nodes: graph.nodes, edges: graph.edges },
    version: 4,
    definitionId: 11,
    nodes: graph.nodes.map((node) => ({ id: node.id, type: node.type, params: node.configuration })),
    edges: graph.edges,
    reviewEnabled: false,
    integrationPins: [],
    ...(scenario.budgets ? { budgets: scenario.budgets } : {}),
  })),
}));
vi.mock("../../db/client.js", () => ({ getDb: () => ({}) }));
vi.mock("../../services/integrations/runtime.js", async (importOriginal) => ({
  checkIntegrationPin: (await importOriginal<typeof import("../../services/integrations/runtime.js")>())
    .checkIntegrationPin,
  resolveUsableIntegrations: vi.fn(async () => ({ readable: true, usable: [], states: new Map() })),
  knownSecretValues: async () => [],
}));
vi.mock("../definition/harness-profile-runtime.js", async () => {
  const { makeHarnessRuntime } = await import("../blocks/support/test-support.js");
  return {
    resolveConnectedHarnessRuntimesForDefinition: async () =>
      Object.fromEntries(scenario.harnessNodes.map((id) => [id, makeHarnessRuntime(id, "generic_agent", { workspaceMode: "none" })])),
  };
});
vi.mock("../../db/repositories/settings.js", () => ({
  readAllConnectedSettings: async () =>
    scenario.settings.map((row) => ({ ...row, updatedAt: new Date(0), updatedBy: "test" })),
}));
vi.mock("../../db/repositories/work-scope.js", () => ({
  readConnectedWorkScopeFacts: async () => ({
    scope: null,
    selectionAnswered: false,
    answeredRepositoryKeys: [],
    narrowingAnswered: false,
    answeredQuestion: null,
  }),
}));
vi.mock("../../db/repositories/repository-catalog.js", () => ({
  getConnectedRepositoryCatalogStateRow: async () => ({
    activated: true,
    activatedAt: "2026-09-12T00:00:00.000Z",
    activatedById: "user_admin",
    activatedByLabel: "Ada",
  }),
  listConnectedRepositoryCatalogKeys: async () => [{ provider: "github", path: "acme/api", enabled: true }],
}));
vi.mock("../steps/workflow-ticket.js", () => ({
  resolveWorkflowTicketStep: vi.fn(async (input: AgentWorkflowInput) => ({
    id: input.ticketKey ?? input.subjectKey,
    identifier: input.ticketKey ?? input.subjectKey,
    title: "Something to do",
    description: "",
    acceptanceCriteria: "",
    comments: [],
    labels: [],
    trackerStatus: "AI",
    attachments: [],
  })),
}));
vi.mock("../../engine/support/adapters.js", () => ({
  createAdapters: () => ({
    issueTrackerResolution: {
      ok: true,
      adapter: {
        postComment: vi.fn(async () => {}),
        fetchTicket: vi.fn(async (id: string) => ({
          id,
          identifier: id,
          title: "Something to do",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          labels: [],
          trackerStatus: "AI",
          attachments: [],
        })),
        moveTicket: vi.fn(async () => {}),
        updateLabels: vi.fn(async () => {}),
      },
    },
    messaging: { notifyForTicket: vi.fn(async () => ({ delivered: true })) },
  }),
}));
vi.mock("../blocks/executors.generated.js", () => ({
  BLOCK_EXECUTORS: {
    finalize_workspace: async (_node: unknown, _steps: unknown, ctx: Record<string, unknown>) =>
      scenario.onFinalize(ctx),
    generic_agent: async (
      _node: unknown,
      _steps: unknown,
      ctx: Record<string, unknown>,
      _inputs: unknown,
      execution: { compileInvocationPrompt: (input: unknown) => Promise<unknown> },
    ) => {
      scenario.compiled.push(
        await execution.compileInvocationPrompt({
          blockPrompt: "Do the work.",
          runtimeData: [],
          sandboxId: ctx.sandboxId,
        }),
      );
      return { kind: "next", output: { status: "completed", body: "done" } };
    },
  },
}));
vi.mock("../steps/memory-steps.js", () => ({
  persistWorkspaceMemoryStep: memory.persist,
  hydrateWorkspaceMemoryStep: vi.fn(),
}));
vi.mock("../steps/repo-memory-steps.js", () => ({
  distillRepoMemoryStep: memory.distill,
  loadRepoMemorySourcesStep: memory.load,
  captureDefaultBranchFilesStep: vi.fn(),
}));
vi.mock("../steps/sandbox-poll-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../steps/sandbox-poll-agent.js")>()),
  teardownSandboxes: memory.teardown,
}));
vi.mock("../steps/phase.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../steps/phase.js")>()),
  readRunBudgetClockStep: async () =>
    scenario.clock.isLate && scenario.clock.late !== null ? scenario.clock.late : scenario.clock.start,
}));
vi.mock("../steps/repository-instructions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../steps/repository-instructions.js")>()),
  shouldLoadRepositoryInstructionSources: () => false,
}));
vi.mock("../../db/repositories/active-runs.js", () => ({
  assertActiveRunOwner: vi.fn(async () => {}),
  assertConnectedActiveRunOwner: vi.fn(async () => {}),
  assertActiveRunOwnerState: vi.fn(async () => {}),
}));
vi.mock("../../db/repositories/runs/telemetry.js", () => ({
  markRunFailedOnSelfMove: vi.fn(async () => undefined),
  markRunSucceededOnSelfMove: vi.fn(),
  recordBlockStatuses: vi.fn(),
  recordRunStatusReason: vi.fn(async () => undefined),
  recordRunUsage: vi.fn(async () => undefined),
  recordConnectedRunUsage: vi.fn(async () => undefined),
  recordConnectedBlockStatuses: vi.fn(),
  recordConnectedRunStatusReason: vi.fn(async () => undefined),
  markConnectedRunFailedOnSelfMove: vi.fn(async () => undefined),
  markConnectedRunSucceededOnSelfMove: vi.fn(),
}));
vi.mock("../../run-analysis/persistence.js", () => ({
  finalizeRunAnalysisUsage: vi.fn(async () => undefined),
  finalizeConnectedRunAnalysisUsage: vi.fn(async () => undefined),
}));
vi.mock("workflow/runtime", () => ({ getWorld: () => ({}) }));
vi.mock("../../engine/support/collect-run-detail.js", () => ({
  captureRunStepsBestEffort: vi.fn(async () => []),
  sanitizeRunStepsForDiagnosticError: (_steps: unknown, executionError: unknown) => ({ executionError }),
}));
vi.mock("../../infra/logger.js", () => {
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  return { logger };
});

const { agentWorkflow } = await import("../agent-workflow.js");

const entry: AgentWorkflowInput = {
  kind: "ticket",
  subjectKey: "ticket:jira:AIW-903",
  ticketKey: "AIW-903",
  ownerToken: "owner:memory-teardown",
  continuation: { kind: "clarification", clarificationRequestId: "clar-903" },
  definitionId: 11,
  definitionVersion: 4,
};

function node(id: string, type: string, configuration: Record<string, unknown> = {}) {
  return { id, type, x: 0, y: 0, configuration, inputs: {}, additionalInputs: [] };
}

function repository(repoPath: string, access: "read" | "write") {
  return {
    provider: "github",
    repoPath,
    slug: repoPath.replace("/", "__"),
    localPath: `/vercel/sandbox/repos/${repoPath.replace("/", "__")}`,
    defaultBranch: "main",
    branchName: "ai/aiw-903",
    selectedRationale: "primary",
    access,
  };
}

/** Two repositories the run may write, one it may only read. */
const MANIFEST = {
  version: 2,
  repositories: [repository("acme/api", "write"), repository("acme/web", "write"), repository("acme/docs", "read")],
};

/** What prepare_workspace and finalize_workspace leave on a run that shipped. */
function shippedRun(ctx: Record<string, unknown>, options: { publication?: unknown; recalled?: boolean } = {}) {
  ctx.sandboxId = "sbx-903";
  (ctx.sandboxIds as Set<string>).add("sbx-903");
  ctx.workspaceManifest = MANIFEST;
  if (options.recalled !== undefined) ctx.workspaceNotebookRecalled = options.recalled;
  ctx.defaultBranchFiles = {
    "github:acme/api": ["README.md", "src/index.ts"],
    "github:acme/web": [],
    "github:acme/docs": ["index.md"],
  };
  ctx.changeSummary = "Moved the billing webhook handler.";
  ctx.publication = options.publication === undefined ? { status: "published", repositories: [], prs: [] } : options.publication;
}

const REPO_MEMORY_ON = { key: "ENABLE_REPO_MEMORY", value: true };
const PROMOTION_ON = { key: "ENABLE_ORG_MEMORY_PROMOTION", value: true };

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  graph.nodes = [node("trigger", "trigger_ticket_ai"), node("finalize", "finalize_workspace")];
  graph.edges = [{ id: "e1", from: "trigger", to: "finalize" }];
  scenario.settings = [REPO_MEMORY_ON];
  scenario.budgets = undefined;
  scenario.clock = { start: 1_000, late: null, isLate: false };
  scenario.harnessNodes = [];
  scenario.compiled = [];
  scenario.onFinalize = (ctx) => {
    shippedRun(ctx);
    return { kind: "next", output: { status: "finalized", repositories: [] } };
  };
  memory.persist.mockResolvedValue({ persisted: true });
  memory.distill.mockResolvedValue({ written: 1, usage: null, providerCalled: false, skipped: null });
  memory.load.mockResolvedValue({ sources: [] });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("teardown: the notebook capture", () => {
  it("captures the notebook on a failed run too, carrying hydration's recalled flag, and does not distil", async () => {
    scenario.onFinalize = (ctx) => {
      shippedRun(ctx, { recalled: false });
      return { kind: "error", error: { message: "finalize broke", category: "engine" } };
    };

    await agentWorkflow(entry).catch(() => undefined);

    expect(memory.persist).toHaveBeenCalledTimes(1);
    expect(memory.persist).toHaveBeenCalledWith({
      sandboxId: "sbx-903",
      subjectKey: "ticket:jira:AIW-903",
      ticketKey: "AIW-903",
      taskId: "AIW-903",
      workspaceManifest: MANIFEST,
      runId: "run-memory-teardown",
      notebookRecalled: false,
    });
    expect(memory.distill).not.toHaveBeenCalled();
    // Captured before the sandboxes that hold the notebook are torn down.
    expect(memory.persist.mock.invocationCallOrder[0]).toBeLessThan(memory.teardown.mock.invocationCallOrder[0]!);
  });

  it("leaves the recalled flag out when hydration never set it, and captures nothing without a sandbox", async () => {
    await agentWorkflow(entry);
    expect(memory.persist.mock.calls[0]?.[0]).not.toHaveProperty("notebookRecalled");

    vi.clearAllMocks();
    scenario.onFinalize = () => ({ kind: "next", output: { status: "finalized", repositories: [] } });
    await agentWorkflow(entry);
    expect(memory.persist).not.toHaveBeenCalled();
  });

  it("changes in 6a: reports a refused, withheld or absent capture only to console.error, against the run id", async () => {
    memory.persist.mockResolvedValue({
      persisted: false,
      unavailable: "Mem0 did not answer",
      withheld: "the stored notebook was kept",
      absent: "the agent left no notebook",
    });

    await agentWorkflow(entry);

    const reported = consoleError.mock.calls.filter((call) => String(call[0]).startsWith("memory_capture_"));
    expect(reported).toEqual([
      ["memory_capture_unavailable", "run-memory-teardown", "ticket:jira:AIW-903", "Mem0 did not answer"],
      ["memory_capture_withheld", "run-memory-teardown", "ticket:jira:AIW-903", "the stored notebook was kept"],
      ["memory_capture_absent", "run-memory-teardown", "ticket:jira:AIW-903", "the agent left no notebook"],
    ]);
  });
});

describe("teardown: when the distill runs", () => {
  it("distils a successful, published run after the sandboxes are torn down", async () => {
    await agentWorkflow(entry);

    expect(memory.distill).toHaveBeenCalledTimes(1);
    expect(memory.teardown.mock.invocationCallOrder[0]).toBeLessThan(memory.distill.mock.invocationCallOrder[0]!);
  });

  it("distils a finalized run as well as a published one", async () => {
    scenario.onFinalize = (ctx) => {
      shippedRun(ctx, { publication: { status: "finalized", repositories: [], prs: [] } });
      return { kind: "next", output: { status: "finalized", repositories: [] } };
    };

    await agentWorkflow(entry);

    expect(memory.distill).toHaveBeenCalledTimes(1);
  });

  it("does not distil a successful run that published nothing, or any run with repository memory off", async () => {
    scenario.onFinalize = (ctx) => {
      shippedRun(ctx, { publication: null });
      return { kind: "next", output: { status: "finalized", repositories: [] } };
    };
    await agentWorkflow(entry);
    expect(memory.distill).not.toHaveBeenCalled();
    expect(memory.persist).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    scenario.onFinalize = (ctx) => {
      shippedRun(ctx);
      return { kind: "next", output: { status: "finalized", repositories: [] } };
    };
    scenario.settings = [];
    await agentWorkflow(entry);
    expect(memory.distill).not.toHaveBeenCalled();
    expect(memory.persist).toHaveBeenCalledTimes(1);
  });

  it("does not distil once the run's duration budget is spent, and still captures the notebook", async () => {
    // A 50 s budget and a clock that reads exactly 50 s elapsed after the
    // block: every boundary passes, and the distill's check, which needs time
    // left, does not.
    scenario.budgets = { maxDurationMs: 50_000 };
    scenario.clock.late = 51_000;
    scenario.onFinalize = (ctx) => {
      shippedRun(ctx);
      scenario.clock.isLate = true;
      return { kind: "next", output: { status: "finalized", repositories: [] } };
    };

    await agentWorkflow(entry);

    expect(memory.distill).not.toHaveBeenCalled();
    expect(memory.persist).toHaveBeenCalledTimes(1);
  });
});

describe("teardown: what the distill is given", () => {
  it("hands it only the repositories the run could write, each with its default-branch listing when one was captured", async () => {
    scenario.settings = [REPO_MEMORY_ON, PROMOTION_ON];

    await agentWorkflow(entry);

    const input = memory.distill.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      runId: "run-memory-teardown",
      promoteOrgMemory: true,
      subjectKey: "ticket:jira:AIW-903",
      taskId: "AIW-903",
      changeSummary: "Moved the billing webhook handler.",
    });
    expect(input.repositories).toEqual([
      { provider: "github", repoPath: "acme/api", defaultBranchFiles: ["README.md", "src/index.ts"] },
      { provider: "github", repoPath: "acme/web" },
    ]);
  });

  it("changes in 6b: pins current bug: never hands the distill the review notes it declares", async () => {
    await agentWorkflow(entry);

    expect(memory.distill.mock.calls[0]?.[0]).not.toHaveProperty("reviewNotes");
  });

  it("passes the organisation switch as the run froze it, off when unset", async () => {
    await agentWorkflow(entry);

    expect(memory.distill.mock.calls[0]?.[0]).toMatchObject({ promoteOrgMemory: false });
  });

  it("clamps the distill's timeout to 90 s however much budget is left", async () => {
    await agentWorkflow(entry);

    expect(memory.distill.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 90_000 });
  });

  it("gives the distill the whole milliseconds left when that is under 90 s", async () => {
    // 50 s budget, 37654.25 ms elapsed: 12345.75 ms left, floored.
    scenario.budgets = { maxDurationMs: 50_000 };
    scenario.clock.late = 38_654.25;
    scenario.onFinalize = (ctx) => {
      shippedRun(ctx);
      scenario.clock.isLate = true;
      return { kind: "next", output: { status: "finalized", repositories: [] } };
    };

    await agentWorkflow(entry);

    expect(memory.distill.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 12_345 });
  });

  it("changes in 6a: reports a distill memory refusal only to console.error, against the run id", async () => {
    memory.distill.mockResolvedValue({
      written: 0,
      usage: null,
      providerCalled: false,
      skipped: "memory_unavailable",
      unavailable: "Mem0 is failing",
    });

    await agentWorkflow(entry);

    expect(consoleError).toHaveBeenCalledWith(
      "memory_distill_unavailable",
      "run-memory-teardown",
      "ticket:jira:AIW-903",
      "Mem0 is failing",
    );
  });
});

describe("the prompt compiler's read of recall", () => {
  function agentRun() {
    graph.nodes = [
      node("trigger", "trigger_ticket_ai"),
      node("finalize", "finalize_workspace"),
      node("agent", "generic_agent", { prompt: "Do the work.", workspaceMode: "none" }),
    ];
    graph.edges = [
      { id: "e1", from: "trigger", to: "finalize" },
      { id: "e2", from: "finalize", to: "agent" },
    ];
    scenario.harnessNodes = ["agent"];
  }

  /** The one prompt the agent block compiled, which must have compiled. */
  function compiledPrompt(): string {
    expect(scenario.compiled).toHaveLength(1);
    const [result] = scenario.compiled as Array<{ ok: boolean; compilation?: { prompt: string } }>;
    expect(result?.ok).toBe(true);
    return result?.compilation?.prompt ?? "";
  }

  it("reads a bare array, the result shape recorded before S13, as the memory sources themselves", async () => {
    agentRun();
    memory.load.mockResolvedValue([{ repository: "acme/api", docPath: "facts", content: "- Uses pnpm 9 (bare)" }]);

    await agentWorkflow(entry);

    expect(memory.load).toHaveBeenCalledWith({
      repositories: [
        { provider: "github", repoPath: "acme/api" },
        { provider: "github", repoPath: "acme/web" },
        { provider: "github", repoPath: "acme/docs" },
      ],
    });
    expect(compiledPrompt()).toContain("- Uses pnpm 9 (bare)");
  });

  it("reads the sources off the current result shape", async () => {
    agentRun();
    memory.load.mockResolvedValue({
      sources: [{ repository: "acme/api", docPath: "facts", content: "- Uses pnpm 9 (object)" }],
    });

    await agentWorkflow(entry);

    expect(compiledPrompt()).toContain("- Uses pnpm 9 (object)");
  });

  it("reads no memory into the prompt with repository memory off", async () => {
    agentRun();
    scenario.settings = [];

    await agentWorkflow(entry);

    expect(memory.load).not.toHaveBeenCalled();
    expect(compiledPrompt()).not.toContain("Uses pnpm 9");
  });
});
