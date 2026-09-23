/**
 * How an integration's setting becomes one of the deployment's settings, and
 * how its value comes back out of a snapshot. The expected keys are the ones
 * operators already know: `SLACK_ALLOWED_USER_IDS` is the variable SETUP.md has
 * named since the slash command existed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS_REGISTRY } from "@shared/contracts";
import {
  integrationSettingDefinition,
  integrationSettingKey,
  integrationSettingValues,
  settingDefinitionsOf,
} from "./index";

const ALLOWLIST = {
  key: "allowedUserIds",
  description: "Who may run the slash command.",
  type: "string-list",
  default: [],
  env: "SLACK_ALLOWED_USER_IDS",
} as const;

test("a setting is stored under the integration id and its key, in UPPER_SNAKE_CASE", () => {
  assert.equal(integrationSettingKey("slack", "allowedUserIds"), "SLACK_ALLOWED_USER_IDS");
  assert.equal(integrationSettingKey("acme2", "maxRetries"), "ACME2_MAX_RETRIES");
  assert.equal(integrationSettingKey("acme", "v2Labels"), "ACME_V2_LABELS");
});

test("a setting is described the way the settings registry describes every setting", () => {
  assert.deepEqual(integrationSettingDefinition({ id: "slack", name: "Slack" }, ALLOWLIST), {
    key: "SLACK_ALLOWED_USER_IDS",
    group: "integrations",
    type: "string-list",
    default: [],
    description: "Slack: Who may run the slash command.",
    // Read by a webhook when its request arrives, never inside a run.
    appliesToRunsInFlight: "immediate",
    overridablePerTrigger: false,
    environmentVariable: "SLACK_ALLOWED_USER_IDS",
  });
});

test("the joined list is core's registry first, then what the integrations declare", () => {
  const joined = settingDefinitionsOf([
    { id: "slack", name: "Slack", settings: [ALLOWLIST] } as never,
    { id: "acme", name: "Acme" } as never,
  ]);
  assert.deepEqual(joined.slice(0, SETTINGS_REGISTRY.length), [...SETTINGS_REGISTRY]);
  assert.deepEqual(
    joined.slice(SETTINGS_REGISTRY.length).map((definition) => definition.key),
    ["SLACK_ALLOWED_USER_IDS"],
  );
});

test("ctx.settings is read out of the snapshot by the stored key", () => {
  assert.deepEqual(
    integrationSettingValues({ id: "slack", settings: [ALLOWLIST] }, { SLACK_ALLOWED_USER_IDS: ["U1"] }),
    { allowedUserIds: ["U1"] },
  );
});

test("a snapshot that does not carry the setting is refused, not read as the default", () => {
  // The default of an allowlist is "everyone": a snapshot loaded without the
  // integrations' settings must not quietly open the command.
  assert.throws(
    () => integrationSettingValues({ id: "slack", settings: [ALLOWLIST] }, { COLUMN_AI: "AI" }),
    /SLACK_ALLOWED_USER_IDS/u,
  );
});
