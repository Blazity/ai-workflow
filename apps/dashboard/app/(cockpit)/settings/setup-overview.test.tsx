import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingsEntryView } from "@shared/contracts";
import { settingDefinition } from "@integrations/registry";

import { installTestDom } from "@/components/ui/test-dom";
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

// Red when: a page left open reads the clock only when it renders, so the
// scan behind the overview turns stale without the page saying so (review of
// #511).
test("an open page flags the scan once it passes the stale mark, without a re-render", (t) => {
  const now = Date.parse("2026-09-24T09:59:58.000Z");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const scan = {
    generatedAt: "2026-09-23T10:00:00.000Z",
    summary: {
      total: 0, live: 0, down: 0, notConfigured: 0, criticalDown: 0,
      checksTotal: 0, checksLive: 0, checksDown: 0, checksDegraded: 0,
    },
    integrations: [],
  };
  const dom = installTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root | undefined;
  try {
    act(() => {
      root = createRoot(container);
      root.render(<SetupOverview settings={[]} scan={scan} scanReadable catalogState={null} />);
    });
    assert.match(container.textContent ?? "", /come from the health scan of/);
    act(() => t.mock.timers.tick(5_000));
    assert.match(container.textContent ?? "", /may no longer be true/);
  } finally {
    act(() => root?.unmount());
    container.remove();
    dom.restore();
  }
});
