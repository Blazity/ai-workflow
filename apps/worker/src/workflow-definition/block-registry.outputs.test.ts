import { describe, expect, it } from "vitest";
import type { BlockOutput, WorkflowBlockType } from "@shared/contracts";
import {
  buildWorkflowBlockRegistry,
  resolveWorkflowBlockContract,
  validateBlockOutputAgainstContract,
  type WorkflowBlockRegistryContext,
} from "./block-registry.js";

const context: WorkflowBlockRegistryContext = {
  agentProviders: { claude: true, codex: true },
  llmProviders: { claude: true, codex: true },
  defaultAgent: { provider: "claude", model: "claude-test" },
  vcsProviders: ["github", "gitlab"],
  slackConfigured: true,
  arthurConfigured: true,
};

const pr = {
  ticketKey: "AIW-1",
  provider: "github",
  repoPath: "Blazity/ai-workflow",
  prNumber: 118,
  prUrl: "https://github.test/pr/118",
  headRef: "ai-workflow/AIW-1",
  headSha: "abc123",
  baseRef: "main",
  title: "Workflows",
  author: "blazebot",
  isDraft: false,
};

/** Representative outputs copied from current executors. When a later ticket
 * changes an executor, it must intentionally update this table and the registry
 * contract together. */
const CURRENT_EXECUTOR_OUTPUTS: Record<WorkflowBlockType, BlockOutput[]> = {
  trigger_ticket_ai: [{ status: "fired", ticketKey: "AIW-1" }],
  trigger_plan_approved: [
    {
      status: "fired",
      ticketKey: "AIW-1",
      approvedPlan: "Implement it",
      approver: "user-1",
      approvedAt: "2026-07-17T12:00:00.000Z",
    },
  ],
  trigger_pr_created: [{ status: "fired", ...pr }],
  trigger_pr_checks_failed: [
    {
      status: "fired",
      ...pr,
      failedChecks: [{ name: "test", conclusion: "failure", detailsUrl: "https://ci.test" }],
    },
  ],
  trigger_pr_review: [
    {
      status: "fired",
      ...pr,
      review: { state: "changes_requested", author: "reviewer", body: "Please fix" },
    },
  ],
  planning_agent: [
    { status: "ready", plan: "Plan" },
    {
      status: "needs_human_input",
      questions: ["Which environment?"],
      suggestedAnswers: ["staging", "production"],
    },
    { status: "failed" },
  ],
  implementation_agent: [
    { status: "implemented" },
    { status: "needs_human_input", questions: ["Which option?"] },
    { status: "failed" },
  ],
  review_agent: [{ status: "ok", feedback: "Looks good" }, { status: "failed" }],
  fix_agent: [
    {
      status: "fixed",
      workspaceId: "sb_1",
      commits: [{ provider: "github", repoPath: "Blazity/ai-workflow", sha: "abc123" }],
      resolvedConflicts: [],
      unresolvedConflicts: [],
      summary: "Fixed the review",
    },
    {
      status: "needs_human_input",
      workspaceId: "sb_1",
      commits: [],
      resolvedConflicts: [],
      unresolvedConflicts: [],
      questions: ["Resolve which side?"],
    },
    { status: "failed" },
  ],
  generic_agent: [
    { status: "ok", body: "Done" },
    { status: "needs_human_input", questions: ["Clarify"] },
    { status: "failed" },
  ],
  prepare_workspace: [
    {
      status: "ok",
      sandboxId: "sb_1",
      repositories: ["github:Blazity/ai-workflow"],
      workspace: { id: "sb_1", repositories: ["github:Blazity/ai-workflow"] },
    },
    { status: "needs_human_input", questions: ["Which repository?"] },
    { status: "failed" },
  ],
  finalize_workspace: [
    {
      status: "published",
      prs: [
        {
          provider: "github",
          repoPath: "Blazity/ai-workflow",
          id: 118,
          url: "https://github.test/pr/118",
          isNew: true,
        },
      ],
    },
    { status: "failed", unmetChecks: ["checks"] },
    { status: "failed" },
  ],
  run_pre_pr_checks: [
    { status: "ok", ok: true, fixCycles: 0, summary: "Passed" },
    { status: "failed", ok: false, fixCycles: 3, summary: "Still failing" },
    { status: "failed" },
  ],
  run_checks: [
    { status: "ok", ok: false, results: [], failures: [] },
    { status: "failed" },
  ],
  call_llm: [{ status: "ok", output: "answer" }, { status: "failed" }],
  fetch_pr_context: [
    {
      status: "ok",
      contexts: [
        {
          repository: "github:Blazity/ai-workflow",
          prCommentCount: 1,
          checkResults: [{ name: "test", conclusion: "failure" }],
          hasConflicts: false,
        },
      ],
    },
    { status: "failed" },
  ],
  open_pr: [
    { status: "ok", prUrl: "https://github.test/pr/118", prNumber: 118 },
    { status: "failed" },
  ],
  update_ticket_status: [{ status: "ok", target: "ai_review" }],
  post_ticket_comment: [
    { status: "ok", commentUrl: "https://jira.test/comment/1" },
    { status: "ok", commentUrl: null },
    { status: "failed" },
  ],
  post_pr_comment: [
    { status: "ok", comments: [{ provider: "github", repoPath: "Blazity/ai-workflow", id: 1 }] },
    { status: "failed", comments: [] },
    { status: "failed" },
  ],
  send_slack_message: [{ status: "ok" }, { status: "skipped" }],
  send_plan_approval: [
    { status: "awaiting_approval", approvalRequestId: "approval-1" },
    { status: "failed" },
  ],
  human_question: [
    { status: "needs_human_input", questions: ["Choose one"], suggestedAnswers: ["A"] },
    { status: "failed" },
  ],
  arthur_injection_check: [
    { status: "ok", findings: [] },
    { status: "flagged", findings: [{ rule: "injection", result: "fail" }] },
    { status: "skipped", reason: "arthur_not_configured" },
  ],
  branch: [
    { status: "ok", path: "true", reason: "steps.checks.output.ok" },
    { status: "failed", error: "Missing step output" },
  ],
  loop: [{ status: "ok", attempt: 1 }, { status: "exhausted", attempt: 3 }],
  terminate: [
    { status: "waiting_for_human" },
    { status: "failed" },
    { status: "skipped" },
    { status: "done" },
  ],
};

