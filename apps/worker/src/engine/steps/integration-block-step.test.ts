import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { IntegrationManifest } from "@integrations/sdk";
import type { IntegrationState } from "@shared/contracts";

/**
 * The one step every integration block runs through.
 *
 * It is the last thing between a person's workflow and somebody else's API, so
 * what it does when the connection moved, when the parameters do not parse,
 * when the block throws, and when core is cancelling the run all matter more
 * than the happy path. It also must never be retried: a block that posted a
 * comment and then threw would post it twice.
 */

const states = vi.hoisted(() => vi.fn());
const stored = vi.hoisted(() => vi.fn());
const executor = vi.hoisted(() => vi.fn());
const runControl = vi.hoisted(() => vi.fn());
const llmTargets = vi.hoisted(() => [] as unknown[]);
const directCallKeys = vi.hoisted(() => ({ value: { claude: true, codex: false } }));

const manifest: IntegrationManifest = {
  id: "acmenotify",
  name: "Acme Notify",
  description: "A provider core has never heard of.",
  connection: {
    fields: [
      { key: "baseUrl", label: "Site URL", env: "ACMENOTIFY_BASE_URL", secret: false },
      { key: "apiToken", label: "API token", env: "ACMENOTIFY_TOKEN", secret: true },
    ],
  },
  capabilities: [],
  blocks: [
    {
      type: "acmenotify_announce",
      paramsSchema: z.object({ channel: z.string().min(1) }).strict(),
      contract: { ports: ["out"], allowsFailurePort: false },
      ui: {
        label: "Announce",
        description: "Announces a milestone.",
        glyph: "A",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      output: { properties: {}, statusVariants: ["sent"] },
    },
    {
      type: "acmenotify_digest",
      paramsSchema: z.object({}).strict(),
      contract: { ports: ["out"], allowsFailurePort: false },
      ui: {
        label: "Digest",
        description: "Summarises with a model.",
        glyph: "D",
        color: "#445566",
        softColor: "#EEF1F4",
      },
      output: { properties: {}, statusVariants: ["done"] },
      requires: { llm: true },
    },
  ],
  pages: [],
  health: [{ id: "reachable", label: "Reachable", description: "", critical: true }],
};

vi.mock("@integrations/registry", () => ({
  integrationManifest: (id: string) => (id === "acmenotify" ? manifest : undefined),
  integrationManifests: [manifest],
}));
vi.mock("@integrations/registry/worker", () => ({
  integrationRuntime: (id: string) =>
    id === "acmenotify"
      ? {
          manifest,
          capabilities: {},
          blocks: {
            acmenotify_announce: (...args: unknown[]) => executor(...args),
            acmenotify_digest: (...args: unknown[]) => executor(...args),
          },
        }
      : undefined,
}));
// The real resolver reads the connection, so what is replaced is below it: the
// database read (`stored`) and the state the resolver would derive from it
// (`states`), which a test states outright. The values come from the
// environment, as a deployment configured through it has them.
vi.mock("../../services/integrations/authoring.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/integrations/authoring.js")>()),
  readIntegrationStatesFrom: () => states(),
}));
vi.mock("../../db/repositories/integrations.js", () => ({
  readConnectedIntegrationConnections: () => stored(),
}));
vi.mock("../helpers/run-control-error.js", () => ({
  isRunControlError: (error: unknown) => runControl(error),
}));
vi.mock("../support/integration-capabilities.js", () => ({
  integrationCapabilityAccess: () => ({}),
  integrationLlm: (target: unknown) => {
    llmTargets.push(target);
    return { generateObject: () => Promise.reject(new Error("unused")) };
  },
}));
// Which providers take a direct model call is read from the environment in
// one place; the test states it.
vi.mock("../definition/block-contract-environment.js", () => ({
  directLlmCredentials: () => directCallKeys.value,
}));

