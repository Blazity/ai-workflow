import assert from "node:assert/strict";
import test from "node:test";
import { settingDefinition } from "@integrations/registry";
import type { SettingsEntryView, SettingsVersionView } from "@shared/contracts";

import {
  conflictLines,
  isSettingsVersionConflict,
  keepEditsOver,
  takeTheirs,
} from "./conflict";
import { settingsDraftFrom } from "./patch";

function entry(
  key: string,
  value: SettingsEntryView["value"],
  overrides: Partial<SettingsEntryView> = {},
): SettingsEntryView {
  const definition = settingDefinition(key);
  assert.ok(definition, `${key} is not a registry key`);
  return {
    key,
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

function version(id: number, newValue: SettingsEntryView["value"], actorLabel?: string): SettingsVersionView {
  return {
    id,
    key: "MAX_CONCURRENT_AGENTS",
    previousValue: 3,
    newValue,
    actor: "usr_ada",
    ...(actorLabel === undefined ? {} : { actorLabel }),
    reason: "their reason",
    createdAt: "2026-09-23T12:00:00.000Z",
  };
}

test("isSettingsVersionConflict tells the 409 body apart from any other refusal", () => {
  assert.equal(
    isSettingsVersionConflict({ error: "settings_version_conflict", conflicts: [] }),
    true,
  );
  assert.equal(isSettingsVersionConflict({ statusMessage: "Forbidden" }), false);
  assert.equal(isSettingsVersionConflict("Draft changed"), false);
  assert.equal(isSettingsVersionConflict(null), false);
});

test("a refresh keeps what the person is typing and takes everything else from the server", () => {
  // Live refreshes the page. A form that re-seeded itself wholesale threw away
  // an edit the moment another tab stored anything in the same group.
  const loaded = [entry("MAX_CONCURRENT_AGENTS", 3), entry("COLUMN_AI", "AI")];
  const draft = { ...settingsDraftFrom(loaded), MAX_CONCURRENT_AGENTS: "9" };
  const fresh = [
    entry("MAX_CONCURRENT_AGENTS", 5, { source: "stored", lastVersion: version(12, 5) }),
    entry("COLUMN_AI", "Agent", { source: "stored" }),
  ];

  const next = keepEditsOver(loaded, draft, fresh);

  assert.equal(next.draft.MAX_CONCURRENT_AGENTS, "9", "the typed value was dropped");
  // The edited key keeps the version it was typed against, so storing it is
  // refused with a conflict that shows the new value, instead of quietly
  // overwriting a change nobody here saw.
  assert.equal(next.saved[0]?.lastVersion, null);
  assert.equal(next.draft.COLUMN_AI, "Agent");
  assert.equal(next.saved[1]?.value, "Agent");
});

test("a conflict is read as who changed what, and nothing stored", () => {
  const conflicts = [
    {
      key: "MAX_CONCURRENT_AGENTS",
      expectedVersion: 0,
      currentVersion: 12,
      setting: entry("MAX_CONCURRENT_AGENTS", 5, {
        source: "stored",
        lastVersion: version(12, 5, "ada@example.com"),
      }),
    },
  ];
  const lines = conflictLines(conflicts);
  assert.match(lines[0]!, /Max concurrent agents was changed by ada@example\.com on /);
  assert.match(lines[0]!, /after this page loaded it: it is now 5\./);
});

test("taking theirs replaces only the conflicting keys' edits", () => {
  const draft = { MAX_CONCURRENT_AGENTS: "9", COLUMN_AI: "Robot" };
  const conflicts = [
    {
      key: "MAX_CONCURRENT_AGENTS",
      expectedVersion: 0,
      currentVersion: 12,
      setting: entry("MAX_CONCURRENT_AGENTS", 5, { source: "stored" }),
    },
  ];
  assert.deepEqual(takeTheirs(draft, conflicts), { MAX_CONCURRENT_AGENTS: "5", COLUMN_AI: "Robot" });
});
