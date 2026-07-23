import { describe, expect, it } from "vitest";
import {
  safeReplayAgentProtocolMetadata,
  safeWorkflowExecutionLogEvent,
} from "./safe-execution-log.js";

describe("safeWorkflowExecutionLogEvent", () => {
  it("keeps correlation metadata and drops provider-controlled details and tails", () => {
    const safe = safeWorkflowExecutionLogEvent({
      diagnosticId: "AIW-DIAG-run-agent-1",
      nodeId: "agent",
      attempt: 1,
      category: "provider",
      phase: "implementation",
      detail: "raw provider detail with secret-value",
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
    expect(JSON.stringify(safe)).not.toContain("secret-value");
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
