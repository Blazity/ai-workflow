/**
 * How an integration's setting becomes one of the deployment's settings, and
 * how its value comes back out of a snapshot. The expected keys are the ones
 * operators already know: `SLACK_ALLOWED_USER_IDS` is the variable SETUP.md has
 * named since the slash command existed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SETTINGS_REGISTRY,
  type SettingValue,
  resolveSettingsSnapshot,
  validateSettingsPatch,
} from "@shared/contracts";
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

test("a declared setting is written, validated and resolved by core's rules, its variable included", () => {
  const definition = integrationSettingDefinition({ id: "slack", name: "Slack" }, ALLOWLIST);
  const find = (key: string) => (key === definition.key ? definition : undefined);
  const resolve = (stored: Map<string, SettingValue>, variables: Record<string, string>) => {
    const { snapshot, sources } = resolveSettingsSnapshot(
      stored,
      { value: (variable) => variables[variable], isSet: (variable) => variable in variables },
      [definition],
    );
    const values = snapshot as unknown as Record<string, unknown>;
    return { value: values.SLACK_ALLOWED_USER_IDS, source: sources.get("SLACK_ALLOWED_USER_IDS") };
  };

  // The deployment that set the variable before the setting existed keeps it.
  assert.deepEqual(resolve(new Map(), { SLACK_ALLOWED_USER_IDS: "U1, U2" }), {
    value: ["U1", "U2"],
    source: "environment",
  });
  assert.deepEqual(resolve(new Map(), {}), { value: [], source: "default" });
  // A value stored from the Settings page wins over the variable.
  assert.deepEqual(resolve(new Map([["SLACK_ALLOWED_USER_IDS", ["U3"]]]), { SLACK_ALLOWED_USER_IDS: "U1" }), {
    value: ["U3"],
    source: "stored",
  });
  assert.deepEqual(validateSettingsPatch({ SLACK_ALLOWED_USER_IDS: "U1" }, find), [
    { key: "SLACK_ALLOWED_USER_IDS", reason: "wrong_type" },
  ]);
  // The Settings page files it with the integrations and names whose it is.
  assert.equal(definition.group, "integrations");
  assert.equal(definition.description, "Slack: Who may run the slash command.");
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
