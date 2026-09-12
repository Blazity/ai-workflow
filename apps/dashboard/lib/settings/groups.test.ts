import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_REGISTRY,
  findSettingDefinition,
  type SettingsEntryView,
} from "@shared/contracts";
import {
  SETTINGS_GROUP_ORDER,
  groupSettings,
  selectGroupKeys,
  storedRowCount,
} from "./groups";

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

test("SETTINGS_GROUP_ORDER matches the order groups first appear in SETTINGS_REGISTRY", () => {
  const derived: string[] = [];
  for (const definition of SETTINGS_REGISTRY) {
    if (!derived.includes(definition.group)) derived.push(definition.group);
  }
  assert.deepEqual(SETTINGS_GROUP_ORDER, derived);
});

test("groupSettings returns panels in registry order", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
    entry("ENABLE_REPO_MEMORY", false),
  ];
  const groups = groupSettings(entries);
  const groupIds = groups.map((g) => g.id);
  const indices = groupIds.map(
    (id) => SETTINGS_GROUP_ORDER.indexOf(id as never),
  );
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], "groups are not in registry order");
  }
});

test("groupSettings puts each entry in its own group", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
    entry("ENABLE_REPO_MEMORY", false),
  ];
  const groups = groupSettings(entries);
  const allEntries = groups.flatMap((g) => g.entries);
  assert.equal(allEntries.length, entries.length);
  const resultKeys = new Set(allEntries.map((e) => e.key));
  const inputKeys = new Set(entries.map((e) => e.key));
  assert.deepEqual(resultKeys, inputKeys);
});

test("groupSettings drops empty groups", () => {
  const entries = [entry("DASHBOARD_ORG_NAME", "Test")];
  const groups = groupSettings(entries);
  assert.ok(
    !groups.some((g) => g.entries.length === 0),
    "empty groups were not dropped",
  );
  const groupIds = new Set(groups.map((g) => g.id));
  assert.ok(!groupIds.has("capacity"));
  assert.ok(groupIds.has("general"));
});

test("storedRowCount counts entries whose source is stored", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3, { source: "stored" }),
    entry("DASHBOARD_ORG_NAME", "Test", { source: "environment" }),
    entry("ENABLE_REPO_MEMORY", false, { source: "stored" }),
    entry("MCP_ENABLED", true, { source: "default" }),
  ];
  assert.equal(storedRowCount(entries), 2);
});

test("selectGroupKeys with undefined returns every entry", () => {
  const group = {
    id: "general" as const,
    label: "General",
    description: "Test",
    entries: [
      entry("DASHBOARD_ORG_NAME", "Test"),
      entry("GITHUB_BASE_BRANCH", "main"),
    ],
    storedCount: 0,
  };
  const result = selectGroupKeys(group, undefined);
  assert.deepEqual(result, group.entries);
});

test("selectGroupKeys with key list keeps only those keys", () => {
  const group = {
    id: "general" as const,
    label: "General",
    description: "Test",
    entries: [
      entry("DASHBOARD_ORG_NAME", "Test"),
      entry("GITHUB_BASE_BRANCH", "main"),
      entry("DASHBOARD_ORG_SLUG", "test"),
    ],
    storedCount: 0,
  };
  const result = selectGroupKeys(group, ["GITHUB_BASE_BRANCH"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "GITHUB_BASE_BRANCH");
});

test("selectGroupKeys maintains registry order even when keys passed in reverse", () => {
  const group = {
    id: "general" as const,
    label: "General",
    description: "Test",
    entries: [
      entry("DASHBOARD_ORG_NAME", "Test"),
      entry("GITHUB_BASE_BRANCH", "main"),
      entry("DASHBOARD_ORG_SLUG", "test"),
    ],
    storedCount: 0,
  };
  const result = selectGroupKeys(group, [
    "DASHBOARD_ORG_SLUG",
    "GITHUB_BASE_BRANCH",
  ]);
  assert.equal(result[0].key, "GITHUB_BASE_BRANCH");
  assert.equal(result[1].key, "DASHBOARD_ORG_SLUG");
});

test("selectGroupKeys with unknown key yields nothing extra", () => {
  const group = {
    id: "general" as const,
    label: "General",
    description: "Test",
    entries: [
      entry("DASHBOARD_ORG_NAME", "Test"),
      entry("GITHUB_BASE_BRANCH", "main"),
    ],
    storedCount: 0,
  };
  const result = selectGroupKeys(group, [
    "DASHBOARD_ORG_NAME",
    "UNKNOWN_KEY",
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "DASHBOARD_ORG_NAME");
});
