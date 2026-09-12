import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryCatalogImportCandidate } from "@shared/contracts";

import {
  ALREADY_IN_CATALOG_NOTE,
  importDetails,
  importSummary,
  isProviderUnavailable,
  problemProviders,
  providerStatusLabel,
  selectableCandidates,
} from "./import";

function candidate(
  overrides: Partial<RepositoryCatalogImportCandidate>,
): RepositoryCatalogImportCandidate {
  return {
    key: "github:acme/web",
    provider: "github",
    path: "acme/web",
    name: "web",
    owner: "acme",
    defaultBranch: "main",
    private: false,
    archived: false,
    inCatalog: false,
    ...overrides,
  };
}

test("a repository the catalog already holds cannot be ticked, and says why", () => {
  const candidates = [
    candidate({}),
    candidate({ key: "github:acme/api", path: "acme/api", inCatalog: true }),
    candidate({ key: "github:acme/old", path: "acme/old", archived: true }),
  ];

  assert.deepEqual(
    selectableCandidates(candidates).map((row) => row.key),
    ["github:acme/web"],
  );
  assert.ok(ALREADY_IN_CATALOG_NOTE.includes("does not enable it"));
  assert.ok(ALREADY_IN_CATALOG_NOTE.includes("use the switch"));
});

test("the summary names all three buckets every time, zeroes included", () => {
  const summary = importSummary({
    imported: 2,
    skipped: [],
    alreadyPresent: [],
    repositories: [],
  });
  assert.equal(
    summary,
    "2 repositories added, 0 already in the catalog, 0 no longer exposed by the provider",
  );
  assert.ok(
    importSummary({ imported: 1, skipped: [], alreadyPresent: [], repositories: [] }).startsWith(
      "1 repository added",
    ),
  );
});

test("the two non-created buckets stay separate, because an admin acts on them differently", () => {
  const details = importDetails({
    imported: 1,
    skipped: ["github:acme/gone"],
    alreadyPresent: ["github:acme/api"],
    repositories: [],
  });

  assert.equal(details.length, 2);
  assert.deepEqual(details[0].keys, ["github:acme/api"]);
  assert.ok(details[0].label.includes("nothing was enabled"));
  assert.deepEqual(details[1].keys, ["github:acme/gone"]);
  assert.ok(details[1].label.includes("Reload"));
  assert.deepEqual(
    importDetails({ imported: 1, skipped: [], alreadyPresent: [], repositories: [] }),
    [],
  );
});

test("a provider that could not be listed is named rather than shown as an empty list", () => {
  const providers = [
    { provider: "github" as const, status: "ready" as const },
    { provider: "gitlab" as const, status: "error" as const, error: "401 Unauthorized" },
  ];
  assert.deepEqual(
    problemProviders(providers).map((entry) => entry.provider),
    ["gitlab"],
  );
  assert.equal(providerStatusLabel(providers[1]), "401 Unauthorized");
  assert.equal(
    providerStatusLabel({ provider: "gitlab", status: "not_connected" }),
    "not connected",
  );
  assert.equal(providerStatusLabel({ provider: "gitlab", status: "error" }), "could not list repositories");
});

test("a 503 provider_unavailable is the one failure that means nothing was inserted", () => {
  assert.equal(
    isProviderUnavailable({ status: 503, message: "provider_unavailable" }),
    true,
  );
  assert.equal(isProviderUnavailable({ status: 500, message: "provider_unavailable" }), false);
  assert.equal(isProviderUnavailable({ status: 503, message: "Service Unavailable" }), false);
});
