import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RETIRED_ENVIRONMENT_VARIABLES,
  SETTINGS_REGISTRY,
  type SettingDefinition,
  validateSettingsPatch,
} from "./settings-registry";
import {
  resolveSettingsSnapshot,
  type SettingsEnvironmentReader,
} from "./settings-resolution";

/** Core's keys alone. The worker and the dashboard pass the joined lookup
 *  (`settingDefinition` in `@integrations/registry`), which this package
 *  cannot import; these tests are about core's registry. */
const core = (key: string): SettingDefinition | undefined =>
  (SETTINGS_REGISTRY as readonly SettingDefinition[]).find((definition) => definition.key === key);

test("every key is declared once and only redeploy keys name environment variables", () => {
  const keys = SETTINGS_REGISTRY.map((definition) => definition.key);
  assert.equal(new Set(keys).size, keys.length);
  const registry: readonly SettingDefinition[] = SETTINGS_REGISTRY;
  const variables = registry
    .map((definition) => definition.environmentVariable)
    .filter((name): name is string => name !== undefined);
  assert.equal(new Set(variables).size, variables.length);
  assert.deepEqual(
    registry.filter((definition) => definition.requiresRedeploy).map((definition) => definition.key),
    ["DASHBOARD_ORG_SLUG", "MCP_ALLOW_PUBLIC_DCR", "PRE_PR_CHECKS_ALLOWED_ENV"],
  );
  for (const definition of registry) {
    assert.equal(
      definition.environmentVariable !== undefined,
      definition.requiresRedeploy === true,
      definition.key,
    );
  }
});

test("the retired environment names are a frozen, literal one-way list", () => {
  assert.equal(Object.isFrozen(RETIRED_ENVIRONMENT_VARIABLES), true);
  assert.deepEqual(RETIRED_ENVIRONMENT_VARIABLES, [
    "DASHBOARD_ORG_NAME",
    "GITHUB_BASE_BRANCH",
    "GITLAB_BASE_BRANCH",
    "MAX_CONCURRENT_AGENTS",
    "JOB_TIMEOUT_MS",
    "V2_MAX_BLOCK_CONCURRENCY",
    "POLL_INTERVAL_MS",
    "ATTACHMENT_MAX_FILE_SIZE_MB",
    "ATTACHMENT_MAX_TOTAL_SIZE_MB",
    "ATTACHMENT_MAX_COUNT",
    "ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
    "ENABLE_REVIEW_PHASE",
    "ENABLE_LEAK_REVIEW",
    "ENABLE_REPO_MEMORY",
    "ENABLE_ORG_MEMORY_PROMOTION",
    "ENABLE_REPO_ROUTING_MEMORY",
    "REVIEW_LEDGER_ENABLED",
    "MCP_ENABLED",
    "MCP_AUDIT_RETENTION_DAYS",
    "MCP_MAX_REQUEST_BYTES",
    "MCP_MAX_RESULT_BYTES",
    "MCP_TOOL_TIMEOUT_MS",
    "MCP_READ_RATE_LIMIT_PER_MINUTE",
    "MCP_MUTATION_RATE_LIMIT_PER_MINUTE",
    "PRE_PR_COMMAND_TIMEOUT_MINUTES",
    "AGENT_KIND",
    "CLAUDE_MODEL",
    "CODEX_MODEL",
    "COLUMN_AI",
    "COLUMN_AI_REVIEW",
    "COLUMN_BACKLOG",
    "TRIGGER_RATE_LIMIT_MAX",
    "TRIGGER_RATE_LIMIT_WINDOW",
  ]);
  assert.equal(RETIRED_ENVIRONMENT_VARIABLES.length, 33);
  assert.equal(new Set(RETIRED_ENVIRONMENT_VARIABLES).size, 33);
  assert.ok(!RETIRED_ENVIRONMENT_VARIABLES.includes("AGENT_ALLOWED_REPOS" as never));
});

test("a key the workflow body reads may only apply to the next run", () => {
  // The rule the plan states: a run carries its settings from its start, so
  // nothing a step reads may claim to change a run already in flight.
  const workflowBodyKeys = new Set([
    "DASHBOARD_ORG_SLUG",
    "JOB_TIMEOUT_MS",
    "V2_MAX_BLOCK_CONCURRENCY",
    "ATTACHMENT_MAX_FILE_SIZE_MB",
    "ATTACHMENT_MAX_TOTAL_SIZE_MB",
    "ATTACHMENT_MAX_COUNT",
    "ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
    "ENABLE_REPO_MEMORY",
    "ENABLE_ORG_MEMORY_PROMOTION",
    "ENABLE_REPO_ROUTING_MEMORY",
    "REVIEW_LEDGER_ENABLED",
    "COLUMN_AI",
    "COLUMN_AI_REVIEW",
    "COLUMN_BACKLOG",
    "PRE_PR_COMMAND_TIMEOUT_MINUTES",
    "PRE_PR_CHECKS_ALLOWED_ENV",
  ]);
  for (const definition of SETTINGS_REGISTRY) {
    if (workflowBodyKeys.has(definition.key)) {
      assert.equal(definition.appliesToRunsInFlight, "next run", definition.key);
    }
  }
});

