import assert from "node:assert/strict";
import test from "node:test";
import type {
  SettingsEntryView,
  SystemHealthCheck,
  SystemHealthIntegration,
  SystemHealthMode,
  SystemHealthResponse,
} from "@shared/contracts";
import {
  findSettingDefinition,
} from "@shared/contracts";
import { buildSetupOverview } from "./overview";

function entry(
  key: string,
  value: boolean | number | string | readonly string[] | null,
  overrides: Partial<SettingsEntryView> = {},
): SettingsEntryView {
  const definition = findSettingDefinition(key);
  assert.ok(definition, `${key} is not a registry key`);
  return {
    key: key as SettingsEntryView["key"],
    value,
    default: definition.default,
    source: "default",
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    lastVersion: null,
    ...overrides,
  };
}

function integration(id: string, mode: string): SystemHealthIntegration {
  return {
    id,
    label: `${id} Integration`,
    group: "core",
    envVars: [],
    critical: true,
    mode: mode as never,
    ping: null,
    checks: [],
  };
}

function healthResponse(integrations: SystemHealthIntegration[]): SystemHealthResponse {
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      total: integrations.length,
      live: integrations.filter((i) => i.mode === "live").length,
      down: 0,
      notConfigured: 0,
      criticalDown: 0,
      checksTotal: 0,
      checksLive: 0,
      checksDown: 0,
      checksDegraded: 0,
    },
    integrations,
  };
}

test("scanReadable false makes issue tracker row read Not available", () => {
  const settings: readonly SettingsEntryView[] = [];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: false,
  });
  const issueTrackerRow = overview.rows.find((r) => r.id === "issue-tracker");
  assert.ok(issueTrackerRow);
  assert.equal(issueTrackerRow.value, "Not available");
  assert.equal(issueTrackerRow.tone, "unknown");
});

test("scanReadable false makes version control row read Not available", () => {
  const settings: readonly SettingsEntryView[] = [];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: false,
  });
  const vcsRow = overview.rows.find((r) => r.id === "vcs");
  assert.ok(vcsRow);
  assert.equal(vcsRow.value, "Not available");
  assert.equal(vcsRow.tone, "unknown");
});

test("scanReadable true with scan null makes tracker Unknown", () => {
  const settings: readonly SettingsEntryView[] = [];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const issueTrackerRow = overview.rows.find((r) => r.id === "issue-tracker");
  assert.ok(issueTrackerRow);
  assert.equal(issueTrackerRow.value, "Unknown");
  assert.equal(issueTrackerRow.tone, "unknown");
  assert.ok(issueTrackerRow.detail.includes("No system health scan"));
});

test("jira live mode makes issue tracker Connected", () => {
  const settings: readonly SettingsEntryView[] = [];
  const scan = healthResponse([integration("jira", "live")]);
  const overview = buildSetupOverview({
    settings,
    scan,
    scanReadable: true,
  });
  const issueTrackerRow = overview.rows.find((r) => r.id === "issue-tracker");
  assert.ok(issueTrackerRow);
  assert.equal(issueTrackerRow.value, "Connected");
  assert.equal(issueTrackerRow.tone, "ok");
});

test("github live and gitlab not-configured reports github state", () => {
  const settings: readonly SettingsEntryView[] = [];
  const scan = healthResponse([
    integration("github", "live"),
    integration("gitlab", "not-configured"),
  ]);
  const overview = buildSetupOverview({
    settings,
    scan,
    scanReadable: true,
  });
  const vcsRow = overview.rows.find((r) => r.id === "vcs");
  assert.ok(vcsRow);
  assert.equal(vcsRow.value, "Connected");
  assert.ok(vcsRow.detail.includes("github Integration"));
  assert.ok(vcsRow.detail.includes("gitlab Integration"));
  assert.ok(vcsRow.detail.includes("Also seen:"));
});

test("catalog activated is on when catalog.activated is true", () => {
  const settings = [entry("catalog.activated", true)];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const catalogRow = overview.rows.find((r) => r.id === "catalog");
  assert.ok(catalogRow);
  assert.equal(catalogRow.value, "Activated");
  assert.equal(catalogRow.tone, "ok");
});

test("catalog not activated is off when catalog.activated is false", () => {
  const settings = [entry("catalog.activated", false)];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const catalogRow = overview.rows.find((r) => r.id === "catalog");
  assert.ok(catalogRow);
  assert.equal(catalogRow.value, "Not activated");
  assert.equal(catalogRow.tone, "warn");
});

