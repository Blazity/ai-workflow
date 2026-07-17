import { expect, vi } from "vitest";
import type {
  BlockOutput,
  WorkflowBlockType,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import {
  resolveWorkflowBlockContract,
  validateBlockOutputAgainstContract,
  type WorkflowBlockRegistryContext,
} from "../../workflow-definition/block-registry.js";
import type { PrTriggerPayload } from "../agent-input.js";
import type { EngineCtx } from "./types.js";

const registryContext: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-model" },
  vcsProviders: ["github", "gitlab"],
  vcsBotIdentities: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
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
  type: WorkflowBlockType,
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

/** Build an EngineCtx with vi.fn() callbacks for executor tests. */
export function makeCtx(overrides: Partial<EngineCtx> = {}): EngineCtx {
  return {
    runId: "run-1",
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
    branchName: "blazebot/awt-1",
    sandboxId: "sbx-1",
    workspaceManifest: null,
    agentSandboxIds: {},
    sandboxIds: new Set<string>(),
    selectedRepositories: [],
    repositoryContexts: [],
    preSandboxAdditions: { research: [], implementation: [], review: [] },
    researchPlanMarkdown: "",
    publication: null,
    runDefaultKind: "claude",
    defaults: { claude: "claude-model", codex: "codex-model" },
    prompts: { research: "r", implement: "i", review: "v" },
    moveTargets: { backlog: "Backlog", aiReview: "AI Review" },
    arthur: { taskId: null },
    observeBudget: vi.fn().mockResolvedValue({
      check: { status: "ok" },
      remainingDurationMs: 30 * 60_000,
    }),
    recordUsage: vi.fn(),
    markLaunched: vi.fn(),
    ...overrides,
  };
}