test("a default matches the type it is declared with", () => {
  for (const definition of SETTINGS_REGISTRY) {
    if (definition.default === null) continue;
    const issues = validateSettingsPatch({ [definition.key]: definition.default }, core);
    assert.deepEqual(issues, [], definition.key);
  }
});

test("an unknown key is refused by name", () => {
  assert.deepEqual(validateSettingsPatch({ NOT_A_SETTING: 1 }, core), [
    { key: "NOT_A_SETTING", reason: "unknown_key" },
  ]);
});

test("a wrong type is refused per key and every refusal is reported", () => {
  assert.deepEqual(
    validateSettingsPatch({ MAX_CONCURRENT_AGENTS: "3", MCP_ENABLED: "true" }, core),
    [
      { key: "MAX_CONCURRENT_AGENTS", reason: "wrong_type" },
      { key: "MCP_ENABLED", reason: "wrong_type" },
    ],
  );
  assert.deepEqual(validateSettingsPatch({ MAX_CONCURRENT_AGENTS: 2.5 }, core), [
    { key: "MAX_CONCURRENT_AGENTS", reason: "wrong_type" },
  ]);
  assert.deepEqual(validateSettingsPatch({ PRE_PR_CHECKS_ALLOWED_ENV: ["A", 2] }, core), [
    { key: "PRE_PR_CHECKS_ALLOWED_ENV", reason: "wrong_type" },
  ]);
});

test("a value below a declared minimum is refused", () => {
  assert.deepEqual(validateSettingsPatch({ MAX_CONCURRENT_AGENTS: 0 }, core), [
    { key: "MAX_CONCURRENT_AGENTS", reason: "below_minimum" },
  ]);
  assert.deepEqual(validateSettingsPatch({ MCP_TOOL_TIMEOUT_MS: 999 }, core), [
    { key: "MCP_TOOL_TIMEOUT_MS", reason: "below_minimum" },
  ]);
});

test("a list entry that is blank or holds a comma is refused, one value per entry is kept", () => {
  // `["U1,U2"]` would be one id nobody has (everyone locked out of an
  // allowlist), `[" "]` would read as no entry (everyone let in).
  for (const entries of [["U1,U2"], [" "], [""], ["U1", "  "], ["U1", "U2,"]]) {
    assert.deepEqual(
      validateSettingsPatch({ PRE_PR_CHECKS_ALLOWED_ENV: entries }, core),
      [{ key: "PRE_PR_CHECKS_ALLOWED_ENV", reason: "list_entry_invalid" }],
      JSON.stringify(entries),
    );
  }
  assert.deepEqual(validateSettingsPatch({ PRE_PR_CHECKS_ALLOWED_ENV: ["U1", "U2"] }, core), []);
  assert.deepEqual(validateSettingsPatch({ PRE_PR_CHECKS_ALLOWED_ENV: [] }, core), []);
});

test("null clears a key that has no default and is refused for one that has", () => {
  assert.deepEqual(validateSettingsPatch({ V2_MAX_BLOCK_CONCURRENCY: null }, core), []);
  assert.deepEqual(validateSettingsPatch({ MAX_CONCURRENT_AGENTS: null }, core), [
    { key: "MAX_CONCURRENT_AGENTS", reason: "null_not_allowed" },
  ]);
});

/** A deployment that sets exactly these variables. */
function environmentOf(values: Record<string, string>): SettingsEnvironmentReader {
  return {
    value: (variable) => values[variable],
    isSet: (variable) => values[variable] !== undefined,
  };
}

test("stored values stay unchanged while a redeploy key still reads the environment", () => {
  const environment = environmentOf({ DASHBOARD_ORG_SLUG: "acme", COLUMN_AI: "Agent" });

  const { snapshot, sources } = resolveSettingsSnapshot(
    new Map([
      ["DASHBOARD_ORG_SLUG", "typo-inc"],
      ["COLUMN_AI", "Stored"],
    ]),
    environment,
  );

  // The auth instance reads the variable at module load, so a row that
  // disagreed with it would put a value on the Settings page that nothing in
  // the running worker was using. The environment is the single answer, and
  // the source says so rather than claiming the row won.
  assert.equal(snapshot.DASHBOARD_ORG_SLUG, "acme");
  assert.equal(sources.get("DASHBOARD_ORG_SLUG"), "environment");
  // Every other key keeps the ordinary rule.
  assert.equal(snapshot.COLUMN_AI, "Stored");
  assert.equal(sources.get("COLUMN_AI"), "stored");
});

