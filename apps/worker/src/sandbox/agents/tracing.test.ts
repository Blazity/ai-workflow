import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTracingSetup } from "@integrations/sdk";

/**
 * What core does to a sandbox on a tracing provider's behalf.
 *
 * This is the half that used to be written into the Claude and Codex adapters
 * with one provider's name on it. The behaviour it has to keep is what that
 * code did: install what the tracer imports, put the tracer where its hooks
 * can find it, tell it which engine and which bucket, and register a command
 * on each moment the harness offers. Two things it must never do: put a key on
 * a command line, because a command is recorded with the sandbox and read back
 * on a screen, and put a provider's hook variables in the agent's own
 * environment, where the agent and everything it runs can read them.
 */
const logged = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: logged.info, warn: logged.warn, error: vi.fn(), debug: vi.fn() },
}));

const {
  installTracingPlans,
  tracingEnvironmentLines,
  tracingHookCommands,
} = await import("./tracing.js");

const KEY = "sk-engine-sentinel-4417";
const HOOK_ENV = '"$HOME/.aiw-tracing/acmetrace/hook.env"';
const LOAD = `[ -r ${HOOK_ENV} ] && . ${HOOK_ENV}; `;

function setup(overrides: Partial<AgentTracingSetup> = {}): AgentTracingSetup {
  return {
    packages: [{ ecosystem: "python", name: "opentelemetry-sdk", minVersion: "1.20.0" }],
    files: [{ path: "tracer.py", contentBase64: "cHJpbnQoMSkK", executable: true }],
    hookEnvironment: { ENGINE_API_KEY: KEY, ENGINE_TASK_ID: "task-7" },
    environment: { ENGINE_LEVEL: "info" },
    hooks: [
      { event: "prompt_submitted", command: 'python3 "${TRACING_DIR}/tracer.py" prompt' },
      { event: "tool_failed", command: 'python3 "${TRACING_DIR}/tracer.py" failed' },
    ],
    ...overrides,
  };
}

function fakeSandbox() {
  const commands: string[] = [];
  const written: Array<{ path: string; content: string }> = [];
  return {
    commands,
    written,
    sandbox: {
      runCommand: async (_bin: string, args: string[]) => {
        commands.push(args.join(" "));
        return { exitCode: 0 };
      },
      writeFiles: async (files: Array<{ path: string; content: Buffer }>) => {
        for (const file of files) {
          written.push({ path: file.path, content: file.content.toString("utf8") });
        }
      },
    },
  };
}

beforeEach(() => {
  logged.warn.mockReset();
  logged.info.mockReset();
});