test("features row counts on switches", () => {
  const settings = [
    entry("ENABLE_REVIEW_PHASE", true),
    entry("ENABLE_LEAK_REVIEW", false),
    entry("ENABLE_REPO_MEMORY", true),
    entry("MCP_ENABLED", false),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const featuresRow = overview.rows.find((r) => r.id === "features");
  assert.ok(featuresRow);
  assert.ok(featuresRow.value.includes("2 of 4 on"));
});

test("features row names enabled features", () => {
  const settings = [
    entry("ENABLE_REVIEW_PHASE", true),
    entry("ENABLE_LEAK_REVIEW", false),
    entry("ENABLE_REPO_MEMORY", true),
    entry("MCP_ENABLED", false),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const featuresRow = overview.rows.find((r) => r.id === "features");
  assert.ok(featuresRow);
  assert.ok(featuresRow.detail.includes("Enable review phase"));
  assert.ok(featuresRow.detail.includes("Enable repo memory"));
});

test("MCP row reads Serving when MCP_ENABLED is true", () => {
  const settings = [entry("MCP_ENABLED", true)];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const mcpRow = overview.rows.find((r) => r.id === "mcp");
  assert.ok(mcpRow);
  assert.equal(mcpRow.value, "Serving");
  assert.equal(mcpRow.tone, "ok");
});

test("MCP row reads Off when MCP_ENABLED is false", () => {
  const settings = [entry("MCP_ENABLED", false)];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const mcpRow = overview.rows.find((r) => r.id === "mcp");
  assert.ok(mcpRow);
  assert.equal(mcpRow.value, "Off");
  assert.equal(mcpRow.tone, "off");
});

test("memory row is Off when ENABLE_REPO_MEMORY is false", () => {
  const settings = [entry("ENABLE_REPO_MEMORY", false)];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const memoryRow = overview.rows.find((r) => r.id === "memory");
  assert.ok(memoryRow);
  assert.equal(memoryRow.value, "Off");
  assert.equal(memoryRow.tone, "off");
});

test("memory row detail says promotion and routing have no effect when repo memory is off", () => {
  const settings = [
    entry("ENABLE_REPO_MEMORY", false),
    entry("ENABLE_ORG_MEMORY_PROMOTION", true),
    entry("ENABLE_REPO_ROUTING_MEMORY", true),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const memoryRow = overview.rows.find((r) => r.id === "memory");
  assert.ok(memoryRow);
  assert.ok(
    memoryRow.detail.includes(
      "promotion and routing memory have no effect",
    ),
  );
});

test("memory row is On when ENABLE_REPO_MEMORY is true", () => {
  const settings = [
    entry("ENABLE_REPO_MEMORY", true),
    entry("ENABLE_ORG_MEMORY_PROMOTION", false),
    entry("ENABLE_REPO_ROUTING_MEMORY", false),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const memoryRow = overview.rows.find((r) => r.id === "memory");
  assert.ok(memoryRow);
  assert.equal(memoryRow.value, "On");
  assert.equal(memoryRow.tone, "ok");
});

test("storedRows carries one row per group with stored and total", () => {
  const settings = [
    entry("MAX_CONCURRENT_AGENTS", 3, { source: "stored" }),
    entry("DASHBOARD_ORG_NAME", "Test"),
    entry("ENABLE_REPO_MEMORY", false, { source: "stored" }),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  const capacityRow = overview.storedRows.find((r) => r.id === "capacity");
  assert.ok(capacityRow);
  assert.equal(capacityRow.stored, 1);
  assert.equal(capacityRow.total, 1);

  const generalRow = overview.storedRows.find((r) => r.id === "general");
  assert.ok(generalRow);
  assert.equal(generalRow.stored, 0);
  assert.equal(generalRow.total, 1);

  const featuresRow = overview.storedRows.find((r) => r.id === "features");
  assert.ok(featuresRow);
  assert.equal(featuresRow.stored, 1);
  assert.equal(featuresRow.total, 1);
});

test("hasStoredRows is false when nothing is stored", () => {
  const settings = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  assert.equal(overview.hasStoredRows, false);
});

test("hasStoredRows is true when something is stored", () => {
  const settings = [
    entry("MAX_CONCURRENT_AGENTS", 3, { source: "stored" }),
    entry("DASHBOARD_ORG_NAME", "Test"),
  ];
  const overview = buildSetupOverview({
    settings,
    scan: null,
    scanReadable: true,
  });
  assert.equal(overview.hasStoredRows, true);
});

// ── The three rows that used to state a behaviour as fact ───────────────────

test("the behaviour rows say the value is a stored setting, not what the worker does", () => {
  // The store ships before the consumers, so "On" as a bare label would be a
  // claim about the running system that nothing here can back.
  const settings = [
    entry("MCP_ENABLED", true),
    entry("ENABLE_REPO_MEMORY", true),
    entry("catalog.activated", true),
  ];
  const overview = buildSetupOverview({ settings, scan: null, scanReadable: true });
  const row = (id: string) => overview.rows.find((r) => r.id === id);

  assert.equal(row("mcp")?.label, "Stored setting: Remote MCP");
  assert.equal(row("memory")?.label, "Stored setting: Agent memory");
  assert.equal(row("catalog")?.label, "Stored setting: Repository catalog");
  // The values themselves are unchanged.
  assert.equal(row("mcp")?.value, "Serving");
  assert.equal(row("memory")?.value, "On");
  assert.equal(row("catalog")?.value, "Activated");
});

test("the MCP row counts only the numeric ceilings, not the switch beside them", () => {
  const settings = [
    entry("MCP_ENABLED", true),
    entry("MCP_ALLOW_PUBLIC_DCR", true),
    entry("MCP_MAX_REQUEST_BYTES", 1_048_576),
    entry("MCP_TOOL_TIMEOUT_MS", 30_000),
  ];
  const overview = buildSetupOverview({ settings, scan: null, scanReadable: true });
  const mcpRow = overview.rows.find((r) => r.id === "mcp");
  assert.match(mcpRow?.detail ?? "", /2 limits are in force/);
  assert.doesNotMatch(mcpRow?.detail ?? "", /3 limits/);
});

// ── Secrets ─────────────────────────────────────────────────────────────────

function check(
  id: string,
  envVars: string[],
  mode: SystemHealthMode,
): SystemHealthCheck {
  return {
    id,
    label: id,
    description: id,
    critical: true,
    mode,
    envVars,
    evidenceSource: "configuration",
  };
}

function withChecks(
  id: string,
  mode: SystemHealthMode,
  checks: SystemHealthCheck[],
): SystemHealthIntegration {
  return { ...integration(id, mode), checks };
}

const secretsRow = (overview: ReturnType<typeof buildSetupOverview>) =>
  overview.rows.find((r) => r.id === "secrets");

test("a member is told the secrets row is not theirs to see, not that it is empty", () => {
  const overview = buildSetupOverview({
    settings: [],
    scan: null,
    scanReadable: false,
  });
  assert.equal(secretsRow(overview)?.value, "Not available");
  assert.equal(secretsRow(overview)?.tone, "unknown");
});

test("no scan yet leaves the secrets row unknown rather than claiming nothing is set", () => {
  const overview = buildSetupOverview({
    settings: [],
    scan: null,
    scanReadable: true,
  });
  assert.equal(secretsRow(overview)?.value, "Unknown");
  assert.equal(secretsRow(overview)?.tone, "unknown");
});

test("a missing variable is counted and named, and an unconfigured one is neither", () => {
  const scan = healthResponse([
    withChecks("database", "live", [check("configuration", ["DATABASE_URL"], "configured")]),
    withChecks("github", "misconfigured", [
      check("app", ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"], "misconfigured"),
    ]),
    withChecks("slack", "not-configured", [
      check("bot", ["SLACK_BOT_TOKEN"], "not-configured"),
    ]),
  ]);
  const row = secretsRow(
    buildSetupOverview({ settings: [], scan, scanReadable: true }),
  );

  assert.equal(row?.value, "1 present, 2 missing");
  assert.equal(row?.tone, "warn");
  assert.match(row?.detail ?? "", /Missing: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY\./);
  assert.match(row?.detail ?? "", /1 more belong to integrations this deployment has not configured\./);
});

test("a variable one check calls missing and another calls present counts as present", () => {
  // A grouped check reports every name it carries as missing when any one of
  // them is, so the better answer from any other check has to win.
  const scan = healthResponse([
    withChecks("github", "degraded", [
      check("app", ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID"], "misconfigured"),
      check("token", ["GITHUB_APP_ID"], "configured"),
    ]),
  ]);
  const row = secretsRow(
    buildSetupOverview({ settings: [], scan, scanReadable: true }),
  );
  assert.equal(row?.value, "1 present, 1 missing");
  assert.match(row?.detail ?? "", /Missing: GITHUB_INSTALLATION_ID\./);
  assert.doesNotMatch(row?.detail ?? "", /GITHUB_APP_ID/);
});

test("nothing missing reads as ok and still promises no value ever leaves the worker", () => {
  const scan = healthResponse([
    withChecks("database", "live", [check("configuration", ["DATABASE_URL"], "live")]),
    withChecks("jira", "live", [check("auth", ["JIRA_API_TOKEN"], "configured")]),
  ]);
  const row = secretsRow(
    buildSetupOverview({ settings: [], scan, scanReadable: true }),
  );
  assert.equal(row?.value, "2 present, 0 missing");
  assert.equal(row?.tone, "ok");
  assert.match(row?.detail ?? "", /Names only; a secret value never leaves the worker\.$/);
});

test("the scan derived rows are grouped ahead of the stored setting rows", () => {
  // Secrets belongs with the other two rows a scan answers, so a reader is not
  // switching between "what is connected" and "what is stored" and back.
  const overview = buildSetupOverview({
    settings: [],
    scan: null,
    scanReadable: true,
  });
  assert.deepEqual(
    overview.rows.map((row) => row.id),
    ["issue-tracker", "vcs", "secrets", "catalog", "features", "mcp", "memory"],
  );
});
