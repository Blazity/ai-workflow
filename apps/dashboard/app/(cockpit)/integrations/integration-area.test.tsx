// An integration's own area: the tabs it shows, and what stands behind a tab
// when the page, the build or the connection is not what the URL assumed.
//
// The file lives here rather than under `[id]/`, because a test file inside a
// dynamic-route directory is never run: the runner's glob reads the brackets as
// a character class and matches nothing (S6 found that hole and it is still
// open).
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import type { IntegrationDto, IntegrationState } from "@shared/contracts";

import { CockpitCtx } from "@/components/cockpit/context";
import { contributedPageOutcome } from "@/lib/integrations/presentation";

import ContributedPageLoading from "./[id]/[page]/loading";
import { IntegrationAreaTabs } from "./integration-area-tabs";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGES = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
];

// ── The tab strip ───────────────────────────────────────────────────────────

function renderTabs(
  t: TestContext,
  pathname: string,
  pages: readonly { id: string; label: string }[],
  navigate: (href: string) => boolean = () => true,
): ReactTestInstance {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      <PathnameContext.Provider value={pathname}>
        <CockpitCtx.Provider value={{ navigate } as never}>
          <IntegrationAreaTabs id="demo" name="Demo" pages={pages} />
        </CockpitCtx.Provider>
      </PathnameContext.Provider>,
    );
  });
  t.after(() => act(() => renderer.unmount()));
  return renderer.root;
}

function tabs(root: ReactTestInstance): string[] {
  return root
    .findAll((node) => node.type === "a")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"));
}

test("an integration's pages come first and Connection last", (t) => {
  // Somebody who opened an integration from the sidebar came to read what it
  // is doing. Connection is the setup: needed on the first afternoon and
  // rarely again, so it does not get to be what every visit opens on.
  const root = renderTabs(t, "/integrations/demo/overview", PAGES);
  assert.deepEqual(tabs(root), ["Overview", "Activity", "Connection"]);
});

test("an integration with no pages shows no tab strip at all", (t) => {
  // Connection alone is not a choice, and a strip offering one tab is
  // furniture that says an integration has more than it has.
  const root = renderTabs(t, "/integrations/demo/connection", []);
  assert.equal(root.findAll((node) => node.type === "a").length, 0);
  assert.equal(root.findAll((node) => node.type === "nav").length, 0);
});

test("the tab the URL names is the one marked current", (t) => {
  for (const [pathname, expected] of [
    ["/integrations/demo/overview", "Overview"],
    ["/integrations/demo/activity", "Activity"],
    ["/integrations/demo/connection", "Connection"],
  ] as const) {
    const root = renderTabs(t, pathname, PAGES);
    const current = root
      .findAll((node) => node.type === "a" && node.props["aria-current"] === "page")
      .flatMap((node) => node.children.filter((child) => typeof child === "string"));
    assert.deepEqual(current, [expected], pathname);
  }
});

test("a tab navigates through the cockpit, so unsaved work is asked about", (t) => {
  // The Connection form holds a half-typed token. A plain link next to it would
  // throw that away without a word; the shell's `navigate` is what asks.
  const asked: string[] = [];
  const root = renderTabs(t, "/integrations/demo/connection", PAGES, (href) => {
    asked.push(href);
    return true;
  });
  const overview = root.find(
    (node) => node.type === "a" && node.children.includes("Overview"),
  );
  act(() =>
    overview.props.onClick({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
    }),
  );
  assert.deepEqual(asked, ["/integrations/demo/overview"]);
});

// ── What stands behind a tab ────────────────────────────────────────────────

function state(overrides: Partial<IntegrationState> = {}): IntegrationState {
  return {
    integrationId: "demo",
    enabled: true,
    source: "environment",
    status: "connected",
    connection: "connected",
    verification: { state: "never_tested" },
    failure: null,
    usable: true,
    environment: { setVariables: [], missingVariables: [], complete: true },
    stored: {
      latestVersion: 0,
      activeVersion: null,
      missingFields: [],
      complete: false,
      prepared: null,
    },
    pin: { integrationId: "demo", configFingerprint: "abc123abc123" },
    secretsKeyAvailable: true,
    ...overrides,
  };
}

function integration(overrides: Partial<IntegrationState> = {}): IntegrationDto {
  return {
    id: "demo",
    name: "Demo",
    description: "A deterministic provider used for demos.",
    capabilities: [],
    blocks: [],
    pages: PAGES,
    fields: [],
    state: state(overrides),
  };
}

const manifest = { name: "Demo", pages: PAGES };

test("a connected integration's declared page is handed to the integration", () => {
  const outcome = contributedPageOutcome({
    manifest,
    pageId: "activity",
    hasComponent: true,
    integration: integration(),
  });
  assert.deepEqual(outcome, { kind: "render", label: "Activity" });
});

