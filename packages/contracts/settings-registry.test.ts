import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SETTINGS_REGISTRY,
  findSettingDefinition,
  validateSettingsPatch,
} from "./settings-registry";

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
