import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CollectedPhaseArtifacts } from "./types.js";
import { ClaudeAgentAdapter } from "./claude.js";
import { CodexAgentAdapter } from "./codex.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

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
  it("records the pinned package, version, protocol, and refresh provenance", () => {
    const loaded = fixture(provider, version, "structured-success");
    expect(loaded).toMatchObject({
      package: adapter.cliSpec.packageName,
      version: adapter.cliSpec.version,
      protocol: adapter.cliSpec.protocol,
    });
    expect(loaded.provenance).toContain("capture script");
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
    if (!result.ok) expect(result.diagnostic.stdoutTail).toBeUndefined();
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
