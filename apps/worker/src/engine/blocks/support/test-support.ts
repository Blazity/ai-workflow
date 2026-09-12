import { expect, vi } from "vitest";
import type {
  BlockOutput,
  HarnessProfileManifestV1,
  HarnessProvider,
  SettingsSnapshot,
  WorkflowBlockType,
  WorkflowBlockTypeV1,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import { resolveSettingsSnapshot } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/harness";
import { validateBlockOutputAgainstContract } from "../../definition/block-registry.js";
import {
  resolveWorkflowBlockContract,
  type WorkflowBlockRegistryContext,
} from "../../definition/block-contract-resolver.js";
import { hashHarnessProfileManifest } from "../../../harness-profiles/manifest.js";
import {
  resolveHarnessRuntime,
  type ResolvedHarnessRuntime,
} from "../../../sandbox/harness-runtime.js";
import type { PrTriggerPayload } from "../../agent-input.js";
import type { BlockInvocationContext, EngineCtx } from "./types.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-model" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
  webhookTriggerConfigured: true,
};

/** Keep an executor assertion coupled to the editor-visible registry contract. */
export function expectOutputConformsToRegistry(
  type: WorkflowBlockType,
  output: BlockOutput,
  params: Record<string, WorkflowParamValue> = {},
): void {
  const contract = resolveWorkflowBlockContract(type, params, registryContext);
  expect(validateBlockOutputAgainstContract(contract, output), type).toEqual([]);
}

/** Build a definition node for executor tests. */
export function makeNode(
  type: WorkflowBlockTypeV1,
  params: Record<string, WorkflowParamValue> = {},
  id = "blk",
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params, inputs: {} };
}

/** Build a PR trigger payload for executor tests. */
export function makePrPayload(overrides: Partial<PrTriggerPayload> = {}): PrTriggerPayload {
  return {
    provider: "github",
    repoPath: "acme/api",
    prNumber: 7,
    prUrl: "https://github.com/acme/api/pull/7",
    headRef: "blazebot/awt-1",
    headSha: "abc123",
    baseRef: "main",
    title: "Fix API",
    author: "octocat",
    isDraft: false,
    ...overrides,
  };
}

/** Build a verified persisted-profile runtime for v2 block executor tests. */
export function makeHarnessRuntime(
  nodeId: string,
  nodeType: WorkflowBlockType,
  options: {
    provider?: HarnessProvider;
    model?: string;
    limits?: HarnessProfileManifestV1["limits"];
    preserveAcrossBlocks?: boolean;
    workspaceMode?: unknown;
  } = {},
): ResolvedHarnessRuntime {
  const provider = options.provider ?? "claude";
  const manifest: HarnessProfileManifestV1 = structuredClone(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[
      BUILTIN_HARNESS_PROFILE_IDS[provider]
    ],
  );
  manifest.model.id = options.model ?? `${provider}-model`;
  if (options.limits) {
    manifest.limits = structuredClone(options.limits);
  }
  if (options.preserveAcrossBlocks !== undefined) {
    manifest.workspace.preserveAcrossBlocks =
      options.preserveAcrossBlocks;
  }
  const manifestHash = hashHarnessProfileManifest(manifest);
  return resolveHarnessRuntime({
    nodeId,
    nodeType,
    workspaceMode: options.workspaceMode,
    resolved: { manifest, manifestHash, skillArtifacts: [] },
  });
}

/** Serialized shapes model errors crossing a Workflow step/VM boundary. */
export function runControlErrorCases(): Array<[string, Error]> {
  return [
    ["budget exhaustion", namedError("RunBudgetError", "budget exceeded")],
    [
      "exact-owner loss",
      namedError(
        "ActiveRunOwnerError",
        "Provider mutation requires the exact active run owner.",
      ),
    ],
    [
      "Workflow cancellation",
      namedError("WorkflowRunCancelledError", 'Workflow run "wrun-1" cancelled'),
    ],
  ];
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * The settings an executor test runs under: the registry's own defaults, so a
 * fixture never encodes a second opinion about what a key means. A test that is
 * about a setting overrides exactly the key it is about.
 */
export function makeRunSettings(
  overrides: Partial<SettingsSnapshot> = {},
): SettingsSnapshot {
  // Nothing stored and no environment resolves every key to its registry
  // default, through the same function the deployment resolves through.
  const defaults = resolveSettingsSnapshot(new Map(), {
    value: () => void 0,
    isSet: () => false,
  }).snapshot;
  return { ...defaults, ...overrides };
}

/** Build an EngineCtx with vi.fn() callbacks for executor tests. */
export function makeCtx(overrides: Partial<EngineCtx> = {}): EngineCtx {
  return {
    runId: "run-1",
    settings: makeRunSettings(),
    // The bridge: an executor test that is not about the catalog reaches every
    // repository, which is what a deployment that never opened Repositories does.
    repositories: { activated: false, enabledKeys: [] },
    definitionId: 1,
    definitionVersion: 1,
    definitionNodes: [],
    entry: {
      kind: "ticket",
      subjectKey: "ticket:jira:AWT-1",
      ticketKey: "AWT-1",
      ownerToken: "owner:test",
    },
    ticket: {
      id: "1",
      identifier: "AWT-1",
      title: "Ticket title",
      description: "Ticket description",
      acceptanceCriteria: "",
      comments: [],
      labels: [],
      trackerStatus: "AI",
      attachments: [],
    },
    ticketUrl: "https://jira.example.com/browse/AWT-1",
    changeSummary: "",
    branchName: "blazebot/awt-1",
    sandboxId: "sbx-1",
    workspaceManifest: null,
    agentSandboxIds: {},
    harnessRuntimes: {},
    sandboxIds: new Set<string>(),
    selectedRepositories: [],
    repositoryContexts: [],
    repositoryDiscovery: null,
    repositoryExpansion: { rounds: 0, priorRequests: [] },
    researchWriteRepositories: [],
    preSandboxAdditions: { research: [], implementation: [], review: [] },
    researchPlanMarkdown: "",
    analysisRevision: 0,
    publication: null,
    prePrGate: null,
    runDefaultKind: "claude",
    defaults: { claude: "claude-model", codex: "codex-model" },
    prompts: { research: "r", implement: "i", review: "v" },
    moveTargets: { backlog: "Backlog", aiReview: "AI Review" },
    arthur: { taskId: null },
    checksCeilingMs: null,
    prePrChecksFailureMessage: vi.fn().mockImplementation((error: unknown) =>
      Promise.resolve(error instanceof Error ? error.message : String(error)),
    ),
    observeBudget: vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 30 * 60_000,
    }),
    recordUsage: vi.fn(),
    markLaunched: vi.fn(),
    ...overrides,
  };
}

/**
 * The invocation context a block test hands an executor.
 *
 * Its budget defers to the EngineCtx the test built, which is exactly what an
 * absent invocation budget meant before stage 12-6b: `blockBudgetObserver` fell
 * back to `ctx.observeBudget`, and phase usage was recorded against no profile
 * limit. One helper rather than a literal per suite, so the next field the
 * context grows is supplied in one place; a test that is about the profile
 * budget passes its own `budget` through the overrides.
 */
export function makeInvocation(
  ctx: Pick<EngineCtx, "observeBudget">,
  overrides: Partial<BlockInvocationContext> = {},
): BlockInvocationContext {
  return {
    budget: {
      observeBudget: ctx.observeBudget,
      recordBudgetUsage: () => {},
    },
    ...overrides,
  };
}