describe("applying a tracing provider's setup to a sandbox", () => {
  it("gives the agent only the variables meant for the agent", () => {
    const lines = tracingEnvironmentLines([{ integrationId: "acmetrace", setup: setup() }]);

    expect(lines).toEqual(["export ENGINE_LEVEL='info'"]);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("maps each moment to the hook this harness has, and loads the hook file first", () => {
    const plans = [{ integrationId: "acmetrace", setup: setup() }];

    // A harness with every hook.
    expect(
      tracingHookCommands(plans, {
        prompt_submitted: "UserPromptSubmit",
        tool_failed: "PostToolUseFailure",
      }),
    ).toEqual([
      ["UserPromptSubmit", `${LOAD}python3 "$HOME/.aiw-tracing/acmetrace/tracer.py" prompt`],
      ["PostToolUseFailure", `${LOAD}python3 "$HOME/.aiw-tracing/acmetrace/tracer.py" failed`],
    ]);

    // A harness without a failure hook gets the rest rather than an error
    // about a harness the provider never heard of.
    expect(tracingHookCommands(plans, { prompt_submitted: "UserPromptSubmit" })).toEqual([
      ["UserPromptSubmit", `${LOAD}python3 "$HOME/.aiw-tracing/acmetrace/tracer.py" prompt`],
    ]);
  });

  it("does not load a hook file for a provider that asked for no hook variables", () => {
    const plans = [{ integrationId: "acmetrace", setup: setup({ hookEnvironment: undefined }) }];

    expect(tracingHookCommands(plans, { prompt_submitted: "UserPromptSubmit" })).toEqual([
      ["UserPromptSubmit", 'python3 "$HOME/.aiw-tracing/acmetrace/tracer.py" prompt'],
    ]);
  });

  it("installs the packages and lands the files and the hook file in the provider's directory", async () => {
    const { sandbox, commands, written } = fakeSandbox();

    const ready = await installTracingPlans(
      sandbox as never,
      [{ integrationId: "acmetrace", setup: setup() }],
      "claude",
    );

    expect(ready).toHaveLength(1);
    expect(commands[0]).toContain("pip install --user --quiet 'opentelemetry-sdk>=1.20.0'");
    expect(written[0]?.content).toBe("print(1)\n");
    expect(written[1]).toEqual({
      path: "/tmp/aiw-tracing-acmetrace-hook.env",
      content: `export ENGINE_API_KEY='${KEY}'\nexport ENGINE_TASK_ID='task-7'\n`,
    });
    const move = commands[1] ?? "";
    expect(move).toContain('mkdir -p "$HOME/.aiw-tracing/acmetrace"');
    expect(move).toContain('chmod 700 "$HOME/.aiw-tracing/acmetrace"/\'tracer.py\'');
    expect(move).toContain('chmod 600 "$HOME/.aiw-tracing/acmetrace"/hook.env');
  });

  it("puts no connection secret on a command line", async () => {
    const { sandbox, commands } = fakeSandbox();

    await installTracingPlans(
      sandbox as never,
      [{ integrationId: "acmetrace", setup: setup() }],
      "claude",
    );

    // Everything else about the sandbox is recorded and shown; only a written
    // file is not.
    for (const command of commands) expect(command).not.toContain(KEY);
    for (const [, command] of tracingHookCommands([{ integrationId: "acmetrace", setup: setup() }], {
      prompt_submitted: "UserPromptSubmit",
    })) {
      expect(command).not.toContain(KEY);
    }
  });

  it("quotes a file name the provider chose, so it cannot run as a command", async () => {
    const { sandbox, commands } = fakeSandbox();

    await installTracingPlans(
      sandbox as never,
      [
        {
          integrationId: "acmetrace",
          setup: setup({
            packages: [],
            hookEnvironment: undefined,
            files: [{ path: "a b/$(touch pwned).py", contentBase64: "eA==" }],
          }),
        },
      ],
      "claude",
    );

    expect(commands[0]).toContain(`"$HOME/.aiw-tracing/acmetrace"/'a b/$(touch pwned).py'`);
    // Outside single quotes, nothing of the name is left for the shell to run.
    expect((commands[0] ?? "").replace(/'[^']*'/g, "")).not.toContain("$(touch");
  });

  it("refuses a file path that would escape the provider's directory", async () => {
    const { sandbox, commands } = fakeSandbox();

    const ready = await installTracingPlans(
      sandbox as never,
      [
        {
          integrationId: "acmetrace",
          setup: setup({
            packages: [],
            files: [{ path: "../../.ssh/authorized_keys", contentBase64: "eA==" }],
          }),
        },
      ],
      "claude",
    );

    // Nothing ready means nothing hooked either: a hook calling a script that
    // never landed would fail on every tool call the agent makes.
    expect(ready).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("leaves a provider whose install failed out, and says the sandbox is untraced", async () => {
    const failing = {
      runCommand: async () => ({ exitCode: 1 }),
      writeFiles: async () => {},
    };

    const ready = await installTracingPlans(
      failing as never,
      [{ integrationId: "acmetrace", setup: setup() }],
      "codex",
    );

    expect(ready).toEqual([]);
    expect(logged.warn).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "codex", reason: "install_failed" }),
      "agent_tracing_off",
    );
  });

  it("asks for nothing when a provider needs nothing but variables", async () => {
    const { sandbox, commands, written } = fakeSandbox();
    const otel = {
      integrationId: "otelcollector",
      setup: { environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example" } },
    };

    const ready = await installTracingPlans(sandbox as never, [otel], "claude");

    expect(ready).toHaveLength(1);
    expect(commands).toEqual([]);
    expect(written).toEqual([]);
    expect(tracingEnvironmentLines([otel])).toEqual([
      "export OTEL_EXPORTER_OTLP_ENDPOINT='https://otel.example'",
    ]);
  });
});
