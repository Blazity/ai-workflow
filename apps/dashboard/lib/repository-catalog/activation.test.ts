import assert from "node:assert/strict";
import test from "node:test";

import type {
  RepositoryCatalogClaimedRepository,
  RepositoryCatalogEntry,
  RepositoryOption,
} from "@shared/contracts";

import {
  acknowledgedKeys,
  activationBlocker,
  activationImpact,
  activationSummary,
  claimedDetail,
  claimedSummary,
  staleActivationNotice,
  uncataloguedSummary,
} from "./activation";

function option(path: string): RepositoryOption {
  const slash = path.lastIndexOf("/");
  return {
    provider: "github",
    repoPath: path,
    owner: path.slice(0, slash),
    name: path.slice(slash + 1),
    defaultBranch: "main",
    private: false,
    archived: false,
  };
}

function entry(path: string, enabled: boolean): RepositoryCatalogEntry {
  return {
    id: path.length,
    provider: "github",
    path,
    displayName: path,
    defaultBranch: "main",
    description: "",
    rules: "",
    relationships: [],
    enabled,
    source: "imported",
    profileVersion: 0,
    checksVersion: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const CLAIMED: RepositoryCatalogClaimedRepository[] = [
  {
    key: "github:acme/web",
    displayName: "acme/web",
    ticketKeys: ["AIW-1", "AIW-2"],
    runIds: ["run-a"],
  },
];

test("the dialog counts the rows that stop passing, not only the ones holding a claim", () => {
  const impact = activationImpact({
    repositories: [
      entry("acme/web", false),
      entry("acme/api", false),
      entry("acme/ops", false),
      entry("acme/docs", true),
    ],
    claimed: CLAIMED,
    directory: [],
  });

  assert.equal(impact.stopping.length, 3);
  assert.equal(impact.keeping.length, 1);
  const summary = activationSummary(impact);
  assert.ok(summary.includes("3 repositories"), summary);
  assert.ok(summary.includes("1 repository stays selectable"), summary);
  assert.ok(
    summary.indexOf("3 repositories") < summary.indexOf("1 repository"),
    "the headline is the population that stops, which is larger than the claimed list",
  );
});

test("a catalog with everything enabled says activating changes nothing today", () => {
  const impact = activationImpact({
    repositories: [entry("acme/web", true)],
    claimed: [],
    directory: [option("acme/web")],
  });
  assert.ok(activationSummary(impact).includes("changes nothing"));
});

test("no claims is stated in words, so it cannot be read as nobody having looked", () => {
  const impact = activationImpact({
    repositories: [entry("acme/web", false)],
    claimed: [],
    directory: [],
  });
  assert.equal(
    claimedSummary(impact),
    "No repository that stops passing currently holds a run claim.",
  );
});

test("a claimed repository names the tickets and runs it was found through", () => {
  const impact = activationImpact({
    repositories: [entry("acme/web", false)],
    claimed: CLAIMED,
    directory: [],
  });
  assert.ok(claimedSummary(impact).includes("1 repository"));
  assert.ok(claimedSummary(impact).includes("stop selecting"));
  assert.equal(claimedDetail(CLAIMED[0]), "AIW-1, AIW-2 · run-a");
  assert.deepEqual(acknowledgedKeys(impact), ["github:acme/web"]);
});

test("a claim with neither ticket nor run still renders something readable", () => {
  assert.equal(
    claimedDetail({ key: "github:acme/x", displayName: "acme/x", ticketKeys: [], runIds: [] }),
    "no ticket · no run id",
  );
});

test("a refused activation says the list moved rather than repeating the same dialog", () => {
  assert.ok(staleActivationNotice(CLAIMED).includes("1 repository"));
  assert.ok(staleActivationNotice([...CLAIMED, CLAIMED[0]]).includes("2 repositories"));
});

test("the repositories the catalog never held stop passing too, and are counted", () => {
  // The population dispatch refuses after activation is "not an enabled catalog
  // row", which the installation's own repositories fail just as hard as a row
  // somebody unticked.
  const impact = activationImpact({
    repositories: [entry("acme/web", true)],
    claimed: [],
    directory: [option("acme/web"), option("acme/api"), option("acme/ops")],
  });

  assert.equal(impact.stopping.length, 0, "every catalog row is enabled");
  assert.deepEqual(
    impact.uncatalogued.map((repository) => repository.path),
    ["acme/api", "acme/ops"],
  );
  const summary = activationSummary(impact);
  assert.ok(summary.includes("2 repositories"), summary);
  assert.doesNotMatch(
    summary,
    /changes nothing/,
    "two repositories losing access is not nothing",
  );
  const named = uncataloguedSummary(impact);
  assert.match(named, /2 repositories the installation exposes are not in the catalog/);
  assert.match(named, /github:acme\/api, github:acme\/ops/);
});

test("a long uncatalogued list is capped rather than burying the confirm button", () => {
  const impact = activationImpact({
    repositories: [entry("acme/web", true)],
    claimed: [],
    directory: Array.from({ length: 14 }, (_, index) => option(`acme/r${index}`)),
  });
  const named = uncataloguedSummary(impact);
  assert.match(named, /and 4 more\.$/);
  assert.ok(named.includes("acme/r0"));
  assert.ok(!named.includes("acme/r10"), "the eleventh name is past the cap");
});

test("a directory that did not answer says so instead of reporting none", () => {
  const impact = activationImpact({
    repositories: [entry("acme/web", true)],
    claimed: [],
    directory: null,
  });
  assert.equal(impact.directoryUnknown, true);
  assert.match(uncataloguedSummary(impact), /could not be read/);
  assert.doesNotMatch(activationSummary(impact), /changes nothing/);
});

test("a catalog with nothing enabled refuses activation instead of offering it", () => {
  const impact = activationImpact({
    repositories: [entry("acme/web", false), entry("acme/api", false)],
    claimed: [],
    directory: [option("acme/web")],
  });
  const refusal = activationBlocker(impact);
  assert.ok(refusal, "activating an empty grant is never the right answer");
  assert.match(refusal, /no repository in this catalog is enabled/);
  assert.match(refusal, /enable at least one first/);
});

test("one enabled repository is enough for activation to be offered", () => {
  assert.equal(
    activationBlocker(
      activationImpact({
        repositories: [entry("acme/web", true), entry("acme/api", false)],
        claimed: [],
        directory: [],
      }),
    ),
    null,
  );
});
