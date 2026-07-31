import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionNode } from "@shared/contracts";
import {
  safeReplayAgentProtocolMetadata,
  safeWorkflowExecutionLogEvent,
} from "./safe-execution-log.js";
import {
  buildRuntimeGraph,
  executeGraph,
  executionError,
  type BlockExecutionResult,
  type ExecuteGraphHooks,
  type WorkflowExecutionLogEvent,
} from "../workflow-definition/interpreter.js";

/**
 * The production detail whose cause used to exist nowhere: the customer-facing
 * message keeps a bounded snippet of it, and until this record was added the
 * runtime logs carried only that same truncated snippet.
 */
const GIT_CLONE_403_DETAIL =
  "github:Blazity/ai-workflow-prod: canonical clone failed: " +
  "Cloning into '/vercel/sandbox/publisher/0'...\n" +
  "fatal: unable to access 'https://github.com/Blazity/ai-workflow-prod.git/': " +
  "The requested URL returned error: 403";

function node(id: string, type: WorkflowDefinitionNode["type"]): WorkflowDefinitionNode {
  return { id, type, x: 0, y: 0, params: {}, inputs: {} };
}

/**
 * Drives the real V1 engine with exactly the wiring agent.ts uses for the
 * logger step, so the count below is the number of log records a run really
 * emits, not the number a hand-rolled mock chose to emit.
 */
async function recordsFromRun(blockResult: BlockExecutionResult): Promise<{
  records: WorkflowExecutionLogEvent[];
  outcome: string;
}> {
  const records: WorkflowExecutionLogEvent[] = [];
  const hooks: ExecuteGraphHooks = {
    onExecutionError: async (event) => {
      records.push(safeWorkflowExecutionLogEvent(event));
    },
    async onBlockStart() {},
    async onBlockFinish() {},
    async clarificationExit() {},
    async failureExit() {},
    async terminate() {},
  };
  const result = await executeGraph({
    runId: "wrun_01KYSFRC85YWWMD6WH2FQG0C30",
    graph: buildRuntimeGraph({
      nodes: [node("trigger", "trigger_ticket_ai"), node("open-pr-finalize", "finalize_workspace")],
      edges: [{ from: "trigger", to: "open-pr-finalize" }],
    }),
    entryTriggerId: "trigger",
    triggerOutput: { status: "ok" },
    executeBlock: async (block) =>
      block.id === "open-pr-finalize"
        ? blockResult
        : { kind: "next", output: { status: "ok" } },
    hooks,
    outputValidator: () => [],
  });
  return { records, outcome: result.outcome };
}

describe("safeWorkflowExecutionLogEvent", () => {
  it("keeps correlation metadata and a redacted detail, drops provider tails", () => {
    const safe = safeWorkflowExecutionLogEvent({
      diagnosticId: "AIW-DIAG-run-agent-1",
      nodeId: "agent",
      attempt: 1,
      category: "provider",
      phase: "implementation",
      detail: "raw provider detail with sk-ant-api03-abcDEF1234567890_-secret-value",
      agentProtocol: {
        provider: "codex",
        packageName: "@openai/codex",
        cliVersion: "1.2.3",
        protocol: "jsonl",
        phase: "implementation",
        failureKind: "provider_error",
        exitCode: 1,
        stdoutTail: "stdout secret-value",
        stderrTail: "stderr secret-value",
        detail: "diagnostic secret-value",
        schema: {
          identity: "result",
          sha256: "abc",
          issues: [
            {
              path: "/secret-value",
              code: "invalid",
              message: "secret-value",
            },
          ],
        },
      },
    });

    expect(safe).toEqual({
      diagnosticId: "AIW-DIAG-run-agent-1",
      nodeId: "agent",
      attempt: 1,
      category: "provider",
      phase: "implementation",
      detail: "raw provider detail with [redacted]",
      agentProtocol: {
        provider: "codex",
        packageName: "@openai/codex",
        cliVersion: "1.2.3",
        protocol: "jsonl",
        phase: "implementation",
        failureKind: "provider_error",
        exitCode: 1,
      },
    });
    expect(JSON.stringify(safe)).not.toContain("sk-ant-api03");
    // The provider-controlled tails, nested detail and schema issues stay out.
    expect(JSON.stringify(safe)).not.toContain("secret-value");
  });

  it("omits detail entirely when the failure carried none", () => {
    const safe = safeWorkflowExecutionLogEvent({
      diagnosticId: "AIW-DIAG-run-agent-1",
      nodeId: "agent",
      attempt: 1,
      category: "engine",
    });
    expect(safe).not.toHaveProperty("detail");
  });

  it("keeps artifact byte counts but omits raw-output fingerprints from replay metadata", () => {
    const safe = safeReplayAgentProtocolMetadata({
      provider: "codex",
      packageName: "@openai/codex",
      cliVersion: "1.2.3",
      protocol: "jsonl",
      phase: "implementation",
      failureKind: "provider_error",
      exitCode: 1,
      artifacts: {
        stdoutBytes: 100,
        stderrBytes: 200,
        structuredOutputBytes: 300,
        stdoutSha256: "stdout-secret-fingerprint",
        stderrSha256: "stderr-secret-fingerprint",
        structuredOutputSha256: "structured-secret-fingerprint",
      },
    });

    expect(safe).toEqual({
      provider: "codex",
      packageName: "@openai/codex",
      cliVersion: "1.2.3",
      protocol: "jsonl",
      phase: "implementation",
      failureKind: "provider_error",
      exitCode: 1,
      artifacts: {
        stdoutBytes: 100,
        stderrBytes: 200,
        structuredOutputBytes: 300,
      },
    });
    expect(JSON.stringify(safe)).not.toContain("Sha256");
    expect(JSON.stringify(safe)).not.toContain("secret-fingerprint");
  });
});

describe("the full-detail failure record", () => {
  it("is emitted exactly once for a failed block, carrying the whole cause", async () => {
    const { records } = await recordsFromRun(
      executionError(GIT_CLONE_403_DETAIL, { category: "provider", phase: "publish" }),
    );

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.diagnosticId).toBe(
      "AIW-DIAG-wrun_01KYSFRC85YWWMD6WH2FQG0C30-open-pr-finalize-1",
    );
    // Everything the capped customer-facing snippet had to drop.
    expect(record.detail).toContain("Cloning into '/vercel/sandbox/publisher/0'...");
    expect(record.detail).toContain("fatal: unable to access");
    expect(record.detail).toContain("The requested URL returned error: 403");
  });

  it("is not emitted for a run where every block succeeded", async () => {
    const { records, outcome } = await recordsFromRun({
      kind: "next",
      output: { status: "ok" },
    });

    expect(outcome).toBe("completed");
    expect(records).toEqual([]);
  });
});
