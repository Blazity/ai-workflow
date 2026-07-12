import { vi } from "vitest";
import type {
  WorkflowBlockType,
  WorkflowDefinitionNode,
  WorkflowParamValue,
} from "@shared/contracts";
import type { PrTriggerPayload } from "../agent-input.js";
import type { EngineCtx } from "./types.js";

/** Build a definition node for executor tests. */
export function makeNode(
  type: WorkflowBlockType,
  params: Record<string, WorkflowParamValue> = {},
  id = "blk",
): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params };
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
    entry: { kind: "ticket", ticketKey: "AWT-1" },
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
    recordUsage: vi.fn(),
    markLaunched: vi.fn(),
    unregisterBeforePr: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
