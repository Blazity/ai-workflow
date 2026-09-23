import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingsEntryView } from "@shared/contracts";
import { settingDefinition } from "@integrations/registry";

import { SetupOverview } from "./setup-overview";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function entry(key: string, source: SettingsEntryView["source"]): SettingsEntryView {
  const definition = settingDefinition(key)!;
  return {
    key: key as SettingsEntryView["key"],
    value: definition.default,
    default: definition.default,
    source,
    group: definition.group,
    description: definition.description,
    appliesToRunsInFlight: definition.appliesToRunsInFlight,
    lastVersion: null,
  } as SettingsEntryView;
}

// Red when: the overview says "Capacity 1/2" while the panel below says
// "1 of 1 stored" (QA): one way of counting, in words.
test("the stored rows per group are said in words, the way the panels say them", () => {
  const html = renderToStaticMarkup(
    <SetupOverview
      settings={[entry("MAX_CONCURRENT_AGENTS", "stored"), entry("JOB_TIMEOUT_MS", "default")]}
      scan={null}
      scanReadable
      catalogState={null}
    />,
  );
  const text = html.replace(/<[^>]+>/g, "");
  assert.match(text, /1 of \d+ stored/);
  assert.doesNotMatch(text, /\d+\/\d+/);
});
