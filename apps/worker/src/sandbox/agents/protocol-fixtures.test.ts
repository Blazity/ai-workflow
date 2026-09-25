import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CollectedPhaseArtifacts } from "./types.js";
import { ClaudeAgentAdapter } from "./claude.js";
import { CodexAgentAdapter } from "./codex.js";
import { agentProtocolExecutionError } from "../../engine/blocks/support/types.js";
import { createWorkflowExecutionErrorState } from "@shared/contracts";
import { formatExecutionErrorForUser } from "../../engine/helpers/execution-error.js";
import { safeWorkflowExecutionLogEvent } from "../../run-observability/safe-execution-log.js";

const fixtureRoot = join(import.meta.dirname, "fixtures");

interface ProtocolFixture {
  package: string;
  version: string;
  protocol: string;
  provenance: string;
  artifacts: CollectedPhaseArtifacts;
}

function fixture(
  provider: "claude" | "codex",
  version: string,
  name: string,
): ProtocolFixture {
  return JSON.parse(
    readFileSync(join(fixtureRoot, provider, version, `${name}.json`), "utf8"),
  ) as ProtocolFixture;
}

describe.each([
  {
    provider: "claude" as const,
    version: "2.1.216",
    adapter: new ClaudeAgentAdapter(),
    malformed: "malformed-json",
  },
  {
    provider: "codex" as const,
    version: "0.144.6",
    adapter: new CodexAgentAdapter(),
    malformed: "malformed-jsonl",
  },
])("$provider pinned protocol fixtures", ({ provider, version, adapter, malformed }) => {
  it("records the pinned package, version, protocol, and real-capture provenance", () => {
    const loaded = fixture(provider, version, "structured-success");
    expect(loaded).toMatchObject({
      package: adapter.cliSpec.packageName,
      version: adapter.cliSpec.version,
      protocol: adapter.cliSpec.protocol,
    });
    expect(loaded.provenance).toContain("captured locally");
  });

  it("accepts the structured success envelope", () => {
    const loaded = fixture(provider, version, "structured-success");
    const result = adapter.parseAgentOutputProtocol(loaded.artifacts, "impl");
    expect(result).toMatchObject({ ok: true, value: { result: "implemented" } });
  });

  it("accepts a successful freeform terminal envelope", () => {
    const loaded = fixture(provider, version, "freeform-success");
    expect(adapter.validateFreeformProtocol(loaded.artifacts, "pre-pr-fix-1")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("classifies a terminal provider error as provider", () => {
    const loaded = fixture(provider, version, "provider-error");
    const result = adapter.validateFreeformProtocol(loaded.artifacts, "pre-pr-fix-1");
    expect(result).toMatchObject({
      ok: false,
      category: "provider",
      diagnostic: { failureKind: "provider_error" },
    });
  });

  it("preserves a nonzero exit as a process failure", () => {
    const loaded = fixture(provider, version, "nonzero-exit");
    const result = adapter.validateFreeformProtocol(loaded.artifacts, "pre-pr-fix-1");
    expect(result).toMatchObject({
      ok: false,
      category: "provider",
      diagnostic: { failureKind: "cli_exit", exitCode: 1 },
    });
    // The CLI's last words are the whole diagnosis for a non-zero exit, so the
    // tail is kept under the same cap the malformed-output case below asserts.
    if (!result.ok) {
      // Nothing on stdout leaves nothing to keep; anything else has to survive,
      // because it is the only record of why the process gave up.
      expect(Boolean(result.diagnostic.stdoutTail)).toBe(
        Boolean(loaded.artifacts.stdout),
      );
      expect(
        Buffer.byteLength(result.diagnostic.stdoutTail ?? ""),
      ).toBeLessThanOrEqual(2048);
    }
  });

  it("rejects a missing terminal event", () => {
    const loaded = fixture(provider, version, "missing-terminal");
    const result = adapter.validateFreeformProtocol(loaded.artifacts, "pre-pr-fix-1");
    expect(result).toMatchObject({ ok: false, category: "parsing" });
  });

  it("rejects malformed protocol output and retains only a bounded stdout tail", () => {
    const loaded = fixture(provider, version, malformed);
    const result = adapter.parseAgentOutputProtocol(loaded.artifacts, "impl");
    expect(result).toMatchObject({
      ok: false,
      category: "parsing",
      diagnostic: { failureKind: "invalid_json" },
    });
    if (!result.ok) expect(Buffer.byteLength(result.diagnostic.stdoutTail ?? "")).toBeLessThanOrEqual(2048);
  });

  it("retains valid usage when the terminal structured value fails its schema", () => {
    const loaded = fixture(provider, version, "schema-mismatch");
    const result = adapter.parseAgentOutputProtocol(loaded.artifacts, "impl");
    expect(result).toMatchObject({
      ok: false,
      category: "schema",
      diagnostic: {
        failureKind: "schema_mismatch",
        schema: { identity: "agent-output" },
      },
    });
    expect(adapter.extractUsage(loaded.artifacts.stdout, loaded.artifacts.structuredOutput))
      .not.toBeNull();
  });
});

describe("codex 0.144.6 incident replay (AIW-312)", () => {
  // The 2026-08-21 Arthur outage, replayed byte-for-byte through the same
  // pipeline production runs: adapter classification, the block-level
  // execution error, the user-facing reason, and the operator log record.
  const loaded = fixture("codex", "0.144.6", "spend-limit-exit");
  const runId = "wrun_01M0J7D367ZQW6Q487T467M0PV";

  it("classifies the capture as provider_error carrying the spend-limit sentence", () => {
    const result = new CodexAgentAdapter().validateFreeformProtocol(
      loaded.artifacts,
      "impl-v2-4-a1",
    );
    expect(result).toMatchObject({
      ok: false,
      category: "provider",
      diagnostic: { failureKind: "provider_error", exitCode: 1 },
    });
    if (result.ok) return;
    expect(result.diagnostic.providerError).toContain("spend limit");
    // The only stderr line is the startup warning; the noise filter drops it.
    expect(result.diagnostic.stderrTail).toBeUndefined();
  });

  it("surfaces the spend limit on the user-facing reason and the operator log", () => {
    const result = new CodexAgentAdapter().validateFreeformProtocol(
      loaded.artifacts,
      "impl-v2-4-a1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const execError = agentProtocolExecutionError(result);
    const state = createWorkflowExecutionErrorState(
      runId,
      "implementation",
      1,
      execError.error,
    );
    const reason = formatExecutionErrorForUser(state);
    expect(reason).toContain("spend limit");
    expect(reason).toContain(`AIW-DIAG-${runId}-implementation-1`);
    expect(reason).not.toContain("PATH aliases");
    const record = safeWorkflowExecutionLogEvent({
      diagnosticId: state.diagnosticId,
      nodeId: "implementation",
      attempt: 1,
      category: state.category,
      message: state.message,
      agentProtocol: result.diagnostic,
    });
    expect(record.message).toContain("spend limit");
    expect(JSON.stringify(record)).not.toContain("PATH aliases");
  });
});

describe("claude 2.1.216 incident replay (Anthropic credit exhausted, 2026-09-23)", () => {
  // Production run wrun_01M3755BR7PYPCZ7VVSJ7RGM88 on AWP-279: the CLI exited 1
  // after one API call and its only output was an error result envelope saying
  // "Credit balance is too low". The ticket comment said "The AI provider
  // rejected the request", which names neither the provider nor who can fix it.
  const loaded = fixture("claude", "2.1.216", "credit-exhausted-exit");
  const runId = "wrun_01M3755BR7PYPCZ7VVSJ7RGM88";

  function reasonFor(result: ReturnType<ClaudeAgentAdapter["validateFreeformProtocol"]>) {
    if (result.ok) throw new Error("expected a failure");
    const state = createWorkflowExecutionErrorState(
      runId,
      "implementation",
      1,
      agentProtocolExecutionError(result).error,
    );
    return formatExecutionErrorForUser(state);
  }

  it("keeps the provider's own refusal, not only the exit code", () => {
    const result = new ClaudeAgentAdapter().validateFreeformProtocol(
      loaded.artifacts,
      "impl-v2-4-a1",
    );
    expect(result).toMatchObject({
      ok: false,
      category: "provider",
      diagnostic: {
        provider: "claude",
        failureKind: "provider_error",
        exitCode: 1,
        providerError: "Credit balance is too low",
      },
    });
  });

  it("tells the person it is the Anthropic account, that an admin fixes it, and that the ticket is fine", () => {
    const reason = reasonFor(
      new ClaudeAgentAdapter().validateFreeformProtocol(loaded.artifacts, "impl-v2-4-a1"),
    );
    expect(reason).toMatch(/^The Anthropic account has no credit left/);
    expect(reason).toContain("An admin must top up the Anthropic account");
    expect(reason).toContain("nothing is wrong with the ticket");
    expect(reason).not.toContain("The AI provider");
    expect(reason).toContain(`AIW-DIAG-${runId}-implementation-1`);
  });

  it("names the same account when the structured parse path fails the same way", () => {
    const result = new ClaudeAgentAdapter().parseAgentOutputProtocol(
      loaded.artifacts,
      "impl-v2-4-a1",
    );
    expect(result).toMatchObject({
      ok: false,
      diagnostic: { failureKind: "provider_error", providerError: "Credit balance is too low" },
    });
    expect(reasonFor(result as never)).toMatch(/^The Anthropic account has no credit left/);
  });
});
