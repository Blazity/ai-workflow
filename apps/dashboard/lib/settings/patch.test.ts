import assert from "node:assert/strict";
import test from "node:test";
import {
  findSettingDefinition,
  type SettingsEntryView,
} from "@shared/contracts";
import {
  buildSettingsPatch,
  draftValueFor,
  isSettingChanged,
  localSettingIssue,
  localSettingIssues,
  settingsDraftFrom,
  toSettingValue,
} from "./patch";

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

test("draftValueFor returns boolean for boolean entry", () => {
  const e = entry("MCP_ENABLED", true);
  const draft = draftValueFor(e);
  assert.equal(draft, true);
  assert.equal(typeof draft, "boolean");
});

test("draftValueFor returns empty string for null value", () => {
  const e = entry("CLAUDE_MODEL", null);
  const draft = draftValueFor(e);
  assert.equal(draft, "");
});

test("draftValueFor joins string list with newlines", () => {
  const e = entry("PRE_PR_CHECKS_ALLOWED_ENV", ["VAR1", "VAR2"]);
  const draft = draftValueFor(e);
  assert.equal(draft, "VAR1\nVAR2");
});

test("draftValueFor converts number to string", () => {
  const e = entry("MAX_CONCURRENT_AGENTS", 5);
  const draft = draftValueFor(e);
  assert.equal(draft, "5");
  assert.equal(typeof draft, "string");
});

test("draftValueFor converts string to string", () => {
  const e = entry("DASHBOARD_ORG_NAME", "Test Org");
  const draft = draftValueFor(e);
  assert.equal(draft, "Test Org");
});

test("settingsDraftFrom covers every entry given", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
    entry("MCP_ENABLED", true),
  ];
  const draft = settingsDraftFrom(entries);
  assert.equal(Object.keys(draft).length, 3);
  assert.equal(draft.MAX_CONCURRENT_AGENTS, "3");
  assert.equal(draft.DASHBOARD_ORG_NAME, "Test");
  assert.equal(draft.MCP_ENABLED, true);
});

test("toSettingValue parses integer from numeric string", () => {
  const value = toSettingValue("MAX_CONCURRENT_AGENTS", "42");
  assert.equal(value, 42);
  assert.equal(typeof value, "number");
});

test("toSettingValue returns null for empty integer field", () => {
  const value = toSettingValue("V2_MAX_BLOCK_CONCURRENCY", "");
  assert.equal(value, null);
});

test("toSettingValue passes non-numeric integer field as trimmed string", () => {
  const value = toSettingValue("MAX_CONCURRENT_AGENTS", "not a number");
  assert.equal(value, "not a number");
  assert.equal(typeof value, "string");
});

test("toSettingValue splits string list on newlines and commas", () => {
  const value = toSettingValue("PRE_PR_CHECKS_ALLOWED_ENV", "VAR1\nVAR2,VAR3");
  assert.deepEqual(value, ["VAR1", "VAR2", "VAR3"]);
});

test("toSettingValue trims string list entries", () => {
  const value = toSettingValue(
    "PRE_PR_CHECKS_ALLOWED_ENV",
    " VAR1 , VAR2 \n VAR3 ",
  );
  assert.deepEqual(value, ["VAR1", "VAR2", "VAR3"]);
});

test("toSettingValue drops blank entries from string list", () => {
  const value = toSettingValue("PRE_PR_CHECKS_ALLOWED_ENV", "VAR1\n\nVAR2");
  assert.deepEqual(value, ["VAR1", "VAR2"]);
});

test("toSettingValue converts empty string to null for CLAUDE_MODEL", () => {
  const value = toSettingValue("CLAUDE_MODEL", "");
  assert.equal(value, null);
});

test("toSettingValue keeps empty string for DASHBOARD_ORG_NAME", () => {
  const value = toSettingValue("DASHBOARD_ORG_NAME", "");
  assert.equal(value, "");
});

test("toSettingValue passes boolean through", () => {
  const value = toSettingValue("MCP_ENABLED", true);
  assert.equal(value, true);
});

test("buildSettingsPatch includes only changed keys", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
    entry("MCP_ENABLED", false),
  ];
  const draft = {
    MAX_CONCURRENT_AGENTS: "5",
    DASHBOARD_ORG_NAME: "Test",
    MCP_ENABLED: true,
  };
  const patch = buildSettingsPatch(entries, draft);
  assert.ok(patch.MAX_CONCURRENT_AGENTS);
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, "DASHBOARD_ORG_NAME"));
  assert.ok(patch.MCP_ENABLED);
});

test("buildSettingsPatch skips entries missing from draft", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
  ];
  const draft = { MAX_CONCURRENT_AGENTS: "5" };
  const patch = buildSettingsPatch(entries, draft);
  assert.ok(patch.MAX_CONCURRENT_AGENTS);
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, "DASHBOARD_ORG_NAME"));
});

test("buildSettingsPatch detects list order change as change", () => {
  const entries = [
    entry("PRE_PR_CHECKS_ALLOWED_ENV", ["A", "B", "C"]),
  ];
  const draft = {
    PRE_PR_CHECKS_ALLOWED_ENV: "A\nC\nB",
  };
  const patch = buildSettingsPatch(entries, draft);
  assert.ok(patch.PRE_PR_CHECKS_ALLOWED_ENV);
});

