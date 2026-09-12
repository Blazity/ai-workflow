import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_REGISTRY } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { readAllSettings, seedSettings, writeManySettings } from "../../db/repositories/settings.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {} as Record<string, unknown>,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
// The environment import is a write, and this file is about the READ: with it
// running, every variable a case stubs would be a stored row by the time the
// case looked, and "where did this value come from" would answer "stored" for
// all of them. Its own behaviour is pinned in environment-import.test.ts,
// including the fact that it runs at the first snapshot.
vi.mock("./environment-import.js", () => ({
  ensureEnvironmentSettingsImported: async () => {},
  migratedVariablesSet: () => [],
}));

const {
  loadSettingsResolution,
  loadSettingsSnapshot,
  settingsSnapshotFromEnvironment,
  settingsSeedRows,
} = await import("./snapshot.js");
const {
  agentRuntimeSettings,
  dashboardOrganizationSettings,
  maxConcurrentAgents,
  mcpSettings,
} = await import("./runtime-settings.js");
const { ticketBoardSettings, triggerRateLimitDefaults } = await import(
  "./integration-settings.js"
);

let db: Db;

/** What the deployment's parsed environment holds today, in miniature. */
function environmentAsDeployed(): Record<string, unknown> {
  return {
    DASHBOARD_ORG_NAME: "Acme",
    DASHBOARD_ORG_SLUG: "acme",
    DASHBOARD_ORIGIN: "https://dash.acme.test",
    GITHUB_BASE_BRANCH: "main",
    GITLAB_BASE_BRANCH: "trunk",
    MAX_CONCURRENT_AGENTS: 7,
    JOB_TIMEOUT_MS: 1_800_000,
    POLL_INTERVAL_MS: 300_000,
    ATTACHMENT_MAX_FILE_SIZE_MB: 25,
    ATTACHMENT_MAX_TOTAL_SIZE_MB: 100,
    ATTACHMENT_MAX_COUNT: 20,
    ATTACHMENT_DOWNLOAD_TIMEOUT_MS: 30_000,
    ENABLE_REVIEW_PHASE: true,
    ENABLE_LEAK_REVIEW: false,
    ENABLE_REPO_MEMORY: true,
    ENABLE_ORG_MEMORY_PROMOTION: false,
    ENABLE_REPO_ROUTING_MEMORY: false,
    REVIEW_LEDGER_ENABLED: true,
    MCP_ENABLED: true,
    MCP_SERVER_VERSION: "0.1.0",
    MCP_ALLOW_PUBLIC_DCR: false,
    MCP_AUDIT_RETENTION_DAYS: 365,
    MCP_MAX_REQUEST_BYTES: 1_048_576,
    MCP_MAX_RESULT_BYTES: 524_288,
    MCP_TOOL_TIMEOUT_MS: 30_000,
    MCP_READ_RATE_LIMIT_PER_MINUTE: 120,
    MCP_MUTATION_RATE_LIMIT_PER_MINUTE: 20,
    AGENT_KIND: "codex",
    CLAUDE_MODEL: undefined,
    CODEX_MODEL: "gpt-5.6-codex",
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    JIRA_PROJECT_KEY: "AIW",
    JIRA_BASE_URL: "https://acme.atlassian.net",
    TRIGGER_RATE_LIMIT_MAX: 12,
    TRIGGER_RATE_LIMIT_WINDOW: "hour",
  };
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  db = await createTestDb();
  state.db = db;
  for (const key of Object.keys(state.env)) delete state.env[key];
  Object.assign(state.env, environmentAsDeployed());
});

