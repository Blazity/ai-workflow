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
const usable = vi.hoisted(() => ({
  value: [] as unknown[],
  /** What the resolver decided about each one, as a run's pin is compared with it. */
  states: new Map<string, unknown>(),
  /** Set when the database did not answer the resolver's read. */
  unreadable: null as string | null,
}));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../../services/integrations/runtime.js", async () => ({
  resolveUsableIntegrations: async () =>
    usable.unreadable === null
      ? { readable: true, usable: usable.value, states: usable.states, connectionFailures: new Map() }
      : { readable: false, reason: usable.unreadable },
  // The real comparison every other capability makes.
  checkIntegrationPin: (await import("../../services/integrations/resolve.js")).checkIntegrationPin,
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

/** The tracer's state as the resolver would decide it, at `fingerprint`. */
function connectedAt(fingerprint: string) {
  return {
    integrationId: "sdkfixtureotel",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: { latestVersion: 0, activeVersion: null, missingFields: [], complete: false, prepared: null },
    pin: { integrationId: "sdkfixtureotel", configFingerprint: fingerprint },
    secretsKeyAvailable: true,
  };
}

beforeEach(() => {
  logged.info.mockReset();
  logged.warn.mockReset();
  usable.unreadable = null;
  usable.states = new Map([["sdkfixtureotel", connectedAt("collector-one")]]);
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

describe("a tracer and the connection the run started with", () => {
  const pinned = {
    ...RUN,
    integrationPins: [{ integrationId: "sdkfixtureotel", configFingerprint: "collector-one" }],
  };

  it("traces the sandbox on the connection the run pinned", async () => {
    const plans = await agentTracingPlans({ harness: "claude", run: pinned });

    expect(plans.map((plan) => plan.integrationId)).toEqual(["sdkfixtureotel"]);
  });

  it("stops tracing the run, and says so, once an admin reconfigured the tracer", async () => {
    // The run's state was made on the old collector; tracing the rest of the
    // run on the new one would split it across two engines with nobody told.
    // The run itself goes on: tracing enriches a run and never gates one.
    usable.states = new Map([["sdkfixtureotel", connectedAt("collector-two")]]);

    const plans = await agentTracingPlans({ harness: "claude", run: pinned });

    expect(plans).toEqual([]);
    expect(logged.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-9",
        moved: [{ integration: "sdkfixtureotel", reason: "reconfigured" }],
      }),
      "agent_tracing_pin_moved",
    );
  });

  it("traces with a tracer the run holds no pin for, which has nothing of the run's to mix", async () => {
    usable.states = new Map([["sdkfixtureotel", connectedAt("collector-two")]]);

    const plans = await agentTracingPlans({
      harness: "claude",
      run: { ...RUN, integrationPins: [{ integrationId: "github", configFingerprint: "abc" }] },
    });

    expect(plans.map((plan) => plan.integrationId)).toEqual(["sdkfixtureotel"]);
  });

  it("says the settings could not be read, not that nothing traces here", async () => {
    usable.unreadable = "connection terminated unexpectedly";

    const plans = await agentTracingPlans({ harness: "claude", run: pinned });

    expect(plans).toEqual([]);
    expect(logged.warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-9", reason: "settings_unreadable" }),
      "agent_tracing_off",
    );
    expect(logged.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no_tracing_integration" }),
      "agent_tracing_off",
    );
  });
});
