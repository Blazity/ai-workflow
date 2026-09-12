import assert from "node:assert/strict";
import test from "node:test";
import {
  RESOLVED_VALUE_LABEL,
  STORED_ONLY_NOTICE,
  appliesToNote,
  displaySettingValue,
  formatSettingActor,
  formatSettingTimestamp,
  settingIssuesFromMessage,
  settingLabel,
  sourceHint,
  sourceLabel,
} from "./format";

test("settingLabel converts MAX_CONCURRENT_AGENTS to Max concurrent agents", () => {
  assert.equal(settingLabel("MAX_CONCURRENT_AGENTS"), "Max concurrent agents");
});

test("settingLabel converts MCP_ALLOW_PUBLIC_DCR to MCP allow public DCR", () => {
  assert.equal(settingLabel("MCP_ALLOW_PUBLIC_DCR"), "MCP allow public DCR");
});

test("settingLabel converts PRE_PR_COMMAND_TIMEOUT_MINUTES to Pre PR command timeout minutes", () => {
  assert.equal(
    settingLabel("PRE_PR_COMMAND_TIMEOUT_MINUTES"),
    "Pre PR command timeout minutes",
  );
});

test("settingLabel converts JOB_TIMEOUT_MS to Job timeout ms", () => {
  assert.equal(settingLabel("JOB_TIMEOUT_MS"), "Job timeout ms");
});

test("settingLabel converts catalog.activated to Catalog activated", () => {
  assert.equal(settingLabel("catalog.activated"), "Catalog activated");
});

test("settingLabel converts V2_MAX_BLOCK_CONCURRENCY to V2 max block concurrency", () => {
  assert.equal(
    settingLabel("V2_MAX_BLOCK_CONCURRENCY"),
    "V2 max block concurrency",
  );
});

test("settingLabel converts GITHUB_BASE_BRANCH to GitHub base branch", () => {
  assert.equal(settingLabel("GITHUB_BASE_BRANCH"), "GitHub base branch");
});

test("settingLabel converts COLUMN_AI to Column AI", () => {
  assert.equal(settingLabel("COLUMN_AI"), "Column AI");
});

test("sourceLabel for stored returns Stored", () => {
  assert.equal(sourceLabel("stored"), "Stored");
});

test("sourceLabel for environment returns Environment", () => {
  assert.equal(sourceLabel("environment"), "Environment");
});

test("sourceLabel for default returns Default", () => {
  assert.equal(sourceLabel("default"), "Default");
});

test("sourceHint for stored says a stored value shadows the variable", () => {
  assert.equal(
    sourceHint("stored"),
    "Stored from this dashboard. A stored value shadows the environment variable until it is removed.",
  );
});

test("sourceHint for environment mentions deployment environment", () => {
  assert.equal(
    sourceHint("environment"),
    "Read from this deployment's environment.",
  );
});

test("sourceHint for default says nothing is stored", () => {
  assert.equal(
    sourceHint("default"),
    "Nothing is stored, so the built-in default is what the store resolves.",
  );
});

test("appliesToNote says nothing applies until the worker reads stored settings", () => {
  // The prefix is the honest part: the store ships before the consumers, so a
  // note that read "Applies immediately" would be claiming a behaviour change
  // that has not happened yet.
  assert.equal(
    appliesToNote("immediate"),
    "Once the worker reads stored settings, this applies immediately",
  );
  assert.equal(
    appliesToNote("next run"),
    "Once the worker reads stored settings, this applies to the next run",
  );
});

test("the standing notice says values are stored and the worker still reads its environment", () => {
  assert.match(STORED_ONLY_NOTICE, /stored now/);
  assert.match(STORED_ONLY_NOTICE, /still reads most settings from its environment/);
  assert.match(STORED_ONLY_NOTICE, /not what the worker currently uses/);
});

test("the resolved value label does not claim a value is in force", () => {
  assert.equal(RESOLVED_VALUE_LABEL, "Resolved value");
});

test("formatSettingTimestamp leaves an unparseable value alone", () => {
  assert.equal(formatSettingTimestamp("not a date"), "not a date");
});

test("formatSettingTimestamp rewrites a valid ISO timestamp", () => {
  const iso = "2026-09-12T08:30:00.000Z";
  const formatted = formatSettingTimestamp(iso);
  assert.notEqual(formatted, iso);
  assert.ok(formatted.length > 0);
  assert.match(formatted, /2026/);
});

test("formatSettingActor names the seed migration and otherwise says which user", () => {
  // The store keeps a user id, not a display name, so the label says so rather
  // than passing an opaque string off as a person's name.
  assert.equal(formatSettingActor("migration"), "by the seed migration");
  assert.equal(formatSettingActor("usr_42"), "by user usr_42");
});

test("displaySettingValue returns not set for null", () => {
  assert.equal(displaySettingValue(null), "not set");
});

test("displaySettingValue returns on for true", () => {
  assert.equal(displaySettingValue(true), "on");
});

test("displaySettingValue returns off for false", () => {
  assert.equal(displaySettingValue(false), "off");
});

test("displaySettingValue returns empty for empty array", () => {
  assert.equal(displaySettingValue([]), "empty");
});

test("displaySettingValue joins non-empty array with commas", () => {
  assert.equal(displaySettingValue(["a", "b", "c"]), "a, b, c");
});

test("displaySettingValue returns empty for empty string", () => {
  assert.equal(displaySettingValue(""), "empty");
});

test("displaySettingValue returns the number as string", () => {
  assert.equal(displaySettingValue(42), "42");
});

test("displaySettingValue returns non-empty string as is", () => {
  assert.equal(displaySettingValue("hello"), "hello");
});

test("settingIssuesFromMessage parses multiple issues with reasons", () => {
  const message =
    "Invalid settings: MCP_MAX_REQUEST_BYTES (below_minimum), AGENT_KIND (not_allowed_value)";
  const issues = settingIssuesFromMessage(message);
  assert.ok(issues.MCP_MAX_REQUEST_BYTES);
  assert.ok(issues.AGENT_KIND);
  assert.ok(
    issues.MCP_MAX_REQUEST_BYTES.includes("at least"),
  );
  assert.ok(
    issues.AGENT_KIND.includes("Allowed values"),
  );
});

test("settingIssuesFromMessage returns empty object for message with no keys", () => {
  const message = "Invalid reason";
  const issues = settingIssuesFromMessage(message);
  assert.deepEqual(issues, {});
});

test("settingIssuesFromMessage handles null_not_allowed reason", () => {
  const message = "Invalid settings: MAX_CONCURRENT_AGENTS (null_not_allowed)";
  const issues = settingIssuesFromMessage(message);
  assert.equal(
    issues.MAX_CONCURRENT_AGENTS,
    "This setting cannot be left empty.",
  );
});

test("settingIssuesFromMessage handles wrong_type reason", () => {
  const message = "Invalid settings: MAX_CONCURRENT_AGENTS (wrong_type)";
  const issues = settingIssuesFromMessage(message);
  assert.ok(
    issues.MAX_CONCURRENT_AGENTS.includes("integer"),
  );
});

test("settingIssuesFromMessage handles unknown_key reason", () => {
  const message = "Invalid settings: UNKNOWN_KEY (unknown_key)";
  const issues = settingIssuesFromMessage(message);
  assert.equal(
    issues.UNKNOWN_KEY,
    "This deployment's worker does not know this setting.",
  );
});
