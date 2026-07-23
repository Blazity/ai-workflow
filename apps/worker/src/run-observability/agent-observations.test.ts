import { describe, expect, it, vi } from "vitest";
import {
  emitAgentInvocationObservations,
  emitTimedOutAgentInvocationObservations,
} from "./agent-observations.js";

describe("emitAgentInvocationObservations", () => {
  it("emits provider log tails and safe execution metadata without structured output", async () => {
    const emit = vi.fn();
    await emitAgentInvocationObservations({
      observations: { emit },
      provider: "codex",
      model: "gpt-5",
      phase: "implementation",
      artifacts: {
        stdout: "provider stdout",
        stderr: "provider stderr",
        structuredOutput: '{"private":"model output"}',
        exitCode: 0,
      },
      usage: {
        cost_usd: null,
        tokens: { input: 10, cached_input: 2, output: 3 },
        duration_ms: 50,
        duration_api_ms: 40,
        num_turns: 1,
      },
      result: { ok: true, value: { result: "completed" } },
    });

    expect(emit).toHaveBeenCalledWith({
      kind: "log",
      value: { stream: "stdout", tail: "provider stdout" },
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "log",
      value: { stream: "stderr", tail: "provider stderr" },
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "metadata",
      value: expect.objectContaining({
        provider: "codex",
        model: "gpt-5",
        phase: "implementation",
        exitCode: 0,
        protocol: { outcome: "ok" },
      }),
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("model output");
  });

  it("bounds logs before handing them to persistence", async () => {
    const emit = vi.fn();
    await emitAgentInvocationObservations({
      observations: { emit },
      provider: "claude",
      model: "claude",
      phase: "review",
      artifacts: {
        stdout: `discard${"x".repeat(70 * 1024)}`,
        stderr: "",
        structuredOutput: null,
        exitCode: 1,
      },
      usage: null,
      result: {
        ok: false,
        category: "provider",
        message: "failed",
        diagnostic: {
          provider: "claude",
          packageName: "claude",
          cliVersion: "1",
          protocol: "jsonl",
          phase: "review",
          failureKind: "cli_exit",
          exitCode: 1,
        },
      },
    });

    const log = emit.mock.calls[0]?.[0] as {
      value: { tail: string };
    };
    expect(log.value.tail.length).toBe(64 * 1024);
    expect(log.value.tail).not.toContain("discard");
  });

  it("removes structured output repeated inside provider logs", async () => {
    const emit = vi.fn();
    const structuredOutput = '{"result":"private output"}';
    await emitAgentInvocationObservations({
      observations: { emit },
      provider: "codex",
      model: "gpt-5",
      phase: "implementation",
      artifacts: {
        stdout: `starting\n${structuredOutput}\nfinished\n${structuredOutput}`,
        stderr: `diagnostic included ${structuredOutput}`,
        structuredOutput,
        exitCode: 0,
      },
      usage: null,
      result: { ok: true, value: { result: "private output" } },
    });

    const captured = JSON.stringify(emit.mock.calls);
    expect(captured).not.toContain("private output");
    expect(captured).toContain("structured output omitted from diagnostic log");
    expect(captured).toContain("starting");
    expect(captured).toContain("finished");
  });

  it("captures bounded partial logs and timeout metadata without parsing output", async () => {
    const emit = vi.fn();
    await emitTimedOutAgentInvocationObservations({
      observations: { emit },
      provider: "codex",
      model: "gpt-5",
      phase: "implementation",
      collectArtifacts: vi.fn().mockResolvedValue({
        stdout: `discard${"x".repeat(70 * 1024)}`,
        stderr: "partial stderr",
        structuredOutput: '{"incomplete":"private output"}',
        exitCode: null,
      }),
    });

    const stdout = emit.mock.calls[0]?.[0] as {
      value: { tail: string };
    };
    expect(stdout.value.tail).toHaveLength(64 * 1024);
    expect(stdout.value.tail).not.toContain("discard");
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private output");
    expect(emit).toHaveBeenLastCalledWith({
      kind: "metadata",
      value: {
        provider: "codex",
        model: "gpt-5",
        phase: "implementation",
        exitCode: null,
        usage: null,
        protocol: {
          outcome: "timeout",
          partialArtifacts: "captured",
        },
      },
    });
  });

  it("records safe timeout metadata when partial artifacts cannot be read", async () => {
    const emit = vi.fn();
    await emitTimedOutAgentInvocationObservations({
      observations: { emit },
      provider: "claude",
      model: "claude",
      phase: "review",
      collectArtifacts: vi.fn().mockRejectedValue(new Error("secret failure")),
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith({
      kind: "metadata",
      value: {
        provider: "claude",
        model: "claude",
        phase: "review",
        exitCode: null,
        usage: null,
        protocol: {
          outcome: "timeout",
          partialArtifacts: "unavailable",
        },
      },
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("secret failure");
  });

  it("never lets timeout observation failures replace the execution outcome", async () => {
    await expect(
      emitTimedOutAgentInvocationObservations({
        observations: {
          emit: vi.fn().mockRejectedValue(new Error("capture unavailable")),
        },
        provider: "codex",
        model: "gpt-5",
        phase: "implementation",
        collectArtifacts: vi.fn().mockResolvedValue({
          stdout: "partial stdout",
          stderr: "",
          structuredOutput: null,
          exitCode: null,
        }),
      }),
    ).resolves.toBeUndefined();
  });
});