const { runIntegrationBlockStep } = await import("./integration-block-step.js");

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "acmenotify",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: {
      latestVersion: 0,
      activeVersion: null,
      missingFields: [],
      complete: false,
      prepared: null,
    },
    pin: { integrationId: "acmenotify", configFingerprint: "site-one" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function call(overrides: Partial<Parameters<typeof runIntegrationBlockStep>[0]> = {}) {
  return runIntegrationBlockStep({
    integrationId: "acmenotify",
    blockType: "acmenotify_announce",
    pin: { integrationId: "acmenotify", configFingerprint: "site-one" },
    configuration: { channel: "releases" },
    inputs: {},
    run: {
      runId: "run-1",
      nodeId: "announce",
      attempt: 1,
      subjectKey: "AWT-42",
      state: { taskId: "task-7" },
    },
    llm: { provider: "claude", model: "claude-test" },
    ...overrides,
  });
}

beforeEach(() => {
  llmTargets.length = 0;
  directCallKeys.value = { claude: true, codex: false };
  executor.mockReset();
  runControl.mockReset();
  runControl.mockReturnValue(false);
  states.mockReset();
  states.mockReturnValue(new Map([["acmenotify", state()]]));
  stored.mockReset();
  stored.mockResolvedValue(new Map());
  vi.stubEnv("ACMENOTIFY_BASE_URL", "https://acme.example");
  vi.stubEnv("ACMENOTIFY_TOKEN", "tok-secret-value");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("running an integration block", () => {
  it("never retries, so a block that acted and then threw does not act twice", () => {
    // The whole reason integration code carries no retry policy of its own.
    expect(runIntegrationBlockStep.maxRetries).toBe(0);
  });

  it("runs the executor with the parsed parameters and the run's identity", async () => {
    executor.mockResolvedValue({ kind: "next", output: { status: "sent" } });

    const result = await call({ inputs: { message: "hi" } });

    expect(result).toEqual({ kind: "next", output: { status: "sent" } });
    const [invocation, ctx] = executor.mock.calls[0] as [
      { params: unknown; inputs: unknown },
      { run: unknown; signal: AbortSignal },
    ];
    expect(invocation.params).toEqual({ channel: "releases" });
    expect(invocation.inputs).toEqual({ message: "hi" });
    // What the run is about and this integration's per-run handle travel with
    // the identity: a block that cannot work without the handle (a screen with
    // nothing to screen against) can only refuse if it is handed one or told
    // there is none.
    expect(ctx.run).toEqual({
      runId: "run-1",
      nodeId: "announce",
      attempt: 1,
      subjectKey: "AWT-42",
      state: { taskId: "task-7" },
    });
    // Bounded, so a block that hangs reports a failure rather than letting the
    // invocation be killed with the run half done.
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads the state live, so a disable mid-run stops the very next use", async () => {
    states.mockReturnValue(
      new Map([["acmenotify", state({ enabled: false, status: "disabled", usable: false })]]),
    );

    const result = await call();

    expect(result).toEqual({
      kind: "unavailable",
      reason: "disabled",
      message: expect.stringContaining("Acme Notify was disabled"),
    });
    expect(executor).not.toHaveBeenCalled();
  });

  it("stops before the executor when the configuration moved since the run started", async () => {
    states.mockReturnValue(
      new Map([
        [
          "acmenotify",
          state({ pin: { integrationId: "acmenotify", configFingerprint: "site-two" } }),
        ],
      ]),
    );

    const result = await call();

    expect(result).toMatchObject({ kind: "unavailable", reason: "reconfigured" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("refuses parameters the block's own schema rejects, naming the block", async () => {
    const result = await call({ configuration: { channel: "" } });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("Announce");
    expect(executor).not.toHaveBeenCalled();
  });

  it("reports the failure a block declares, with its secrets taken out", async () => {
    executor.mockResolvedValue({
      kind: "failed",
      message: "Acme refused tok-secret-value",
      detail: "401 for tok-secret-value",
    });

    const result = await call();

    expect(result).toEqual({
      kind: "failed",
      message: "Acme refused [redacted]",
      detail: "401 for [redacted]",
    });
  });

  it("keeps a thrown error from becoming a success, and names the block", async () => {
    // The side effect landed and then the call blew up. Core must not re-run
    // the executor, and must not report the throw as an outcome.
    let posted = 0;
    executor.mockImplementation(() => {
      posted += 1;
      throw new Error("connection reset after posting");
    });

    const result = await call();

    expect(posted).toBe(1);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("Announce failed");
  });

  it("re-raises a cancelled run rather than reporting it as a block failure", async () => {
    runControl.mockReturnValue(true);
    executor.mockRejectedValue(new Error("run cancelled"));

    await expect(call()).rejects.toThrow("run cancelled");
  });

  it("says what happened when a block runs past its time bound", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    executor.mockRejectedValue(timeout);

    const result = await call();

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("unreachable");
    expect(result.message).toContain("Announce");
    expect(result.message).toContain("240 seconds");
  });

  it("refuses an outcome the contract does not describe instead of continuing on it", async () => {
    executor.mockResolvedValue({ kind: "maybe", output: { status: "sent" } });

    const result = await call();

    expect(result.kind).toBe("error");
  });

  it("says the settings could not be read, never that the block failed, when the database does not answer", async () => {
    // The run's own read, not the integration: reporting it as the block's
    // failure blamed the provider for a database that was briefly away, and a
    // throw out of a step that is never retried ended the run on it.
    stored.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const result = await call();

    expect(result).toEqual({ kind: "unreadable", reason: "connection terminated unexpectedly" });
    expect(executor).not.toHaveBeenCalled();
  });

  it("stops a run whose integration this build no longer ships", async () => {
    const result = await call({ integrationId: "goneaway" });

    expect(result).toMatchObject({ kind: "unavailable", reason: "disconnected" });
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("the model a block reaches through ctx.llm", () => {
  const digest = {
    blockType: "acmenotify_digest",
    configuration: {},
    llm: {
      provider: "claude" as const,
      model: "claude-run-model",
      models: { claude: "claude-run-model", codex: "gpt-run-model" },
    },
  };

  it("is the run's own provider when that provider takes a direct call", async () => {
    executor.mockResolvedValue({ kind: "next", output: { status: "done" } });

    await call(digest);

    expect(llmTargets).toEqual([{ provider: "claude", model: "claude-run-model" }]);
  });

  it("is the other provider, never a Claude OAuth token sent as an API key", async () => {
    // Agents on Claude through an OAuth token, and a Codex API key: the run
    // prefers Claude, which a direct call refuses, so Codex serves with the
    // run's Codex model.
    directCallKeys.value = { claude: false, codex: true };
    executor.mockResolvedValue({ kind: "next", output: { status: "done" } });

    await call(digest);

    expect(llmTargets).toEqual([{ provider: "codex", model: "gpt-run-model" }]);
  });

  it("is refused before the block runs when no provider takes a direct call", async () => {
    directCallKeys.value = { claude: false, codex: false };

    const result = await call(digest);

    expect(result).toEqual({
      kind: "llm_unconfigured",
      message: expect.stringContaining("neither a Claude nor a Codex API key is configured"),
    });
    expect(executor).not.toHaveBeenCalled();
  });
});