test("the environment branch exists only for redeploy keys", () => {
  const environment = environmentOf({
    DASHBOARD_ORG_SLUG: "acme",
    COLUMN_AI: "Environment Agent",
  });
  const { snapshot, sources } = resolveSettingsSnapshot(new Map(), environment);

  assert.equal(snapshot.DASHBOARD_ORG_SLUG, "acme");
  assert.equal(sources.get("DASHBOARD_ORG_SLUG"), "environment");
  assert.equal(snapshot.COLUMN_AI, "AI");
  assert.equal(sources.get("COLUMN_AI"), "default");
});

/**
 * A setting an integration declares, shaped as `integrationSettingDefinition`
 * in the SDK builds Slack's: an ordinary key that names the variable it was
 * before it was a setting.
 */
const ALLOWLIST: SettingDefinition = {
  key: "SLACK_ALLOWED_USER_IDS",
  group: "integrations",
  type: "string-list",
  default: [],
  description: "Slack: who may run the slash command.",
  appliesToRunsInFlight: "immediate",
  overridablePerTrigger: false,
  environmentVariable: "SLACK_ALLOWED_USER_IDS",
};

test("a contributed key reads its variable as main split it while nothing is stored", () => {
  // origin/main apps/worker/src/services/settings/integration-settings.ts:96-99:
  // split(",").map(trim).filter(Boolean), and an empty list lets everyone in.
  const cases: [string | undefined, readonly string[], "environment" | "default"][] = [
    ["U1, U2,,", ["U1", "U2"], "environment"],
    [" , , ", [], "environment"],
    [undefined, [], "default"],
  ];
  for (const [variable, expected, source] of cases) {
    const environment = environmentOf(variable === undefined ? {} : { SLACK_ALLOWED_USER_IDS: variable });
    const { snapshot, sources } = resolveSettingsSnapshot(new Map(), environment, [ALLOWLIST]);
    const values = snapshot as unknown as Record<string, unknown>;
    assert.deepEqual(values.SLACK_ALLOWED_USER_IDS, expected, JSON.stringify(variable));
    assert.equal(sources.get("SLACK_ALLOWED_USER_IDS"), source, JSON.stringify(variable));
  }
});

test("a stored value shadows a contributed key's variable, and is validated like core's", () => {
  const { snapshot, sources } = resolveSettingsSnapshot(
    new Map([["SLACK_ALLOWED_USER_IDS", ["U3"]]]),
    environmentOf({ SLACK_ALLOWED_USER_IDS: "U1,U2" }),
    [ALLOWLIST],
  );
  assert.deepEqual((snapshot as unknown as Record<string, unknown>).SLACK_ALLOWED_USER_IDS, ["U3"]);
  assert.equal(sources.get("SLACK_ALLOWED_USER_IDS"), "stored");

  const find = (key: string) => (key === ALLOWLIST.key ? ALLOWLIST : undefined);
  assert.deepEqual(validateSettingsPatch({ SLACK_ALLOWED_USER_IDS: ["U3"] }, find), []);
  assert.deepEqual(validateSettingsPatch({ SLACK_ALLOWED_USER_IDS: "U3" }, find), [
    { key: "SLACK_ALLOWED_USER_IDS", reason: "wrong_type" },
  ]);
  assert.deepEqual(validateSettingsPatch({ SLACK_ALLOWED_USER_IDS: ["U1,U2"] }, find), [
    { key: "SLACK_ALLOWED_USER_IDS", reason: "list_entry_invalid" },
  ]);
  // Core's registry alone does not know it, which is why the lookup is an
  // argument every surface passes rather than a default of core's.
  assert.deepEqual(validateSettingsPatch({ SLACK_ALLOWED_USER_IDS: ["U3"] }, core), [
    { key: "SLACK_ALLOWED_USER_IDS", reason: "unknown_key" },
  ]);
});

test("the checks allowlist read from its raw variable is split the same way", () => {
  // The worker hands over the raw text of a variable its schema does not
  // declare, and PRE_PR_CHECKS_ALLOWED_ENV is one: the list rule is here now.
  const { snapshot } = resolveSettingsSnapshot(
    new Map(),
    environmentOf({ PRE_PR_CHECKS_ALLOWED_ENV: " NPM_TOKEN , ,SENTRY_DSN" }),
  );
  assert.deepEqual(snapshot.PRE_PR_CHECKS_ALLOWED_ENV, ["NPM_TOKEN", "SENTRY_DSN"]);
});