describe("workflow registry current executor output parity", () => {
  it("accepts every representative output from every current block executor", () => {
    const registry = buildWorkflowBlockRegistry(context);
    for (const [type, outputs] of Object.entries(CURRENT_EXECUTOR_OUTPUTS) as Array<
      [WorkflowBlockType, BlockOutput[]]
    >) {
      for (const output of outputs) {
        expect(
          validateBlockOutputAgainstContract(registry[type], output),
          `${type}: ${JSON.stringify(output)}`,
        ).toEqual([]);
      }
    }
  });

  it("validates current custom-schema success and failure envelopes", () => {
    for (const type of ["generic_agent", "call_llm"] as const) {
      const contract = resolveWorkflowBlockContract(
        type,
        {
          prompt: "work",
          outputSchema:
            '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"],"additionalProperties":false}',
        },
        context,
      );
      const output: BlockOutput =
        type === "generic_agent"
          ? { status: "ok", data: { answer: 42 } }
          : { status: "ok", output: { answer: 42 } };
      expect(validateBlockOutputAgainstContract(contract, output)).toEqual([]);
      expect(validateBlockOutputAgainstContract(contract, { status: "failed" })).toEqual([]);
    }
  });

  it("reports status, nested schema, and undeclared-property mismatches", () => {
    const contract = resolveWorkflowBlockContract(
      "call_llm",
      {
        prompt: "work",
        outputSchema:
          '{"type":"object","properties":{"answer":{"type":"number"}},"required":["answer"],"additionalProperties":false}',
      },
      context,
    );

    expect(
      validateBlockOutputAgainstContract(contract, {
        status: "unexpected",
        output: { answer: "not a number", extra: true },
      }),
    ).toEqual([
      "output.status must be one of: ok, failed.",
      "output.output.answer must be a number.",
      "output.output.extra is not declared by the contract.",
    ]);
  });
});
