import { describe, expect, it, vi } from "vitest";

const loggerInfo = vi.fn();
vi.mock("../../lib/logger.js", () => ({
  logger: { info: loggerInfo },
}));

import {
  AGENT_CLI_SPECS,
  AgentRuntimeError,
  installAndVerifyCli,
  protocolFailure,
  redactDiagnosticText,
  requireProviderSetup,
} from "./protocol.js";

function command(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

describe("pinned CLI specifications", () => {
  it("pins exact packages, versions, executables, protocols, and version parsers", () => {
    expect(AGENT_CLI_SPECS.claude).toMatchObject({
      packageName: "@anthropic-ai/claude-code",
      version: "2.1.216",
      executable: "claude",
      protocol: "claude-json-2.1.216",
    });
    expect(AGENT_CLI_SPECS.codex).toMatchObject({
      packageName: "@openai/codex",
      version: "0.144.6",
      executable: "codex",
      protocol: "codex-jsonl-0.144.6",
    });
    expect(AGENT_CLI_SPECS.claude.parseVersion("2.1.216 (Claude Code)"))
      .toBe("2.1.216");
    expect(AGENT_CLI_SPECS.codex.parseVersion("codex-cli 0.144.6"))
      .toBe("0.144.6");
    expect(AGENT_CLI_SPECS.codex.parseVersion("codex 0.144.6 extra"))
      .toBeNull();
  });

  it("installs only the exact package version and logs the verified protocol", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(command(0))
      .mockResolvedValueOnce(command(0, "codex-cli 0.144.6\n"));
    await installAndVerifyCli(
      { runCommand, writeFiles: vi.fn() } as never,
      AGENT_CLI_SPECS.codex,
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["install", "-g", "@openai/codex@0.144.6"],
    );
    expect(runCommand).toHaveBeenNthCalledWith(2, "codex", ["--version"]);
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: "0.144.6",
        actualVersion: "0.144.6",
        protocol: "codex-jsonl-0.144.6",
      }),
      "agent_cli_verified",
    );
  });

  it("installs a profile CLI under its manifest-hash runtime and verifies that exact executable", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(command(0))
      .mockResolvedValueOnce(command(0, "codex-cli 0.144.6\n"));
    const runtime = {
      manifestHash: "a".repeat(64),
      rootDir: `/tmp/aiw-harness/${"a".repeat(64)}`,
      homeDir: `/tmp/aiw-harness/${"a".repeat(64)}/home`,
      cliDir: `/tmp/aiw-harness/${"a".repeat(64)}/cli`,
      executablePath:
        `/tmp/aiw-harness/${"a".repeat(64)}/cli/node_modules/.bin/codex`,
      envPath: `/tmp/aiw-harness/${"a".repeat(64)}/credentials.sh`,
    };

    await installAndVerifyCli(
      { runCommand, writeFiles: vi.fn() } as never,
      AGENT_CLI_SPECS.codex,
      runtime,
    );

    expect(runCommand).toHaveBeenNthCalledWith(1, "npm", [
      "install",
      "--prefix",
      runtime.cliDir,
      "--omit=dev",
      "--no-save",
      "@openai/codex@0.144.6",
    ]);
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      runtime.executablePath,
      ["--version"],
    );
  });

  it("rejects a version mismatch without retrying or falling back", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce(command(0))
      .mockResolvedValueOnce(command(0, "codex-cli 0.145.0\n"));
    await expect(
      installAndVerifyCli(
        { runCommand, writeFiles: vi.fn() } as never,
        AGENT_CLI_SPECS.codex,
      ),
    ).rejects.toMatchObject({
      name: "AgentRuntimeError",
      diagnostic: { failureKind: "version_mismatch" },
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("turns failed provider setup into a redacted provisioning diagnostic", async () => {
    process.env.AIW_PROTOCOL_TEST_TOKEN = "secret-value-123";
    await expect(
      requireProviderSetup(
        command(1, "login failed", "Bearer secret-value-123") as never,
        AGENT_CLI_SPECS.codex,
        "Codex login",
      ),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      const runtime = error as AgentRuntimeError;
      expect(runtime.safeMessage).toBe("The agent runtime could not be prepared.");
      expect(runtime.diagnostic.stderrTail).toBe("Bearer [REDACTED]");
      expect(runtime.diagnostic.stdoutTail).toBeUndefined();
      return true;
    });
    delete process.env.AIW_PROTOCOL_TEST_TOKEN;
  });
});

describe("protocol diagnostics", () => {
  it("redacts recognizable provider, bearer, GitHub, and GitLab token forms", () => {
    expect(
      redactDiagnosticText(
        "sk-ant-abc bearer ghp_abcdefghijklmnopqrstuvwxyz gho_abcdefghijklmnopqrstuvwxyz " +
          "ghu_abcdefghijklmnopqrstuvwxyz glpat-abcdefghijklmnop token=secretvalue",
      ),
    ).not.toMatch(/sk-ant-|gh[pousr]_|glpat-|secretvalue/);
  });

  it("caps schema issues at twenty and never stores the schema value", () => {
    const schema = JSON.stringify({ type: "object", properties: { secretField: {} } });
    const result = protocolFailure({
      spec: AGENT_CLI_SPECS.claude,
      phase: "impl",
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: 0 },
      failureKind: "schema_mismatch",
      category: "schema",
      message: "The current agent phase returned an invalid structured response.",
      schema: {
        identity: "fixture-schema",
        source: schema,
        issues: Array.from({ length: 25 }, (_, index) => ({
          path: ["items", index],
          code: "custom",
          message: `issue ${index}`,
        })),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.schema?.issues).toHaveLength(20);
      expect(JSON.stringify(result.diagnostic)).not.toContain(schema);
    }
  });
});
