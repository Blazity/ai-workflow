// What the cockpit's navigation says for the states a person can be in:
// nothing connected, several connected, one connected and then switched off,
// somebody on a bookmarked System health URL, somebody deep inside an
// integration's area, and somebody on an integration nobody connected.
//
// These are the facts the chrome renders from, so they are asserted here where
// there is no React in the way.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_NAV_GROUPS,
  cockpitScreen,
  hrefForNavId,
  integrationMonogram,
  integrationNavEntries,
  isMobileMoreNavItem,
  type CockpitIntegration,
} from "./navigation";

function integration(
  id: string,
  name: string,
  overrides: Partial<CockpitIntegration> = {},
): CockpitIntegration {
  return { id, name, pages: [], usable: true, ...overrides };
}

const demo = integration("demo", "Demo", {
  pages: [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity" },
  ],
});

// ── The sidebar's entries ───────────────────────────────────────────────────

test("a deployment with nothing connected still has the Integrations page", () => {
  // The screen that says "nothing is connected" is the one somebody has to be
  // able to go and read; dropping the section with the integrations would hide
  // the answer along with the question.
  const entries = integrationNavEntries([]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["integrations"],
  );
  assert.equal(entries[0]!.href, "/integrations");
});

test("only connected and enabled integrations get an entry", () => {
  const entries = integrationNavEntries([
    demo,
    integration("acme", "Acme", { usable: false }),
    integration("other", "Other"),
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["integrations", "integration:demo", "integration:other"],
  );
});

test("an integration switched off leaves the sidebar", () => {
  // Same integration, same build, one flag: the entry is the answer to "why is
  // nothing running", and leaving it would say the opposite.
  const on = integrationNavEntries([demo]).map((entry) => entry.id);
  const off = integrationNavEntries([{ ...demo, usable: false }]).map((entry) => entry.id);
  assert.ok(on.includes("integration:demo"));
  assert.ok(!off.includes("integration:demo"));
});

test("an integration's entry opens its area, not its connection form", () => {
  const entry = integrationNavEntries([demo]).find((candidate) => candidate.id === "integration:demo");
  assert.equal(entry?.href, "/integrations/demo");
  assert.equal(hrefForNavId("integration:demo"), "/integrations/demo");
});

test("Settings is the last core entry, and System health and Users are not entries", () => {
  const core = CORE_NAV_GROUPS.flatMap((group) => group.entries).map((entry) => entry.id);
  assert.equal(core.at(-1), "settings");
  assert.ok(!core.includes("health"));
  assert.ok(!core.includes("users"));
  // Harness profiles stayed reachable when the administration group shrank.
  assert.ok(core.includes("profiles"));
});

test("everything but the three phone tabs is reachable from the More sheet", () => {
  // The bottom tab bar carries three screens, so anything the More sheet drops
  // cannot be reached from a phone at all.
  for (const id of CORE_NAV_GROUPS.flatMap((group) => group.entries).map((entry) => entry.id)) {
    assert.equal(isMobileMoreNavItem(id), !["overview", "runs", "editor"].includes(id));
  }
  assert.ok(isMobileMoreNavItem("integrations"));
  assert.ok(isMobileMoreNavItem("integration:demo"));
});

// ── The collapsed rail ──────────────────────────────────────────────────────

test("two brands that start with the same letter get different monograms", () => {
  // The rail is glyphs only. GitHub and GitLab are the pair this has to
  // survive, and a first letter would have drawn both as G.
  assert.equal(integrationMonogram("GitHub"), "GH");
  assert.equal(integrationMonogram("GitLab"), "GL");
  assert.equal(integrationMonogram("Jira"), "JI");
  assert.equal(integrationMonogram("Slack"), "SL");
  assert.equal(integrationMonogram("Arthur"), "AR");
  assert.equal(integrationMonogram("Demo"), "DE");
});

test("a monogram does not change when a name is recased", () => {
  // The mark is on screen and in muscle memory. Deriving it from the capitals
  // alone made it move when a manifest edited its own `name`: Mem0 drew M0 and
  // mem0 drew ME, for the same integration.
  assert.equal(integrationMonogram("Mem0"), "ME");
  assert.equal(integrationMonogram("mem0"), "ME");
  assert.equal(integrationMonogram("OPENAI"), "OP");
});

test("a monogram is never empty, whatever the name is", () => {
  assert.equal(integrationMonogram("!!!"), "??");
  assert.equal(integrationMonogram("x"), "X");
  assert.equal(integrationMonogram(" Zoom "), "ZO", "surrounding space is not a letter");
  // A name with no Latin letters keeps its own first two characters rather
  // than becoming a pair of question marks nobody can tell from another pair.
  assert.equal(integrationMonogram("\u65E5\u672C\u8A9E"), "\u65E5\u672C");
});

// ── What screen a path is ───────────────────────────────────────────────────

test("System health under Settings still refuses the cockpit's refresh timer", () => {
  // The regression this exists for: the shell used to read the first path
  // segment and compare it to "health". Moving the screen under Settings makes
  // that comparison stop matching without a word, and the cockpit would start
  // polling a screen whose every refresh contacts every configured provider.
  const health = cockpitScreen("/settings/health");
  assert.equal(health.allowsLivePolling, false);
  assert.equal(health.navId, "settings");
  assert.equal(health.title, "System health");
});

test("the rest of the Settings area polls like any other screen", () => {
  for (const path of ["/settings", "/settings/users"]) {
    assert.equal(cockpitScreen(path).allowsLivePolling, true, path);
    assert.equal(cockpitScreen(path).navId, "settings", path);
  }
  assert.equal(cockpitScreen("/settings/users").title, "Users");
  assert.equal(cockpitScreen("/settings").title, "Settings");
});

test("an integration's page announces the integration and the page", () => {
  // Not "Integrations": somebody with four tabs open has to be able to tell
  // them apart from the topbar, and so does the mobile header, which is the
  // only title a phone shows.
  assert.deepEqual(cockpitScreen("/integrations/demo/activity", [demo]), {
    navId: "integration:demo",
    title: "Demo / Activity",
    allowsLivePolling: true,
  });
  assert.equal(cockpitScreen("/integrations/demo/connection", [demo]).title, "Demo / Connection");
  assert.equal(cockpitScreen("/integrations/demo", [demo]).title, "Demo");
});

test("an integration nobody connected still names itself", () => {
  // It has no sidebar entry, and it is reached from a card on the Integrations
  // list. The area still has to say whose connection form this is.
  const screen = cockpitScreen("/integrations/demo/connection", [{ ...demo, usable: false }]);
  assert.equal(screen.title, "Demo / Connection");
  assert.equal(screen.navId, "integration:demo");
});

test("an id this build does not ship falls back to the Integrations page", () => {
  const screen = cockpitScreen("/integrations/nope/whatever", [demo]);
  assert.equal(screen.navId, "integrations");
  assert.equal(screen.title, "Integrations");
});

test("a page id the integration does not declare still names the integration", () => {
  assert.equal(cockpitScreen("/integrations/demo/nope", [demo]).title, "Demo");
});

test("a segment past the tab is a 404, and the topbar says so", () => {
  // Next renders its not-found inside this layout, so a topbar still naming
  // the integration and the page describes a screen that is not on display.
  const deep = cockpitScreen("/integrations/demo/activity/extra", [demo]);
  assert.equal(deep.navId, "integrations");
  assert.equal(deep.title, "Integrations");
  const settings = cockpitScreen("/settings/health/extra");
  assert.equal(settings.navId, "settings");
  assert.equal(settings.title, "Settings");
  // And that deeper path is not a health screen, so the polling rule that
  // belongs to health does not follow it there.
  assert.equal(settings.allowsLivePolling, true);
});

test("a trailing slash is the same screen", () => {
  assert.deepEqual(cockpitScreen("/settings/health/"), cockpitScreen("/settings/health"));
  assert.deepEqual(
    cockpitScreen("/integrations/demo/activity/", [demo]),
    cockpitScreen("/integrations/demo/activity", [demo]),
  );
});

test("the screens that were there before are unchanged", () => {
  assert.deepEqual(cockpitScreen("/"), {
    navId: "overview",
    title: "Overview",
    allowsLivePolling: true,
  });
  assert.equal(cockpitScreen("/runs").title, "Workflow runs");
  assert.equal(cockpitScreen("/memory").title, "Agent memory");
  assert.equal(cockpitScreen("/trace/run_123").title, "Run trace");
  assert.equal(cockpitScreen("/trace/run_123").navId, "trace");
  assert.equal(cockpitScreen("/ticket/AIW-1").title, "Ticket runs");
  assert.equal(cockpitScreen("/integrations").navId, "integrations");
});

test("every sidebar entry leads somewhere", () => {
  const entries = [
    ...CORE_NAV_GROUPS.flatMap((group) => group.entries),
    ...integrationNavEntries([demo]),
  ];
  for (const entry of entries) {
    assert.equal(hrefForNavId(entry.id), entry.href, entry.id);
    // And back again: the entry a path lights is the entry it came from.
    assert.equal(cockpitScreen(entry.href, [demo]).navId, entry.id, entry.href);
  }
});
