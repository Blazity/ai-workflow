import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_REGISTRY } from "@shared/contracts";
import type { Db } from "../../db/client.js";
import { createTestDb } from "../../db/test-db.js";
import { writeManySettings } from "../../db/repositories/settings.js";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  env: {} as Record<string, unknown>,
}));

vi.mock("../../infra/vcs-config.js", () => ({ env: state.env }));
vi.mock("../../db/client.js", () => ({ getDb: () => state.db }));
// A board has a tracker half since S12, and that half is an integration's
// connection rather than a settings row. This suite is about the settings
// half, so it says only that a tracker is connected, and which project it
// names so the join can be seen.
vi.mock("../../engine/support/issue-tracker-runtime.js", () => ({
  trackerIdentityOf: (id: string, baseUrl: string) =>
    `${id}\u0000${baseUrl.trim().toLowerCase()}`,
  resolveActiveIssueTracker: async () => ({
    ok: true,
    id: "jira",
    name: "Jira",
    adapter: {},
    wiring: { projectKey: "AIW", baseUrl: "https://acme.atlassian.net" },
  }),
}));
const {
  loadSettingsResolution,
  loadSettingsSnapshot,
  settingsSnapshotFromEnvironment,
} = await import("./snapshot.js");
const {
  dashboardOrganizationSettings,
  maxConcurrentAgents,
  mcpSettings,
} = await import("./runtime-settings.js");
const { ticketBoardSettings } = await import("./integration-settings.js");

let db: Db;

/** What the deployment's parsed environment holds today, in miniature. */
function environmentAsDeployed(): Record<string, unknown> {
  return {
    DASHBOARD_ORG_NAME: "Acme",
    DASHBOARD_ORG_SLUG: "acme",
    DASHBOARD_ORIGIN: "https://dash.acme.test",
    MAX_CONCURRENT_AGENTS: 7,
    JOB_TIMEOUT_MS: 1_800_000,
    ATTACHMENT_MAX_FILE_SIZE_MB: 25,
    ATTACHMENT_MAX_TOTAL_SIZE_MB: 100,
    ATTACHMENT_MAX_COUNT: 20,
    ATTACHMENT_DOWNLOAD_TIMEOUT_MS: 30_000,
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
    COLUMN_AI: "AI",
    COLUMN_AI_REVIEW: "AI Review",
    COLUMN_BACKLOG: "Backlog",
    JIRA_PROJECT_KEY: "AIW",
    JIRA_BASE_URL: "https://acme.atlassian.net",
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
  it("resolves ordinary keys from defaults when the table is empty", async () => {
    const snapshot = await loadSettingsSnapshot();

    expect(snapshot).toEqual(settingsSnapshotFromEnvironment());
    expect(snapshot.MAX_CONCURRENT_AGENTS).toBe(3);
    expect(snapshot.ENABLE_REPO_MEMORY).toBe(false);
    expect(snapshot.V2_MAX_BLOCK_CONCURRENCY).toBeNull();
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

  it("reads only the redeploy-owned checks allowlist from the environment", async () => {
    vi.stubEnv("PRE_PR_COMMAND_TIMEOUT_MINUTES", "25");
    vi.stubEnv("PRE_PR_CHECKS_ALLOWED_ENV", " NPM_TOKEN , ARTHUR_TOKEN,, ");

    const snapshot = await loadSettingsSnapshot();
    expect(snapshot.PRE_PR_COMMAND_TIMEOUT_MINUTES).toBe(10);
    expect(snapshot.PRE_PR_CHECKS_ALLOWED_ENV).toEqual(["NPM_TOKEN", "ARTHUR_TOKEN"]);
  });

  it("resolves ordinary keys from stored rows while ignoring retired environment variables", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1, COLUMN_AI: "Agent" },
      actor: "user_admin",
      reason: "throttling",
    });

    const snapshot = await loadSettingsSnapshot();
    expect(snapshot.MAX_CONCURRENT_AGENTS).toBe(1);
    expect(snapshot.COLUMN_AI).toBe("Agent");
  });

  it("names where each value came from", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 1 },
      actor: "user_admin",
      reason: "throttling",
    });

    const { sources } = await loadSettingsResolution();
    expect(sources.get("MAX_CONCURRENT_AGENTS")).toBe("stored");
    expect(sources.get("COLUMN_AI")).toBe("default");
  });

});

describe("settings accessors", () => {
  it("answer from the snapshot synchronously", async () => {
    const snapshot = await loadSettingsSnapshot();

    expect(maxConcurrentAgents(snapshot)).toBe(3);
    expect(maxConcurrentAgents(snapshot)).not.toBeInstanceOf(Promise);
    expect(dashboardOrganizationSettings(snapshot)).toEqual({
      slug: "acme",
      name: "AI Workflow",
      origin: "https://dash.acme.test",
    });
    expect(mcpSettings(snapshot)).toMatchObject({
      enabled: false,
      serverVersion: "0.1.0",
      maxResultBytes: 524_288,
    });
  });

  it("reads the board's columns from the snapshot and its project from the connection", async () => {
    // The one accessor that is not synchronous, and deliberately so: since S12
    // its project and transition ids come from the tracker's connection, which
    // is a database read. Its columns still come from the snapshot passed in,
    // which is what keeps the poller and the dashboard agreeing on a renamed
    // column.
    const snapshot = await loadSettingsSnapshot();

    expect(await ticketBoardSettings(snapshot)).toMatchObject({
      trackerName: "Jira",
      projectKey: "AIW",
      aiColumn: "AI",
      aiReviewColumn: "AI Review",
      backlogColumn: "Backlog",
    });
  });

  it("never return a promise, in either form", async () => {
    const snapshot = await loadSettingsSnapshot();
    // A literal list, not a loop over the registry: the registry says which
    // keys exist, and iterating it over the snapshot would stay green if an
    // accessor itself became async. Add every new accessor that reads a
    // migrated key here. `ticketBoardSettings` is not on it: it alone reaches
    // past the snapshot, to the tracker's connection, and the test above says
    // so out loud rather than letting it slip off this list unnoticed.
    const results: unknown[] = [
      maxConcurrentAgents(snapshot),
      dashboardOrganizationSettings(snapshot),
      mcpSettings(snapshot),
    ];

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof (result as { then?: unknown })?.then === "function").toBe(false);
    }
  });

  it("follow a stored row once one exists", async () => {
    await writeManySettings(db, {
      patch: { MAX_CONCURRENT_AGENTS: 2, COLUMN_AI: "Agent" },
      actor: "user_admin",
      reason: "tuning",
    });
    const snapshot = await loadSettingsSnapshot();

    expect(maxConcurrentAgents(snapshot)).toBe(2);
    expect((await ticketBoardSettings(snapshot)).aiColumn).toBe("Agent");
  });
});
