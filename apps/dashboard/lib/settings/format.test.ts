import assert from "node:assert/strict";
import test from "node:test";
import {
  RESOLVED_VALUE_LABEL,
  SETTINGS_CADENCE_NOTICE,
  appliesToNote,
  displaySettingValue,
  fallbackSentence,
  formatSettingActor,
  formatSettingTimestamp,
  settingIssuesFromMessage,
  settingLabel,
  sourceHint,
  sourceLabel,
} from "./format";
import { SETTING_LIST_ENTRY_RULE } from "@shared/contracts";
import { formatDateTime } from "../date-time";

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

test("settingLabel converts V2_MAX_BLOCK_CONCURRENCY to V2 max block concurrency", () => {
  assert.equal(
    settingLabel("V2_MAX_BLOCK_CONCURRENCY"),
    "V2 max block concurrency",
  );
});

// The casing table is the SETTINGS vocabulary. A provider's own variables are
// connection fields, labelled by the manifest that declares them, and this
// function is never handed one: a spelling kept here for a provider would be
// core carrying a provider's name for a key that cannot arrive.
test("settingLabel keeps no spelling for a provider's connection variable", () => {
  assert.equal(settingLabel("GITHUB_BOT_LOGIN"), "Github bot login");
});

test("settingLabel converts ATTACHMENT_MAX_FILE_SIZE_MB to Attachment max file size MB", () => {
  assert.equal(
    settingLabel("ATTACHMENT_MAX_FILE_SIZE_MB"),
    "Attachment max file size MB",
  );
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

test("appliesToNote states the cadence, without the retired \"once the worker reads\" prefix", () => {
  // The worker has read one settings snapshot per request, cron tick and MCP
  // call since stage B1, so a prefix saying a stored value reaches nothing was
  // the claim that had become false, not the cadence itself.
  assert.equal(appliesToNote("immediate"), "Applies immediately");
  assert.equal(
    appliesToNote("next run"),
    "Applies to the next run; a run already under way keeps the settings it started with",
  );
  assert.doesNotMatch(appliesToNote("immediate"), /Once the worker reads/);
});

test("appliesToNote sends a key the worker reads from its environment to the deployment", () => {
  // DASHBOARD_ORG_SLUG is filed "next run" in the registry and marked
  // requiresRedeploy, because the auth instance composes its value at module
  // load. The store does not decide it at all, so promising a run would pick a
  // stored value up is the one wrong answer here.
  const note = appliesToNote("next run", true);

  assert.match(note, /deployment environment/);
  assert.match(note, /redeploy/);
  assert.doesNotMatch(note, /next run/);
});

test("the standing notice states the read cadence instead of claiming the worker ignores the store", () => {
  assert.match(SETTINGS_CADENCE_NOTICE, /stored setting is read/);
  assert.match(SETTINGS_CADENCE_NOTICE, /per request, cron tick and MCP call/);
  assert.match(SETTINGS_CADENCE_NOTICE, /applies immediately or to the next run/);
  // The sentence this banner used to carry, contradicted by stage B1.
  assert.doesNotMatch(SETTINGS_CADENCE_NOTICE, /still reads most settings from its environment/);
  assert.doesNotMatch(SETTINGS_CADENCE_NOTICE, /consumers stages/);
});

test("the standing notice makes no claim about the page it is on", () => {
  // System health mounts it too, and saves nothing: "Values saved here" read
  // there like a warning about something the page had just done.
  assert.doesNotMatch(SETTINGS_CADENCE_NOTICE, /saved here/i);
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
  assert.equal(formatted, formatDateTime(iso));
});

test("formatSettingActor names the seed migration and otherwise says which user", () => {
  // Without a label (a worker from before the field) the id is all there is,
  // so the text says it is one rather than passing it off as a name.
  assert.equal(formatSettingActor("migration"), "by the seed migration");
  assert.equal(formatSettingActor("usr_42"), "by user usr_42");
});

test("formatSettingActor names the person the worker resolved, not their user id", () => {
  // QA read "by user A2FzRCBJ5e0eMggEB4N8D2pcWASWphDW" in the history.
  assert.equal(
    formatSettingActor("A2FzRCBJ5e0eMggEB4N8D2pcWASWphDW", "admin@blazity.com"),
    "by admin@blazity.com",
  );
  // The worker echoes the id when no user has it: a deleted account.
  assert.equal(formatSettingActor("usr_gone", "usr_gone"), "by user usr_gone");
  assert.equal(formatSettingActor("migration", "migration"), "by the seed migration");
});

test("fallbackSentence says what takes over and where it comes from", () => {
  assert.equal(
    fallbackSentence({ value: 3, source: "default" }, undefined),
    "3 takes over: the built-in default.",
  );
  assert.equal(
    fallbackSentence({ value: ["U01"], source: "environment" }, "SLACK_ALLOWED_USER_IDS"),
    "U01 takes over, from the environment variable SLACK_ALLOWED_USER_IDS.",
  );
  // A worker from before the field: say what we know, not a value we do not.
  assert.equal(
    fallbackSentence(undefined, undefined),
    "The environment variable or, without one, the built-in default takes over.",
  );
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
    "Invalid settings: MCP_MAX_REQUEST_BYTES (below_minimum), MAX_CONCURRENT_AGENTS (wrong_type)";
  const issues = settingIssuesFromMessage(message);
  assert.ok(issues.MCP_MAX_REQUEST_BYTES);
  assert.ok(issues.MAX_CONCURRENT_AGENTS);
  assert.ok(
    issues.MCP_MAX_REQUEST_BYTES.includes("at least"),
  );
  assert.ok(
    issues.MAX_CONCURRENT_AGENTS.includes("integer"),
  );
});

test("settingIssuesFromMessage returns empty object for message with no keys", () => {
  const message = "Invalid reason";
  const issues = settingIssuesFromMessage(message);
  assert.deepEqual(issues, {});
});

test("settingIssuesFromMessage says to send one value per entry, as the worker's refusal does", () => {
  const message = `Invalid settings: SLACK_ALLOWED_USER_IDS (list_entry_invalid). ${SETTING_LIST_ENTRY_RULE}`;
  const issues = settingIssuesFromMessage(message);
  assert.deepEqual(issues, { SLACK_ALLOWED_USER_IDS: SETTING_LIST_ENTRY_RULE });
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
