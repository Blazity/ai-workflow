import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SETTINGS_REGISTRY,
  findSettingDefinition,
  validateSettingsPatch,
} from "./settings-registry";
import {
  migratedVariablesSetIn,
  migratedVariablesUnstoredIn,
  redeployOwnedSettingRows,
  resolveSettingsSnapshot,
  type SettingsEnvironmentReader,
} from "./settings-resolution";

test("every key is declared once and names its environment variable at most once", () => {
  const keys = SETTINGS_REGISTRY.map((definition) => definition.key);
  assert.equal(new Set(keys).size, keys.length);
  const variables = SETTINGS_REGISTRY.map((d) => d.environmentVariable).filter(
    (name): name is string => name !== null,
  );
  assert.equal(new Set(variables).size, variables.length);
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
    "ENABLE_REVIEW_PHASE",
    "ENABLE_LEAK_REVIEW",
    "ENABLE_REPO_MEMORY",
    "ENABLE_ORG_MEMORY_PROMOTION",
    "ENABLE_REPO_ROUTING_MEMORY",
    "REVIEW_LEDGER_ENABLED",
    "COLUMN_AI",
    "COLUMN_AI_REVIEW",
    "COLUMN_BACKLOG",
    "AGENT_KIND",
    "CLAUDE_MODEL",
    "CODEX_MODEL",
    "PRE_PR_COMMAND_TIMEOUT_MINUTES",
    "PRE_PR_CHECKS_ALLOWED_ENV",
    "GITHUB_BASE_BRANCH",
    "GITLAB_BASE_BRANCH",
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
    const issues = validateSettingsPatch({ [definition.key]: definition.default });
    assert.deepEqual(issues, [], definition.key);
  }
});

test("an unknown key is refused by name", () => {
  assert.deepEqual(validateSettingsPatch({ NOT_A_SETTING: 1 }), [
    { key: "NOT_A_SETTING", reason: "unknown_key" },
  ]);
});

test("a wrong type is refused per key and every refusal is reported", () => {
  assert.deepEqual(
    validateSettingsPatch({ MAX_CONCURRENT_AGENTS: "3", MCP_ENABLED: "true" }),
    [
      { key: "MAX_CONCURRENT_AGENTS", reason: "wrong_type" },
      { key: "MCP_ENABLED", reason: "wrong_type" },
    ],
  );
  assert.deepEqual(validateSettingsPatch({ MAX_CONCURRENT_AGENTS: 2.5 }), [
    { key: "MAX_CONCURRENT_AGENTS", reason: "wrong_type" },
  ]);
  assert.deepEqual(validateSettingsPatch({ PRE_PR_CHECKS_ALLOWED_ENV: ["A", 2] }), [
    { key: "PRE_PR_CHECKS_ALLOWED_ENV", reason: "wrong_type" },
  ]);
});

test("a value outside the declared set or below the declared minimum is refused", () => {
  assert.deepEqual(validateSettingsPatch({ AGENT_KIND: "gemini" }), [
    { key: "AGENT_KIND", reason: "not_allowed_value" },
  ]);
  assert.deepEqual(validateSettingsPatch({ MAX_CONCURRENT_AGENTS: 0 }), [
    { key: "MAX_CONCURRENT_AGENTS", reason: "below_minimum" },
  ]);
  assert.deepEqual(validateSettingsPatch({ MCP_TOOL_TIMEOUT_MS: 999 }), [
    { key: "MCP_TOOL_TIMEOUT_MS", reason: "below_minimum" },
  ]);
});

test("null clears a key that has no default and is refused for one that has", () => {
  assert.deepEqual(validateSettingsPatch({ CLAUDE_MODEL: null }), []);
  assert.deepEqual(validateSettingsPatch({ MAX_CONCURRENT_AGENTS: null }), [
    { key: "MAX_CONCURRENT_AGENTS", reason: "null_not_allowed" },
  ]);
});

test("the catalog switch is a setting with no environment variable", () => {
  const definition = findSettingDefinition("catalog.activated");
  assert.ok(definition);
  assert.equal(definition.environmentVariable, null);
  assert.equal(definition.default, false);
});

/** A deployment that sets exactly these variables. */
function environmentOf(values: Record<string, string>): SettingsEnvironmentReader {
  return {
    value: (variable) => values[variable],
    isSet: (variable) => values[variable] !== undefined,
  };
}

test("a stored row never wins over the environment for a requiresRedeploy key", () => {
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

test("the unstored list names what is set and not stored, and nothing else", () => {
  const environment = environmentOf({
    COLUMN_AI: "Agent",
    COLUMN_BACKLOG: "Backlog",
    DASHBOARD_ORG_SLUG: "acme",
  });

  const resolution = resolveSettingsSnapshot(
    new Map([["COLUMN_AI", "Agent"]]),
    environment,
  );

  const unstored = migratedVariablesUnstoredIn(environment, resolution);
  // Set and stored: safe to remove, so it is not here.
  assert.ok(!unstored.includes("COLUMN_AI"));
  // Set and nothing stored: removing it would lose the value.
  assert.ok(unstored.includes("COLUMN_BACKLOG"));
  // Never asked for at all: the deployment reads this one itself.
  assert.ok(!unstored.includes("DASHBOARD_ORG_SLUG"));
  // Unset variables are nobody's to-do item.
  assert.ok(!unstored.includes("JOB_TIMEOUT_MS"));
});

test("a variable that is set but parses to nothing is on the to-do list, not the unsafe one", () => {
  // `PRE_PR_COMMAND_TIMEOUT_MINUTES=0`, or whitespace: the variable is there,
  // the parser gives nothing, and the deployment has been running on the
  // registry default all along.
  const environment: SettingsEnvironmentReader = {
    value: (variable) => (variable === "COLUMN_AI" ? "Agent" : undefined),
    isSet: (variable) =>
      variable === "COLUMN_AI" || variable === "PRE_PR_COMMAND_TIMEOUT_MINUTES",
  };

  const resolution = resolveSettingsSnapshot(new Map(), environment);

  assert.equal(resolution.sources.get("PRE_PR_COMMAND_TIMEOUT_MINUTES"), "default");
  // Still set, so the cleanup release would still refuse to boot: it stays on
  // the list of variables to delete.
  assert.ok(migratedVariablesSetIn(environment).includes("PRE_PR_COMMAND_TIMEOUT_MINUTES"));
  // But nothing would be lost by deleting it, so it is not on the list that
  // says "do not touch this yet".
  const unstored = migratedVariablesUnstoredIn(environment, resolution);
  assert.ok(!unstored.includes("PRE_PR_COMMAND_TIMEOUT_MINUTES"));
  assert.ok(unstored.includes("COLUMN_AI"));
});

test("the environment keeps its own keys, with the value that answers once a row is gone", () => {
  const environment = environmentOf({ DASHBOARD_ORG_SLUG: "acme" });

  const rows = redeployOwnedSettingRows(environment);

  const slug = rows.find((row) => row.key === "DASHBOARD_ORG_SLUG");
  assert.deepEqual(slug, { key: "DASHBOARD_ORG_SLUG", value: "acme" });
  // Every requiresRedeploy key is here, set or not: a leftover row for one of
  // them is ignored either way, so the import removes it either way.
  assert.ok(rows.some((row) => row.key === "PRE_PR_CHECKS_ALLOWED_ENV"));
  // And nothing else is: these rows are deletions, not writes.
  assert.ok(!rows.some((row) => row.key === "COLUMN_AI"));
});
