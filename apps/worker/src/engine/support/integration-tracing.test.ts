import { beforeEach, describe, expect, it, vi } from "vitest";
import { otelFixtureManifest, otelFixtureRuntime } from "@integrations/sdk/fixtures";

/**
 * A tracing provider shaped nothing like the first one, through core's real
 * path: the plan core asks it for, and the install core applies to a sandbox.
 *
 * The foil needs no run state, installs nothing, writes no file and hooks
 * nothing: a harness that exports OpenTelemetry itself only needs variables.
 * If core's path quietly assumed a hook, a file or a task, this provider would
 * come out untraced, and the run id it labels its telemetry with would never
 * reach the agent.
 */
const usable = vi.hoisted(() => ({ value: [] as unknown[] }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../../services/integrations/runtime.js", () => ({
  usableIntegrations: async () => usable.value,
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: logged.info, warn: logged.warn, error: vi.fn(), debug: vi.fn() },
}));

const { agentTracingPlans } = await import("./integration-tracing.js");
const { installTracingPlans, tracingEnvironmentLines } = await import(
  "../../sandbox/agents/tracing.js"
);

const RUN = { runId: "run-9", subjectKey: "AWT-42", states: {} };

function fakeSandbox() {
  const commands: string[] = [];
  return {
    commands,
    sandbox: {
      runCommand: async (_bin: string, args: string[]) => {
        commands.push(args.join(" "));
        return { exitCode: 0 };
      },
      writeFiles: async () => {},
    },
  };
}

beforeEach(() => {
  logged.info.mockReset();
  logged.warn.mockReset();
  usable.value = [
    {
      manifest: otelFixtureManifest,
      runtime: otelFixtureRuntime,
      ctx: { connection: { endpoint: "https://otel.example", apiKey: "collector-key" } },
    },
  ];
});

describe("a variables-only tracing provider through core's path", () => {
  it("reaches the agent's environment with the run id, and needs no command at all", async () => {
    const plans = await agentTracingPlans({ harness: "claude", run: RUN });
    const { sandbox, commands } = fakeSandbox();
    const ready = await installTracingPlans(sandbox as never, plans, "claude");

    expect(ready.map((plan) => plan.integrationId)).toEqual(["sdkfixtureotel"]);
    expect(commands).toEqual([]);
    expect(tracingEnvironmentLines(ready)).toContain(
      "export OTEL_RESOURCE_ATTRIBUTES='aiw.run_id=run-9'",
    );
  });

  it("says a sandbox is untraced, and why, when no provider planned anything", async () => {
    usable.value = [];

    const plans = await agentTracingPlans({
      harness: "codex",
      run: { ...RUN, invocation: { nodeId: "review", attempt: 1 } },
    });

    expect(plans).toEqual([]);
    expect(logged.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-9",
        harness: "codex",
        nodeId: "review",
        reason: "no_tracing_integration",
      }),
      "agent_tracing_off",
    );
  });
});
