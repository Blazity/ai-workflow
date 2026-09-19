import { describe, expect, it, vi } from "vitest";
import type { AgentTracingSetup } from "@integrations/sdk";

/**
 * A tracing provider's plan, applied by each harness adapter for real.
 *
 * `tracing.test.ts` holds the applier's pieces; this holds the adapters that
 * call them, which is where a line can go missing without any piece noticing:
 * the agent env file that stops carrying what the harness itself needs, a hook
 * that is never merged into the harness settings, or a key that lands in the
 * agent's environment or in a command the sandbox records and a screen shows.
 */
vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ClaudeAgentAdapter } = await import("./claude.js");
const { CodexAgentAdapter } = await import("./codex.js");
const { AGENT_ENV_CLAUDE_PATH, AGENT_ENV_CODEX_PATH } = await import("./shared.js");

const KEY = "sk-tracer-sentinel-5521";

const setup: AgentTracingSetup = {
  files: [{ path: "tracer.py", contentBase64: Buffer.from("print(1)\n").toString("base64"), executable: true }],
  hookEnvironment: { ACME_TRACE_KEY: KEY, ACME_RUN: "run-9" },
  // What the harness itself reads; the only thing the agent should be given.
  environment: { ACME_EXPORT_LEVEL: "info" },
  hooks: [
    { event: "prompt_submitted", command: 'python3 "${TRACING_DIR}/tracer.py" prompt' },
    { event: "tool_failed", command: 'python3 "${TRACING_DIR}/tracer.py" failed' },
  ],
};

function fakeSandbox() {
  const commands: string[] = [];
  const files = new Map<string, string>();
  return {
    commands,
    files,
    sandbox: {
      runCommand: vi.fn(async (bin: string, args: string[] = []) => {
        commands.push([bin, ...args].join(" "));
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      }),
      writeFiles: vi.fn(async (written: Array<{ path: string; content: Buffer }>) => {
        for (const file of written) files.set(file.path, file.content.toString("utf8"));
      }),
    },
  };
}

describe.each([
  {
    harness: "claude",
    configure: (sandbox: unknown) =>
      new ClaudeAgentAdapter().configure(sandbox as never, {
        model: "claude-opus-4-6",
        anthropicApiKey: "sk-ant-test",
        legacyDynamicSkills: false,
        tracing: [{ integrationId: "acmetrace", setup }],
      }),
    envPath: AGENT_ENV_CLAUDE_PATH,
    promptHook: "UserPromptSubmit",
    failureHook: "PostToolUseFailure" as string | null,
  },
  {
    harness: "codex",
    configure: (sandbox: unknown) =>
      new CodexAgentAdapter().configure(sandbox as never, {
        model: "gpt-5-codex",
        codexApiKey: "sk-test",
        legacyDynamicSkills: false,
        tracing: [{ integrationId: "acmetrace", setup }],
      }),
    envPath: AGENT_ENV_CODEX_PATH,
    promptHook: "UserPromptSubmit",
    // Codex has no hook for a failed tool call.
    failureHook: null,
  },
])("a $harness sandbox configured with a tracing provider", ({ configure, envPath, promptHook, failureHook }) => {
  it("gives the agent what the harness reads, and not the provider's key", async () => {
    const { sandbox, files } = fakeSandbox();
    await configure(sandbox);

    const agentEnv = files.get(envPath) ?? "";
    expect(agentEnv).toContain("export ACME_EXPORT_LEVEL='info'");
    expect(agentEnv).not.toContain(KEY);
    expect(agentEnv).not.toContain("ACME_TRACE_KEY");
  });

  it("writes the key to the provider's hook file, mode 600, and nowhere the agent reads", async () => {
    const { sandbox, files, commands } = fakeSandbox();
    await configure(sandbox);

    const staged = [...files.entries()].find(([path]) => path.endsWith("hook.env"));
    expect(staged?.[1]).toContain(`export ACME_TRACE_KEY='${KEY}'`);
    const move = commands.find((command) => command.includes("hook.env"));
    expect(move).toContain('mv /tmp/aiw-tracing-acmetrace-hook.env "$HOME/.aiw-tracing/acmetrace"/hook.env');
    expect(move).toContain('chmod 600 "$HOME/.aiw-tracing/acmetrace"/hook.env');
  });

  it("merges each hook into the harness settings, loading the hook file first", async () => {
    const { sandbox, commands } = fakeSandbox();
    await configure(sandbox);

    const merge = commands.find((command) => command.includes("tracer.py\\\" prompt") || command.includes('tracer.py\\" prompt'));
    expect(merge, "no settings merge carried the provider's hook").toBeDefined();
    expect(merge).toContain(promptHook);
    expect(merge).toContain('[ -r \\"$HOME/.aiw-tracing/acmetrace/hook.env\\" ]');
    if (failureHook) expect(merge).toContain(failureHook);
    else expect(merge).not.toContain("tracer.py\\\" failed");
  });

  it("records no command that carries the key", async () => {
    const { sandbox, commands } = fakeSandbox();
    await configure(sandbox);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).not.toContain(KEY);
  });
});