describe("settings snapshot", () => {
  it("resolves every key from the environment when the table is empty", async () => {
    const snapshot = await loadSettingsSnapshot();

    // "Empty table plus environment equals today": the value of every key is
    // what the deployment's parsed environment already held, and the registry
    // default only where the environment holds nothing.
    expect(snapshot).toEqual(settingsSnapshotFromEnvironment());
    expect(snapshot.MAX_CONCURRENT_AGENTS).toBe(7);
    expect(snapshot.GITLAB_BASE_BRANCH).toBe("trunk");
    expect(snapshot.AGENT_KIND).toBe("codex");
    expect(snapshot.ENABLE_REPO_MEMORY).toBe(true);
    expect(snapshot.TRIGGER_RATE_LIMIT_WINDOW).toBe("hour");
    // Unset in the environment, so the registry default stands.
    expect(snapshot.CLAUDE_MODEL).toBeNull();
    expect(snapshot.V2_MAX_BLOCK_CONCURRENCY).toBeNull();
    expect(snapshot["catalog.activated"]).toBe(false);
    expect(snapshot.PRE_PR_COMMAND_TIMEOUT_MINUTES).toBe(10);
    expect(snapshot.PRE_PR_CHECKS_ALLOWED_ENV).toEqual([]);
  });

  it("covers every registry key with a plain value, never a promise", async () => {
    const snapshot = await loadSettingsSnapshot();
    const synchronous = settingsSnapshotFromEnvironment();

    for (const definition of SETTINGS_REGISTRY) {
      const key = definition.key as keyof typeof snapshot;
      expect(snapshot).toHaveProperty(definition.key);
      const value: unknown = snapshot[key];
      expect(value).not.toBeInstanceOf(Promise);
      expect(
        typeof (value as { then?: unknown })?.then === "function",
      ).toBe(false);
      expect(synchronous[key]).toEqual(value);
    }
    expect(Object.keys(snapshot).sort()).toEqual(
      SETTINGS_REGISTRY.map((definition) => definition.key).sort(),
    );
  });

  it("reads the checks keys the runner still reads raw", async () => {
    vi.stubEnv("PRE_PR_COMMAND_TIMEOUT_MINUTES", "25");
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", " NPM_TOKEN , ARTHUR_TOKEN,, ");

    const snapshot = await loadSettingsSnapshot();
    expect(snapshot.PRE_PR_COMMAND_TIMEOUT_MINUTES).toBe(25);
    expect(snapshot.PRE_PR_CHECKS_ALLOWED_ENV).toEqual(["NPM_TOKEN", "ARTHUR_TOKEN"]);

    vi.stubEnv("PRE_PR_COMMAND_TIMEOUT_MINUTES", "nonsense");
    expect(settingsSnapshotFromEnvironment().PRE_PR_COMMAND_TIMEOUT_MINUTES).toBe(10);
  });

  it("lets a stored row win over the environment", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1, CLAUDE_MODEL: "claude-opus-5" },
      actor: "user_admin",
      reason: "throttling",
    });

    const snapshot = await loadSettingsSnapshot();
    expect(snapshot.MAX_CONCURRENT_AGENTS).toBe(1);
    expect(snapshot.CLAUDE_MODEL).toBe("claude-opus-5");
    expect(snapshot.COLUMN_AI).toBe("AI");
  });

  it("names where each value came from", async () => {
    vi.stubEnv("COLUMN_AI", "AI");
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1 },
      actor: "user_admin",
      reason: "throttling",
    });

    const { sources } = await loadSettingsResolution();
    expect(sources.get("MAX_CONCURRENT_AGENTS")).toBe("stored");
    expect(sources.get("COLUMN_AI")).toBe("environment");
    expect(sources.get("catalog.activated")).toBe("default");
    expect(sources.get("CLAUDE_MODEL")).toBe("default");
  });

  it("offers one seed row per variable the deployment actually sets", () => {
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
    vi.stubEnv("COLUMN_AI", "AI");
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", "NPM_TOKEN");

    const rows = new Map(settingsSeedRows().map((row) => [row.key, row.value]));
    expect(rows.get("MAX_CONCURRENT_AGENTS")).toBe(7);
    expect(rows.get("COLUMN_AI")).toBe("AI");
    // No variable, so nothing to seed from; and an unset variable makes no row.
    expect(rows.has("catalog.activated")).toBe(false);
    expect(rows.has("CLAUDE_MODEL")).toBe(false);
    // Set, but the checks runner reads the variable itself inside a step, so a
    // stored row would decide nothing: `requiresRedeploy` keeps it out.
    expect(rows.has("PRE_PR_CHECKS_ALLOWED_ENV")).toBe(false);
  });

  it("seeds the same rows however often the build runs", async () => {
    vi.stubEnv("MAX_CONCURRENT_AGENTS", "7");
    vi.stubEnv("COLUMN_AI", "AI");

    const first = await seedSettings(db, {
      rows: settingsSeedRows(),
      actor: "environment",
    });
    const afterFirst = await readAllSettings(db);
    const second = await seedSettings(db, {
      rows: settingsSeedRows(),
      actor: "environment",
    });
    const afterSecond = await readAllSettings(db);

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    expect(afterSecond.map((row) => [row.key, row.value])).toEqual(
      afterFirst.map((row) => [row.key, row.value]),
    );
    const seeded = new Map(afterSecond.map((row) => [row.key, row.value]));
    expect(seeded.get("MAX_CONCURRENT_AGENTS")).toBe(7);
    expect(seeded.get("COLUMN_AI")).toBe("AI");
    expect(seeded.has("CLAUDE_MODEL")).toBe(false);
    // Seeded rows are the values already in force, so nothing changes.
    expect((await loadSettingsSnapshot()).MAX_CONCURRENT_AGENTS).toBe(7);
  });
});