test("buildSettingsPatch ignores re-typed identical list", () => {
  const entries = [
    entry("PRE_PR_CHECKS_ALLOWED_ENV", ["A", "B", "C"]),
  ];
  const draft = {
    PRE_PR_CHECKS_ALLOWED_ENV: "A\nB\nC",
  };
  const patch = buildSettingsPatch(entries, draft);
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, "PRE_PR_CHECKS_ALLOWED_ENV"));
});

test("isSettingChanged returns false when field unchanged", () => {
  const e = entry("MAX_CONCURRENT_AGENTS", 3);
  const draft = { MAX_CONCURRENT_AGENTS: "3" };
  assert.equal(isSettingChanged(e, draft), false);
});

test("isSettingChanged returns true when field changed", () => {
  const e = entry("MAX_CONCURRENT_AGENTS", 3);
  const draft = { MAX_CONCURRENT_AGENTS: "5" };
  assert.equal(isSettingChanged(e, draft), true);
});

test("isSettingChanged returns false when key missing from draft", () => {
  const e = entry("MAX_CONCURRENT_AGENTS", 3);
  const draft: Record<string, string | boolean> = {};
  assert.equal(isSettingChanged(e, draft), false);
});

test("isSettingChanged agrees with buildSettingsPatch", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("DASHBOARD_ORG_NAME", "Test"),
    entry("MCP_ENABLED", false),
  ];
  const draft = {
    MAX_CONCURRENT_AGENTS: "5",
    DASHBOARD_ORG_NAME: "Test",
    MCP_ENABLED: true,
  };
  const patch = buildSettingsPatch(entries, draft);
  for (const e of entries) {
    const changed = isSettingChanged(e, draft);
    const inPatch = Object.prototype.hasOwnProperty.call(patch, e.key);
    assert.equal(
      changed,
      inPatch,
      `isSettingChanged and buildSettingsPatch disagree for ${e.key}`,
    );
  }
});

// ── Trimming and deduping ───────────────────────────────────────────────────

test("a string value is trimmed, because a trailing space is invisible on screen", () => {
  assert.equal(toSettingValue("DASHBOARD_ORG_NAME", "  Acme  "), "Acme");
  // An empty field is still an empty string for a key whose default is not null:
  // "unset" is not a state that key has.
  assert.equal(toSettingValue("DASHBOARD_ORG_NAME", ""), "");
});

test("a whitespace only value is null for a key whose default is null", () => {
  assert.equal(toSettingValue("CLAUDE_MODEL", "   "), null);
});

test("a string list drops repeats and keeps the order they were first typed in", () => {
  assert.deepEqual(toSettingValue("PRE_PR_CHECKS_ALLOWED_ENV", "b, a, b, c"), [
    "b",
    "a",
    "c",
  ]);
  assert.deepEqual(
    toSettingValue("PRE_PR_CHECKS_ALLOWED_ENV", "ONE\n TWO \nONE\n\n"),
    ["ONE", "TWO"],
  );
});

test("a list re-typed with a repeat is not a change", () => {
  const entries = [entry("PRE_PR_CHECKS_ALLOWED_ENV", ["ONE", "TWO"])];
  const patch = buildSettingsPatch(entries, {
    PRE_PR_CHECKS_ALLOWED_ENV: "ONE\nTWO\nONE",
  });
  assert.deepEqual(patch, {});
});

// ── Refusals the form makes itself, before the request ──────────────────────

test("an emptied number field is refused locally when the key has no unset state", () => {
  assert.equal(
    localSettingIssue("MAX_CONCURRENT_AGENTS", ""),
    "Enter a whole number, at least 1",
  );
  assert.equal(
    localSettingIssue("MAX_CONCURRENT_AGENTS", "abc"),
    "Enter a whole number, at least 1",
  );
  assert.equal(localSettingIssue("MAX_CONCURRENT_AGENTS", "5"), undefined);
});

test("an emptied number field is fine when null is a real value for that key", () => {
  // V2_MAX_BLOCK_CONCURRENCY defaults to null: unset means the code-owned bound.
  assert.equal(localSettingIssue("V2_MAX_BLOCK_CONCURRENCY", ""), undefined);
  assert.equal(
    localSettingIssue("V2_MAX_BLOCK_CONCURRENCY", "abc"),
    "Enter a whole number, at least 1",
  );
});

test("a switch and an unknown key are never refused locally", () => {
  assert.equal(localSettingIssue("MCP_ENABLED", true), undefined);
  assert.equal(localSettingIssue("MCP_ENABLED", false), undefined);
  assert.equal(localSettingIssue("NOT_A_REGISTRY_KEY", ""), undefined);
});

test("an emptied text field is refused when the key has no unset state", () => {
  assert.equal(
    localSettingIssue("DASHBOARD_ORG_NAME", ""),
    "This setting cannot be left empty.",
  );
  assert.equal(localSettingIssue("CLAUDE_MODEL", ""), undefined);
});

test("localSettingIssues reports only the offending fields", () => {
  const entries = [
    entry("MAX_CONCURRENT_AGENTS", 3),
    entry("JOB_TIMEOUT_MS", 1_800_000),
    entry("MCP_ENABLED", false),
  ];
  const issues = localSettingIssues(entries, {
    MAX_CONCURRENT_AGENTS: "",
    JOB_TIMEOUT_MS: "60000",
    MCP_ENABLED: true,
  });
  assert.deepEqual(issues, {
    MAX_CONCURRENT_AGENTS: "Enter a whole number, at least 1",
  });
});

test("a field missing from the draft is not reported as an issue", () => {
  const entries = [entry("MAX_CONCURRENT_AGENTS", 3)];
  assert.deepEqual(localSettingIssues(entries, {}), {});
});
