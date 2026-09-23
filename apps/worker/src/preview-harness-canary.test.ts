import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHarnessCanaryEnv } from "../e2e/harness-profiles/canary-contract.js";
import { ENGINE_CANARY_FIXTURES } from "../e2e/harness-profiles/engine-canary-fixtures.js";
import {
  assertCanaryRunIdentity,
  assertFixtureTicketOutsideAiColumn,
  CanaryMcpToolError,
  finishCanaryRun,
  leaveTargetAfterFailedRun,
  readAiColumn,
  releaseCanaryRun,
  canaryCaseSelection,
  resolveCanaryCases,
  sweepFixtureTicket,
  waitForSuccessfulRun,
  type CanaryRunLogsOverview,
} from "../e2e/harness-profiles/preview-canary.js";

// Fixture identity (definition ids, deployed versions, the custom profile pin,
// its skill, one ticket per fixture) no longer travels through this schema; it
// lives in engine-canary-fixtures.ts and is asserted by the "engine canary
// fixtures" suite below.
const completeEnv = {
  HARNESS_CANARY_BASE_URL: "https://preview.example.test",
  HARNESS_CANARY_EXPECTED_HOST: "preview.example.test",
  ENGINE_CANARY_MCP_CLIENT_ID: "engine-canary-client",
  ENGINE_CANARY_MCP_CLIENT_SECRET: "machine-secret-with-enough-length",
  HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: "run-preview-harness-canary",
  VERCEL_ENV: "preview",
  VERCEL_AUTOMATION_BYPASS_SECRET: "preview-bypass",
  NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: "0",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Handler = (args: Record<string, unknown>) => unknown;

// The target as the canary sees it: named MCP tools and nothing else. A tool the
// test did not declare is a call the canary was not supposed to make.
function fakeMcp(handlers: Record<string, Handler>) {
  const call = vi.fn(
    async (name: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected MCP call ${name}`);
      return handler(args);
    },
  );
  return {
    call: call as unknown as <T>(
      name: string,
      args?: Record<string, unknown>,
    ) => Promise<T>,
    calls: call,
  };
}

// The error the canary's MCP client raises for a tool that answered isError,
// carrying the code the reply text named.
function unconfirmedCancel(): CanaryMcpToolError {
  return new CanaryMcpToolError(
    "runs.cancel",
    JSON.stringify({
      error: {
        code: "CONFLICT",
        message:
          "The cancel could not be confirmed on this attempt and nothing was torn down",
        retryable: true,
        retryAfterMs: 5_000,
      },
    }),
  );
}

// A clock the canary's waits advance instead of taking: a budget is spent in
// the time the canary asked to sleep, and every sleep is recorded.
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    clock: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
    sleeps,
  };
}

// The run level runs.logs reply as far as the sweep reads it: the definition
// the run's capture was taken from, null when there is no capture.
function capturedDefinition(definitionId: number | null) {
  return { replay: { definitionId } };
}

function cancelKeys(calls: ReturnType<typeof fakeMcp>["calls"]): unknown[] {
  return calls.mock.calls
    .filter(([name]) => name === "runs.cancel")
    .map(([, args]) => (args as { idempotencyKey?: unknown }).idempotencyKey);
}

function listedFixtures() {
  return {
    workflows: (["claude", "codex", "custom"] as const).map((label) => ({
      definitionId: ENGINE_CANARY_FIXTURES[label].workflowId,
      name: `Engine canary: ${label}`,
      enabled: false,
      deployedVersion: ENGINE_CANARY_FIXTURES[label].deployedVersion,
      deployedSchema: "v2" as const,
      triggers: [
        {
          triggerNodeId: "trigger",
          triggerType: "trigger_ticket_ai",
          manuallyDispatchable: true,
        },
      ],
    })),
    truncated: false,
  };
}

function customRecord() {
  const fixture = ENGINE_CANARY_FIXTURES.custom;
  return {
    nodeId: "agent",
    reference: { profileId: fixture.profileId, version: fixture.profileVersion },
    manifest: {
      system: false,
      harness: { provider: "codex" },
      model: { id: "gpt-5.4-mini" },
    },
    skills: [
      {
        artifactHash: fixture.skillArtifactHash,
        name: fixture.skillName,
        source: { ...fixture.skillSource },
        fileCount: 1,
        totalBytes: 1,
      },
    ],
  };
}

function builtinRecord(provider: "claude" | "codex") {
  return {
    nodeId: "agent",
    reference: { profileId: `builtin-${provider}`, version: 3 },
    manifest: {
      system: true,
      harness: { provider },
      model: { id: provider === "claude" ? "sonnet" : "gpt-5.4" },
    },
    skills: [],
  };
}

function runLogs(
  label: "claude" | "codex" | "custom",
  record: unknown,
): CanaryRunLogsOverview {
  const fixture = ENGINE_CANARY_FIXTURES[label];
  return {
    replay: {
      availability: "available",
      manifest: {
        value: { harnesses: [record] },
        metadata: {
          redactions: {},
          truncated: false,
          originalBytes: 1,
          storedBytes: 1,
          unavailable: false,
          unavailableReason: null,
        },
      },
      manifestTruncated: false,
      definitionId: fixture.workflowId,
      definitionVersion: fixture.deployedVersion,
      attempts: [{ id: 1 }],
    },
  } as CanaryRunLogsOverview;
}

const CASE = {
  claude: {
    label: "claude" as const,
    workflowId: ENGINE_CANARY_FIXTURES.claude.workflowId,
    deployedVersion: ENGINE_CANARY_FIXTURES.claude.deployedVersion,
  },
  codex: {
    label: "codex" as const,
    workflowId: ENGINE_CANARY_FIXTURES.codex.workflowId,
    deployedVersion: ENGINE_CANARY_FIXTURES.codex.deployedVersion,
  },
  custom: {
    label: "custom" as const,
    workflowId: ENGINE_CANARY_FIXTURES.custom.workflowId,
    deployedVersion: ENGINE_CANARY_FIXTURES.custom.deployedVersion,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Harness Profile preview canary dry checks", () => {
  it("fails closed on missing confirmation, wrong host, or enabled authoring", () => {
    expect(parseHarnessCanaryEnv(completeEnv)).toMatchObject({
      ENGINE_CANARY_MCP_CLIENT_ID: "engine-canary-client",
      HARNESS_CANARY_TIMEOUT_MS: 900_000,
    });
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        HARNESS_CANARY_CONFIRM_PREVIEW_MUTATIONS: undefined,
      }),
    ).toThrow();
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        HARNESS_CANARY_EXPECTED_HOST: "production.example.test",
      }),
    ).toThrow();
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        NEXT_PUBLIC_HARNESS_PROFILE_AUTHORING_ENABLED: "1",
      }),
    ).toThrow();
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        ENGINE_CANARY_MCP_CLIENT_ID: undefined,
      }),
    ).toThrow();
  });

  it("needs no database connection string and drops one it is handed", () => {
    // The canary observes the target only through MCP, so a job that still
    // forwards DATABASE_URL neither breaks the parse nor reaches the canary.
    const parsed = parseHarnessCanaryEnv({
      ...completeEnv,
      DATABASE_URL: "postgresql://test:test@example.test/test",
    });
    expect(parsed).not.toHaveProperty("DATABASE_URL");
  });

  it("no longer requires fixture pins and ignores unknown keys rather than rejecting them", () => {
    // parseHarnessCanaryEnv parses process.env, which always carries names
    // this contract never declared (PATH, CI, GITHUB_*), and, now that fixture
    // identity lives in engine-canary-fixtures.ts, ci.yml no longer forwards
    // the old pin names either. zod's default object mode strips unknown keys
    // instead of rejecting them, so a stale CI mapping that still sets one of
    // the retired pin names cannot break the job.
    expect(() =>
      parseHarnessCanaryEnv({
        ...completeEnv,
        HARNESS_CANARY_TICKET_KEY: "not-a-ticket",
        HARNESS_CANARY_CLAUDE_WORKFLOW_ID: "not-a-number",
        HARNESS_CANARY_CUSTOM_PROFILE_ID: undefined,
        PATH: "/usr/bin",
      }),
    ).not.toThrow();
  });
});

describe("engine canary fixtures", () => {
  const TICKET_KEY_PATTERN = /^AWP-\d+$/;
  const SKILL_ARTIFACT_HASH_PATTERN = /^[a-f0-9]{64}$/;
  const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

  it("declares exactly the three fixtures the canary dispatches", () => {
    expect(Object.keys(ENGINE_CANARY_FIXTURES).sort()).toEqual([
      "claude",
      "codex",
      "custom",
    ]);
  });

  it("pins a distinct definition id per fixture", () => {
    const definitionIds = [
      ENGINE_CANARY_FIXTURES.claude.workflowId,
      ENGINE_CANARY_FIXTURES.codex.workflowId,
      ENGINE_CANARY_FIXTURES.custom.workflowId,
    ];
    expect(new Set(definitionIds).size).toBe(definitionIds.length);
  });

  it("pins a deployed version per fixture", () => {
    for (const fixture of [
      ENGINE_CANARY_FIXTURES.claude,
      ENGINE_CANARY_FIXTURES.codex,
      ENGINE_CANARY_FIXTURES.custom,
    ]) {
      expect(Number.isInteger(fixture.deployedVersion)).toBe(true);
      expect(fixture.deployedVersion).toBeGreaterThan(0);
    }
  });

  it("runs every fixture on its own permanent ticket", () => {
    const ticketKeys = [
      ENGINE_CANARY_FIXTURES.claude.ticketKey,
      ENGINE_CANARY_FIXTURES.codex.ticketKey,
      ENGINE_CANARY_FIXTURES.custom.ticketKey,
    ];
    for (const ticketKey of ticketKeys) {
      expect(ticketKey).toMatch(TICKET_KEY_PATTERN);
    }
    expect(new Set(ticketKeys).size).toBe(ticketKeys.length);
  });

  it("pins the custom profile's skill artifact hash and commit sha in the exact hash formats", () => {
    expect(ENGINE_CANARY_FIXTURES.custom.skillArtifactHash).toMatch(
      SKILL_ARTIFACT_HASH_PATTERN,
    );
    expect(ENGINE_CANARY_FIXTURES.custom.skillSource.commitSha).toMatch(
      COMMIT_SHA_PATTERN,
    );
  });
});

describe("canary observations: identity before dispatch", () => {
  // Red when: the default canary runs the built-in Opus and Codex cases, which
  // spend real model money on every run and fail on a provider account rather
  // than on the code under test. The default is the one cheap custom case.
  it("runs only the custom Haiku case unless all three are asked for", () => {
    const cases = resolveCanaryCases(listedFixtures());

    expect(cases.map((canary) => canary.label)).toEqual(["custom"]);
    expect(cases[0]!.workflowId).toBe(ENGINE_CANARY_FIXTURES.custom.workflowId);
    expect(ENGINE_CANARY_FIXTURES.custom.workflowId).toBe(38);
  });

  it("reads the case selection from the environment and refuses anything else", () => {
    expect(canaryCaseSelection({})).toBe("custom");
    expect(canaryCaseSelection({ ENGINE_CANARY_CASES: "" })).toBe("custom");
    expect(canaryCaseSelection({ ENGINE_CANARY_CASES: "all" })).toBe("all");
    expect(() => canaryCaseSelection({ ENGINE_CANARY_CASES: "codex" })).toThrow(
      /ENGINE_CANARY_CASES must be "custom" or "all"/,
    );
  });

  it("resolves one case per fixture from workflows.list when all are asked for", () => {
    const cases = resolveCanaryCases(listedFixtures(), "all");

    expect(cases.map((canary) => canary.label)).toEqual([
      "claude",
      "codex",
      "custom",
    ]);
    for (const canary of cases) {
      const fixture = ENGINE_CANARY_FIXTURES[canary.label];
      expect(canary).toMatchObject({
        workflowId: fixture.workflowId,
        ticketKey: fixture.ticketKey,
        deployedVersion: fixture.deployedVersion,
        triggerNodeId: "trigger",
      });
    }
  });

  it("fails when a fixture definition is missing", () => {
    const listed = listedFixtures();
    listed.workflows = listed.workflows.filter(
      (workflow) =>
        workflow.definitionId !== ENGINE_CANARY_FIXTURES.codex.workflowId,
    );
    expect(() => resolveCanaryCases(listed, "all")).toThrow(/codex.*not listed/);
  });

  it("fails when a fixture definition is enabled", () => {
    const listed = listedFixtures();
    listed.workflows[0]!.enabled = true;
    expect(() => resolveCanaryCases(listed, "all")).toThrow(/must stay disabled/);
  });

  it("fails when the deployed version is not the pinned one", () => {
    const listed = listedFixtures();
    listed.workflows[2]!.deployedVersion =
      ENGINE_CANARY_FIXTURES.custom.deployedVersion + 1;
    let message = "";
    try {
      resolveCanaryCases(listed);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/deploys version .* the fixture file pins/);
    // The pin is the only review a republished fixture graph gets, so the
    // failure says where the pin lives and what to check before moving it.
    expect(message).toContain(
      "apps/worker/e2e/harness-profiles/engine-canary-fixtures.ts",
    );
    expect(message).toMatch(/two nodes, one edge, workspaceMode "none"/);
    expect(message).toMatch(/profile pin/);
  });

  it("fails when the trigger is not one manually dispatchable ticket trigger", () => {
    const listed = listedFixtures();
    listed.workflows[1]!.triggers[0]!.manuallyDispatchable = false;
    expect(() => resolveCanaryCases(listed, "all")).toThrow(
      /one manually dispatchable ticket trigger/,
    );
  });

  it("fails when the list is truncated", () => {
    expect(() =>
      resolveCanaryCases({ ...listedFixtures(), truncated: true }),
    ).toThrow(/truncated/);
  });
});

describe("canary observations: identity after the run", () => {
  it("passes on a custom manifest that matches the fixture file", () => {
    expect(() =>
      assertCanaryRunIdentity(runLogs("custom", customRecord()), CASE.custom),
    ).not.toThrow();
  });

  it("passes on the built-in profiles", () => {
    expect(() =>
      assertCanaryRunIdentity(
        runLogs("claude", builtinRecord("claude")),
        CASE.claude,
      ),
    ).not.toThrow();
    expect(() =>
      assertCanaryRunIdentity(
        runLogs("codex", builtinRecord("codex")),
        CASE.codex,
      ),
    ).not.toThrow();
  });

  type CustomRecord = ReturnType<typeof customRecord>;
  it.each<[string, (record: CustomRecord) => void, RegExp]>([
    [
      "profile id",
      (record) => {
        record.reference.profileId = "another-profile";
      },
      /did not capture the custom Harness Profile/,
    ],
    [
      "profile version",
      (record) => {
        record.reference.version += 1;
      },
      /profile version .* the fixture file pins/,
    ],
    [
      "skill name",
      (record) => {
        record.skills[0]!.name = "another-skill";
      },
      /skill name/,
    ],
    [
      "artifact hash",
      (record) => {
        record.skills[0]!.artifactHash = "f".repeat(64);
      },
      /skill artifact hash/,
    ],
    [
      "source owner",
      (record) => {
        record.skills[0]!.source.owner = "someone-else";
      },
      /skill source owner/,
    ],
    [
      "source repository",
      (record) => {
        record.skills[0]!.source.repository = "another-repository";
      },
      /skill source repository/,
    ],
    [
      "source path",
      (record) => {
        record.skills[0]!.source.path = ".claude/skills/other";
      },
      /skill source path/,
    ],
    [
      "source commit sha",
      (record) => {
        record.skills[0]!.source.commitSha = "0".repeat(40);
      },
      /skill source commitSha/,
    ],
    [
      "model",
      (record) => {
        record.manifest.model.id = "gpt-5.4";
      },
      /must use gpt-5\.4-mini/,
    ],
    [
      "system flag",
      (record) => {
        record.manifest.system = true;
      },
      /system profile/,
    ],
  ])("fails when the custom manifest's %s does not match", (_field, mutate, message) => {
    const record = customRecord();
    mutate(record);
    expect(() =>
      assertCanaryRunIdentity(runLogs("custom", record), CASE.custom),
    ).toThrow(message);
  });

  it("fails when the skill source is not a GitHub import", () => {
    const record = customRecord();
    (record.skills[0] as { source: unknown }).source = {
      kind: "local",
      path: "skills/gate-ladder",
      digest: "a".repeat(64),
    };
    expect(() =>
      assertCanaryRunIdentity(runLogs("custom", record), CASE.custom),
    ).toThrow(/GitHub/);
  });

  it("fails when the run captured another definition or version", () => {
    const otherDefinition = runLogs("custom", customRecord());
    otherDefinition.replay.definitionId = 999;
    expect(() =>
      assertCanaryRunIdentity(otherDefinition, CASE.custom),
    ).toThrow(/definition 999/);

    const otherVersion = runLogs("custom", customRecord());
    otherVersion.replay.definitionVersion =
      ENGINE_CANARY_FIXTURES.custom.deployedVersion + 1;
    expect(() => assertCanaryRunIdentity(otherVersion, CASE.custom)).toThrow(
      /definition version/,
    );
  });

  it("fails when a built-in run used another provider or a non-system profile", () => {
    const wrongProvider = builtinRecord("claude");
    wrongProvider.manifest.harness.provider = "codex";
    expect(() =>
      assertCanaryRunIdentity(runLogs("claude", wrongProvider), CASE.claude),
    ).toThrow(/provider codex/);

    const notSystem = builtinRecord("codex");
    notSystem.manifest.system = false;
    expect(() =>
      assertCanaryRunIdentity(runLogs("codex", notSystem), CASE.codex),
    ).toThrow(/system profile/);
  });

  it("fails when the manifest is missing or truncated", () => {
    const missing = runLogs("claude", builtinRecord("claude"));
    missing.replay.manifest = null;
    expect(() => assertCanaryRunIdentity(missing, CASE.claude)).toThrow(
      /Harness Profile manifest/,
    );

    const truncated = runLogs("claude", builtinRecord("claude"));
    truncated.replay.manifestTruncated = true;
    expect(() => assertCanaryRunIdentity(truncated, CASE.claude)).toThrow(
      /Harness Profile manifest/,
    );
  });
});

describe("canary observations: claims and ticket hygiene", () => {
  it("reads the Ai column from the target's settings", async () => {
    const mcp = fakeMcp({
      "settings.get": (args) => {
        expect(args).toMatchObject({ key: "COLUMN_AI" });
        return { setting: { key: "COLUMN_AI", value: "Ai" } };
      },
    });
    await expect(readAiColumn(mcp)).resolves.toBe("Ai");

    const blank = fakeMcp({
      "settings.get": () => ({ setting: { key: "COLUMN_AI", value: " " } }),
    });
    await expect(readAiColumn(blank)).rejects.toThrow(/COLUMN_AI/);
  });

  it("passes ticket hygiene when the fixture ticket is outside the Ai column", async () => {
    const mcp = fakeMcp({
      "tickets.get": () => ({ ticketKey: "AWP-180", status: "Do zrobienia" }),
    });
    await expect(
      assertFixtureTicketOutsideAiColumn(mcp, "AWP-180", "Ai"),
    ).resolves.toBeUndefined();
    expect(mcp.calls).toHaveBeenCalledWith("tickets.get", {
      ticketKey: "AWP-180",
    });
  });

  it("fails ticket hygiene when the fixture ticket is still in Ai, printing the status", async () => {
    for (const status of ["Ai", "AI"]) {
      const mcp = fakeMcp({
        "tickets.get": () => ({ ticketKey: "AWP-176", status }),
      });
      await expect(
        assertFixtureTicketOutsideAiColumn(mcp, "AWP-176", "Ai"),
      ).rejects.toThrow(new RegExp(`AWP-176 is still in the Ai column \\(status "${status}"\\)`));
    }
  });

  it("fails ticket hygiene when the key resolves to another ticket", async () => {
    const mcp = fakeMcp({
      "tickets.get": () => ({ ticketKey: "AWP-1", status: "Do zrobienia" }),
    });
    await expect(
      assertFixtureTicketOutsideAiColumn(mcp, "AWP-176", "Ai"),
    ).rejects.toThrow(/did not resolve/);
  });

  it("releases a finished run through runs.cancel and accepts already_terminal", async () => {
    const mcp = fakeMcp({
      "runs.cancel": () => ({ runId: "wrun_done", outcome: "already_terminal" }),
    });
    await expect(releaseCanaryRun(mcp, "wrun_done")).resolves.toBeUndefined();
    expect(mcp.calls).toHaveBeenCalledOnce();
    expect(mcp.calls).toHaveBeenCalledWith("runs.cancel", {
      runId: "wrun_done",
      idempotencyKey: expect.stringMatching(UUID_PATTERN),
    });
  });

  it("fails the release when runs.cancel had to cancel a run the canary saw finish", async () => {
    const mcp = fakeMcp({
      "runs.cancel": () => ({ runId: "wrun_live", outcome: "cancelled" }),
    });
    const { clock } = fakeClock();
    await expect(releaseCanaryRun(mcp, "wrun_live", clock)).rejects.toThrow(
      /wrun_live was still live/,
    );
    expect(mcp.calls).toHaveBeenCalledOnce();
  });

  it("retries an unconfirmed release under the same key until it converges", async () => {
    let answered = 0;
    const mcp = fakeMcp({
      "runs.cancel": (args) => {
        answered += 1;
        if (answered <= 2) throw unconfirmedCancel();
        return { runId: args.runId, outcome: "already_terminal" };
      },
    });
    const { clock, sleeps } = fakeClock();

    await expect(
      releaseCanaryRun(mcp, "wrun_retiring", clock),
    ).resolves.toBeUndefined();

    expect(mcp.calls).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 5_000]);
    const keys = cancelKeys(mcp.calls);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(UUID_PATTERN);
  });

  it("keeps releasing through 140 s of unconfirmed answers, longer than the two minute retiring window", async () => {
    const { clock } = fakeClock();
    const mcp = fakeMcp({
      "runs.cancel": (args) => {
        if (clock.now() < 140_000) throw unconfirmedCancel();
        return { runId: args.runId, outcome: "already_terminal" };
      },
    });

    await expect(
      releaseCanaryRun(mcp, "wrun_retiring", clock),
    ).resolves.toBeUndefined();
    expect(clock.now()).toBeGreaterThanOrEqual(140_000);
  });

  it("fails the release when runs.cancel stays unconfirmed past the budget, printing the last reply", async () => {
    const mcp = fakeMcp({
      "runs.cancel": () => {
        throw unconfirmedCancel();
      },
    });
    const { clock } = fakeClock();

    await expect(releaseCanaryRun(mcp, "wrun_stuck", clock)).rejects.toThrow(
      /wrun_stuck within \d+ s.*CONFLICT.*could not be confirmed on this attempt/,
    );
    // The budget outlasts the retiring window with room to spare.
    expect(clock.now()).toBeGreaterThanOrEqual(150_000);
  });

  it("says the cancel overwrote a finished run's outcome when the release gets cancelled after unconfirmed answers", async () => {
    let answered = 0;
    const mcp = fakeMcp({
      "runs.cancel": (args) => {
        answered += 1;
        if (answered <= 2) throw unconfirmedCancel();
        return { runId: args.runId, outcome: "cancelled" };
      },
    });
    const { clock } = fakeClock();

    let message = "";
    try {
      await releaseCanaryRun(mcp, "wrun_unretired", clock);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/wrun_unretired/);
    expect(message).toMatch(/did not retire the run within the two minute window/);
    expect(message).toMatch(/the cancel overwrote its outcome/);
    expect(message).not.toMatch(/was still live/);
  });

  it("does not retry a refusal that is not an unconfirmed cancel", async () => {
    const mcp = fakeMcp({
      "runs.cancel": () => {
        throw new CanaryMcpToolError(
          "runs.cancel",
          JSON.stringify({ error: { code: "NOT_FOUND", message: "Run not found" } }),
        );
      },
    });
    const { clock } = fakeClock();
    await expect(releaseCanaryRun(mcp, "wrun_ghost", clock)).rejects.toThrow(
      /wrun_ghost.*NOT_FOUND/,
    );
    expect(mcp.calls).toHaveBeenCalledOnce();
  });

  it("waits while the run's completion is pending and returns once it settles", async () => {
    let results = 0;
    const sleeps: number[] = [];
    const mcp = fakeMcp({
      "runs.get": () => ({
        runId: "wrun_settling",
        status: "success",
        terminal: true,
        pollAfterMs: 0,
      }),
      "runs.result": () => {
        results += 1;
        return results === 1
          ? {
              status: "success",
              terminal: true,
              completionPending: true,
              pendingUntil: new Date(60_000).toISOString(),
              result: null,
              pollAfterMs: 2_000,
            }
          : {
              status: "success",
              terminal: true,
              completionPending: false,
              pendingUntil: null,
              result: { error: null, completedAt: new Date(1).toISOString() },
              pollAfterMs: 0,
            };
      },
    });

    await expect(
      waitForSuccessfulRun(mcp, "wrun_settling", 900_000, {
        now: () => 1_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).resolves.toBeUndefined();

    expect(results).toBe(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("fails when the completion is still pending past pendingUntil", async () => {
    let clock = 1_000;
    const mcp = fakeMcp({
      "runs.get": () => ({
        runId: "wrun_unsettled",
        status: "success",
        terminal: true,
        pollAfterMs: 0,
      }),
      "runs.result": () => ({
        status: "success",
        terminal: true,
        completionPending: true,
        pendingUntil: new Date(10_000).toISOString(),
        result: null,
        pollAfterMs: 2_000,
      }),
    });

    await expect(
      waitForSuccessfulRun(mcp, "wrun_unsettled", 900_000, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/wrun_unsettled succeeded but its completion never settled/);
  });

  it("fails at once when the run ended in anything but success", async () => {
    const mcp = fakeMcp({
      "runs.get": () => ({
        runId: "wrun_failed",
        status: "failed",
        terminal: true,
        pollAfterMs: 0,
      }),
      "runs.result": () => ({
        status: "failed",
        terminal: true,
        completionPending: false,
        pendingUntil: null,
        result: { error: { code: "x" } },
        pollAfterMs: 0,
      }),
    });
    await expect(
      waitForSuccessfulRun(mcp, "wrun_failed", 900_000, {
        now: () => 1_000,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/wrun_failed ended as failed/);
  });

  it("still leaves the target clean when the release itself fails, printing the ticket status", async () => {
    let cancels = 0;
    const mcp = fakeMcp({
      "runs.cancel": (args) => {
        cancels += 1;
        return {
          runId: args.runId,
          outcome: cancels === 1 ? "cancelled" : "already_terminal",
        };
      },
      "tickets.get": () => ({ ticketKey: "AWP-180", status: "Ai" }),
    });
    const observe = vi.fn(async () => {});
    const { clock } = fakeClock();

    let message = "";
    try {
      await finishCanaryRun(
        mcp,
        { runId: "wrun_release", ticketKey: "AWP-180", aiColumn: "Ai" },
        observe,
        clock,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(observe).toHaveBeenCalledOnce();
    expect(message).toMatch(/wrun_release was still live/);
    expect(message).toMatch(
      /leaving the target clean also failed: .*AWP-180 is still in the Ai column \(status "Ai"\)/,
    );
    expect(mcp.calls.mock.calls.map(([name]) => name)).toEqual([
      "runs.cancel",
      "runs.cancel",
      "tickets.get",
    ]);
  });

  it("releases and checks hygiene after a run whose observations passed", async () => {
    const mcp = fakeMcp({
      "runs.cancel": (args) => ({ runId: args.runId, outcome: "already_terminal" }),
      "tickets.get": () => ({ ticketKey: "AWP-176", status: "Do zrobienia" }),
    });
    await expect(
      finishCanaryRun(
        mcp,
        { runId: "wrun_ok", ticketKey: "AWP-176", aiColumn: "Ai" },
        async () => {},
      ),
    ).resolves.toBeUndefined();
    expect(mcp.calls.mock.calls.map(([name]) => name)).toEqual([
      "runs.cancel",
      "tickets.get",
    ]);
  });

  it("settles the newest run and every live run of the fixture definition on the ticket, then checks hygiene", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancelled: string[] = [];
    const read: string[] = [];
    let strayAnswers = 0;
    const mcp = fakeMcp({
      "tickets.list_runs": (args) => {
        expect(args).toMatchObject({ ticketKey: "AWP-179" });
        return {
          runs: [
            { runId: "wrun_newest", status: "success", terminal: true },
            { runId: "wrun_stray", status: "running", terminal: false },
            { runId: "wrun_old", status: "failed", terminal: true },
          ],
          truncated: false,
        };
      },
      "runs.logs": (args) => {
        expect(Object.keys(args)).toEqual(["runId"]);
        read.push(String(args.runId));
        return capturedDefinition(ENGINE_CANARY_FIXTURES.codex.workflowId);
      },
      "runs.cancel": (args) => {
        cancelled.push(String(args.runId));
        if (args.runId !== "wrun_stray") {
          return { runId: args.runId, outcome: "already_terminal" };
        }
        strayAnswers += 1;
        return {
          runId: args.runId,
          outcome: strayAnswers === 1 ? "cancelled" : "already_terminal",
        };
      },
      "tickets.get": () => ({ ticketKey: "AWP-179", status: "Do zrobienia" }),
    });
    const { clock, sleeps } = fakeClock();

    await sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.codex, "Ai", clock);

    expect(read).toEqual(["wrun_newest", "wrun_stray"]);
    expect(cancelled).toEqual(["wrun_newest", "wrun_stray", "wrun_stray"]);
    const keys = cancelKeys(mcp.calls);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(UUID_PATTERN);
    expect(sleeps).toEqual([10_000]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/cancelled live run wrun_stray on AWP-179/),
    );
    expect(mcp.calls.mock.calls.at(-1)?.[0]).toBe("tickets.get");
  });

  it("converges a predecessor's live run that answers cancelled while it drains, asking again under a fresh key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let answers = 0;
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_killed", status: "running", terminal: false }],
        truncated: false,
      }),
      "runs.logs": () =>
        capturedDefinition(ENGINE_CANARY_FIXTURES.custom.workflowId),
      "runs.cancel": (args) => {
        answers += 1;
        return {
          runId: args.runId,
          outcome: answers < 3 ? "cancelled" : "already_terminal",
        };
      },
      "tickets.get": () => ({ ticketKey: "AWP-180", status: "Do zrobienia" }),
    });
    const { clock, sleeps } = fakeClock();

    await expect(
      sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.custom, "Ai", clock),
    ).resolves.toBeUndefined();

    expect(answers).toBe(3);
    expect(new Set(cancelKeys(mcp.calls)).size).toBe(3);
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/cancelled live run wrun_killed on AWP-180/),
    );
  });

  it("converges a run that is still being retired instead of failing on the first unconfirmed answer", async () => {
    let answers = 0;
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_held", status: "success", terminal: true }],
        truncated: false,
      }),
      "runs.logs": () =>
        capturedDefinition(ENGINE_CANARY_FIXTURES.claude.workflowId),
      "runs.cancel": (args) => {
        answers += 1;
        if (answers === 1) throw unconfirmedCancel();
        return { runId: args.runId, outcome: "already_terminal" };
      },
      "tickets.get": () => ({ ticketKey: "AWP-176", status: "Do zrobienia" }),
    });
    const { clock, sleeps } = fakeClock();

    await expect(
      sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock),
    ).resolves.toBeUndefined();

    expect(mcp.calls.mock.calls.map(([name]) => name)).toEqual([
      "tickets.list_runs",
      "runs.logs",
      "runs.cancel",
      "runs.cancel",
      "tickets.get",
    ]);
    expect(new Set(cancelKeys(mcp.calls)).size).toBe(2);
    expect(sleeps).toEqual([10_000]);
  });

  it.each([
    ["cancelled", () => ({ runId: "wrun_stuck", outcome: "cancelled" }), /cancelled/],
    [
      "unconfirmed",
      () => {
        throw unconfirmedCancel();
      },
      /CONFLICT/,
    ],
  ])("fails once the settle budget is spent on %s answers, naming the run, the last answer and the ticket that may still be in Ai", async (_case, answer, lastAnswer) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_stuck", status: "running", terminal: false }],
        truncated: false,
      }),
      "runs.logs": () =>
        capturedDefinition(ENGINE_CANARY_FIXTURES.claude.workflowId),
      "runs.cancel": answer,
    });
    const { clock, sleeps } = fakeClock();

    let message = "";
    try {
      await sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/wrun_stuck/);
    expect(message).toMatch(lastAnswer);
    expect(message).toMatch(/AWP-176 may still be in the Ai column/);
    // About five minutes, one attempt every ten seconds, every one a new key.
    expect(clock.now()).toBeGreaterThanOrEqual(290_000);
    expect(clock.now()).toBeLessThanOrEqual(310_000);
    expect(new Set(sleeps)).toEqual(new Set([10_000]));
    const keys = cancelKeys(mcp.calls);
    expect(keys.length).toBeGreaterThan(20);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves a live run of another definition untouched and fails the precondition, naming who must settle it", async () => {
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_prod", status: "running", terminal: false }],
        truncated: false,
      }),
      "runs.logs": () => capturedDefinition(12),
    });
    const { clock } = fakeClock();

    let message = "";
    try {
      await sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/AWP-176/);
    expect(message).toMatch(/wrun_prod/);
    expect(message).toMatch(/definition 12\b/);
    expect(message).toMatch(/production owns it and must settle it first/i);
    expect(mcp.calls.mock.calls.map(([name]) => name)).toEqual([
      "tickets.list_runs",
      "runs.logs",
    ]);
  });

  it.each([
    ["no captured definition", () => capturedDefinition(null), /no captured definition/],
    ["no replay section", () => ({}), /no captured definition/],
    [
      "a refused read",
      () => {
        throw new CanaryMcpToolError(
          "runs.logs",
          JSON.stringify({ error: { code: "NOT_FOUND", message: "no capture" } }),
        );
      },
      /NOT_FOUND.*no capture/,
    ],
  ])("leaves a live run untouched when runs.logs shows %s, without claiming production owns it", async (_case, logs, reason) => {
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_unknown", status: "running", terminal: false }],
        truncated: false,
      }),
      "runs.logs": logs,
    });
    const { clock } = fakeClock();

    let message = "";
    try {
      await sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(
      /AWP-176.*wrun_unknown.*could not be read from runs\.logs/s,
    );
    expect(message).toMatch(reason);
    expect(message).toMatch(/unknown whose run it is.*nothing was touched/s);
    expect(message).not.toMatch(/production owns it/i);
    expect(mcp.calls.mock.calls.map(([name]) => name)).not.toContain(
      "runs.cancel",
    );
  });

  it("leaves a finished run of another definition untouched and carries on", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_prod_done", status: "success", terminal: true }],
        truncated: false,
      }),
      "runs.logs": () => capturedDefinition(12),
      "tickets.get": () => ({ ticketKey: "AWP-176", status: "Do zrobienia" }),
    });
    const { clock } = fakeClock();

    await expect(
      sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock),
    ).resolves.toBeUndefined();
    expect(mcp.calls.mock.calls.map(([name]) => name)).toEqual([
      "tickets.list_runs",
      "runs.logs",
      "tickets.get",
    ]);
  });

  it.each([
    ["no run to cancel", []],
    [
      "only a finished run",
      [{ runId: "wrun_done", status: "success", terminal: true }],
    ],
  ])("blames a move outside the canary when the ticket sits in Ai with %s", async (_case, runs) => {
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({ runs, truncated: false }),
      "runs.logs": () =>
        capturedDefinition(ENGINE_CANARY_FIXTURES.claude.workflowId),
      "runs.cancel": (args) => ({ runId: args.runId, outcome: "already_terminal" }),
      "tickets.get": () => ({ ticketKey: "AWP-176", status: "Ai" }),
    });
    const { clock } = fakeClock();
    let message = "";
    try {
      await sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(
      /AWP-176 is in the Ai column \(status "Ai"\) with no live run: it was moved into Ai outside the canary/,
    );
    expect(message).toMatch(/move it back to "Do zrobienia"/);
    expect(message).not.toMatch(/after runs\.cancel/);
  });

  it("blames runs.cancel when the ticket stays in Ai after the sweep cancelled a live run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let answers = 0;
    const mcp = fakeMcp({
      "tickets.list_runs": () => ({
        runs: [{ runId: "wrun_stray", status: "running", terminal: false }],
        truncated: false,
      }),
      "runs.logs": () =>
        capturedDefinition(ENGINE_CANARY_FIXTURES.claude.workflowId),
      "runs.cancel": (args) => {
        answers += 1;
        return {
          runId: args.runId,
          outcome: answers === 1 ? "cancelled" : "already_terminal",
        };
      },
      "tickets.get": () => ({ ticketKey: "AWP-176", status: "Ai" }),
    });
    const { clock } = fakeClock();
    await expect(
      sweepFixtureTicket(mcp, ENGINE_CANARY_FIXTURES.claude, "Ai", clock),
    ).rejects.toThrow(
      /AWP-176 is still in the Ai column \(status "Ai"\) after runs\.cancel/,
    );
  });

  it("cancels a failed or timed out run, waits for it to settle, and checks hygiene before reporting the failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let answers = 0;
    const mcp = fakeMcp({
      "runs.cancel": (args) => {
        answers += 1;
        return {
          runId: args.runId,
          outcome: answers === 1 ? "cancelled" : "already_terminal",
        };
      },
      "tickets.get": () => ({ ticketKey: "AWP-180", status: "Do zrobienia" }),
    });
    const { clock, sleeps } = fakeClock();

    await expect(
      leaveTargetAfterFailedRun(mcp, "wrun_timeout", "AWP-180", "Ai", clock),
    ).resolves.toBeNull();

    expect(mcp.calls.mock.calls.map(([name]) => name)).toEqual([
      "runs.cancel",
      "runs.cancel",
      "tickets.get",
    ]);
    expect(mcp.calls).toHaveBeenCalledWith("runs.cancel", {
      runId: "wrun_timeout",
      idempotencyKey: expect.stringMatching(UUID_PATTERN),
    });
    expect(new Set(cancelKeys(mcp.calls)).size).toBe(2);
    expect(sleeps).toEqual([10_000]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/cancelled live run wrun_timeout on AWP-180/),
    );
  });

  it("warns that the cancel overwrote a finished run's outcome when cleanup gets cancelled after unconfirmed answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let answers = 0;
    const mcp = fakeMcp({
      "runs.cancel": (args) => {
        answers += 1;
        if (answers === 1) throw unconfirmedCancel();
        return {
          runId: args.runId,
          outcome: answers === 2 ? "cancelled" : "already_terminal",
        };
      },
      "tickets.get": () => ({ ticketKey: "AWP-180", status: "Do zrobienia" }),
    });
    const { clock } = fakeClock();

    await expect(
      leaveTargetAfterFailedRun(mcp, "wrun_failed_alone", "AWP-180", "Ai", clock),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledOnce();
    const [line] = warn.mock.calls[0] as [string];
    expect(line).toMatch(/wrun_failed_alone on AWP-180/);
    expect(line).toMatch(/Workflow did not retire it within the two minute window/);
    expect(line).toMatch(/the cancel overwrote its outcome/);
    expect(line).not.toMatch(/was still live/);
  });

  it("names why the cleanup after a failed run did not leave the target clean", async () => {
    const unconfirmed = fakeMcp({
      "runs.cancel": () => {
        throw unconfirmedCancel();
      },
    });
    const { clock } = fakeClock();
    await expect(
      leaveTargetAfterFailedRun(unconfirmed, "wrun_failed", "AWP-180", "Ai", clock),
    ).resolves.toMatch(/wrun_failed.*CONFLICT.*AWP-180 may still be in the Ai column/s);

    const stillInAi = fakeMcp({
      "runs.cancel": (args) => ({ runId: args.runId, outcome: "already_terminal" }),
      "tickets.get": () => ({ ticketKey: "AWP-180", status: "Ai" }),
    });
    await expect(
      leaveTargetAfterFailedRun(stillInAi, "wrun_failed", "AWP-180", "Ai"),
    ).resolves.toMatch(/still in the Ai column \(status "Ai"\)/);
  });
});