test("a page id nobody declared says which pages exist", () => {
  // The URL somebody kept after an integration dropped a page, or a typo.
  const outcome = contributedPageOutcome({
    manifest,
    pageId: "nope",
    hasComponent: false,
    integration: integration(),
  });
  assert.equal(outcome.kind, "notice");
  assert.equal(outcome.kind === "notice" && outcome.title, "No page under that name");
  assert.match(
    outcome.kind === "notice" ? outcome.body : "",
    /Demo contributes Overview and Activity, and nothing called "nope"/,
  );
  assert.equal(outcome.kind === "notice" && outcome.action, "integration");
});

test("an integration that contributes nothing says so rather than listing nothing", () => {
  const outcome = contributedPageOutcome({
    manifest: { name: "Demo", pages: [] },
    pageId: "overview",
    hasComponent: false,
  });
  assert.match(outcome.kind === "notice" ? outcome.body : "", /Demo contributes no pages/);
});

test("a declared page this build did not compile blames the build, not the person", () => {
  const outcome = contributedPageOutcome({
    manifest,
    pageId: "overview",
    hasComponent: false,
    integration: integration(),
  });
  assert.equal(outcome.kind === "notice" && outcome.title, "This page did not ship");
  assert.match(outcome.kind === "notice" ? outcome.body : "", /registry generator/);
});

test("a page is not run at all while the integration is not in use", () => {
  // Three ways to not be in use, three different afternoons, so three
  // different sentences. All of them point at the one tab that can fix it.
  const cases = [
    [integration({ enabled: false, status: "disabled", usable: false }), /switched off/],
    [
      integration({ connection: "not_connected", status: "not_connected", usable: false }),
      /is not connected/,
    ],
    [
      integration({ connection: "failing", status: "failing", usable: false }),
      /connection is failing/,
    ],
  ] as const;
  for (const [dto, expected] of cases) {
    const outcome = contributedPageOutcome({
      manifest,
      pageId: "overview",
      hasComponent: true,
      integration: dto,
    });
    assert.equal(outcome.kind, "notice", dto.state.status);
    assert.match(outcome.kind === "notice" ? outcome.body : "", expected);
    assert.equal(outcome.kind === "notice" && outcome.action, "connection");
    // The tab is still named, so the person knows what they were opening.
    assert.equal(outcome.kind === "notice" && outcome.title, "Overview");
  }
});

test("a worker that did not answer blocks the page and blames the right side", () => {
  // The rule is that an integration's code runs once the deployment has said
  // the integration is in use. "We could not ask" is not that sentence: an
  // integration somebody disabled an hour ago would start running again the
  // moment our worker went quiet. The words name our outage, not theirs.
  const outcome = contributedPageOutcome({
    manifest,
    pageId: "overview",
    hasComponent: true,
    integration: undefined,
    workerAnswered: false,
  });
  assert.equal(outcome.kind, "notice");
  assert.match(outcome.kind === "notice" ? outcome.body : "", /could not be read just now/u);
  assert.equal(outcome.kind === "notice" && outcome.title, "Overview");
});

test("an integration this build stopped shipping says that instead", () => {
  // The worker answered and did not list it, which is a different afternoon
  // from the worker not answering, and the same blank page either way.
  const outcome = contributedPageOutcome({
    manifest,
    pageId: "overview",
    hasComponent: true,
    integration: undefined,
    workerAnswered: true,
  });
  assert.equal(outcome.kind, "notice");
  assert.match(outcome.kind === "notice" ? outcome.body : "", /does not ship Demo any more/u);
});

test("a tab is a real link, so cmd-click opens it and the address bar is right", (t) => {
  // The sidebar entries are anchors for exactly this reason, and a tab strip
  // that swallowed a cmd-click would be the one place in the cockpit where
  // that stopped working.
  const asked: string[] = [];
  const root = renderTabs(t, "/integrations/demo/connection", PAGES, (href) => {
    asked.push(href);
    return true;
  });
  const activity = root.find(
    (node) => node.type === "a" && node.children.includes("Activity"),
  );
  assert.equal(activity.props.href, "/integrations/demo/activity");
  let prevented = 0;
  act(() =>
    activity.props.onClick({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        prevented += 1;
      },
    }),
  );
  assert.deepEqual(asked, [], "a modified click is not a cockpit navigation");
  assert.equal(prevented, 0);
});

// ── While a contributed page is fetching ────────────────────────────────────

test("a contributed page that is still fetching says so", (t) => {
  // Every page the provider stages contribute will fetch something, and the
  // segment had no Suspense boundary of its own: a three second provider left
  // the previous screen on display, so the tab click read as not having
  // landed and the person clicked again.
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<ContributedPageLoading />);
  });
  t.after(() => act(() => renderer.unmount()));
  const root = renderer.root;
  const busy = root.findAll((node) => node.props["aria-busy"] === "true");
  assert.equal(busy.length, 1, "the waiting region says it is waiting");
  assert.match(
    root
      .findAll(() => true)
      .flatMap((node) => node.children.filter((child) => typeof child === "string"))
      .join(" "),
    /Loading this page/u,
  );
});