describe("settings accessors", () => {
  it("answer from the snapshot synchronously, and follow the environment when nothing is stored", async () => {
    const snapshot = await loadSettingsSnapshot();

    expect(maxConcurrentAgents(snapshot)).toBe(7);
    expect(maxConcurrentAgents(snapshot)).not.toBeInstanceOf(Promise);
    expect(dashboardOrganizationSettings(snapshot)).toEqual({
      slug: "acme",
      name: "Acme",
      origin: "https://dash.acme.test",
    });
    expect(agentRuntimeSettings(snapshot)).toEqual({
      agentKind: "codex",
      includeReview: true,
      includeLeakReview: false,
    });
    expect(mcpSettings(snapshot)).toMatchObject({
      enabled: true,
      serverVersion: "0.1.0",
      maxResultBytes: 524_288,
    });
    expect(ticketBoardSettings(snapshot)).toMatchObject({
      projectKey: "AIW",
      aiColumn: "AI",
      aiReviewColumn: "AI Review",
      backlogColumn: "Backlog",
    });
    expect(triggerRateLimitDefaults(snapshot)).toEqual({
      TRIGGER_RATE_LIMIT_MAX: 12,
      TRIGGER_RATE_LIMIT_WINDOW: "hour",
    });
  });

  it("never return a promise, in either form", async () => {
    const snapshot = await loadSettingsSnapshot();
    // A literal list, not a loop over the registry: the registry says which
    // keys exist, and iterating it over the snapshot would stay green if an
    // accessor itself became async. Add every new accessor that reads a
    // migrated key here.
    const results: unknown[] = [
      maxConcurrentAgents(snapshot),
      dashboardOrganizationSettings(snapshot),
      mcpSettings(snapshot),
      agentRuntimeSettings(snapshot),
      ticketBoardSettings(snapshot),
      triggerRateLimitDefaults(snapshot),
    ];

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof (result as { then?: unknown })?.then === "function").toBe(false);
    }
  });

  it("follow a stored row once one exists", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 2, COLUMN_AI: "Agent", AGENT_KIND: "claude" },
      actor: "user_admin",
      reason: "tuning",
    });
    const snapshot = await loadSettingsSnapshot();

    expect(maxConcurrentAgents(snapshot)).toBe(2);
    expect(ticketBoardSettings(snapshot).aiColumn).toBe("Agent");
    expect(agentRuntimeSettings(snapshot).agentKind).toBe("claude");
  });
});
