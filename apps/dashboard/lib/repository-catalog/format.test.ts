import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryCatalogEntry, RepositoryProfileVersion } from "@shared/contracts";

import {
  firstLine,
  lastChangeLabel,
  repositoryLabel,
  sortRepositories,
  sourceLabel,
  usageLabel,
} from "./format";

function entry(overrides: Partial<RepositoryCatalogEntry>): RepositoryCatalogEntry {
  return {
    id: 1,
    provider: "github",
    path: "acme/web",
    displayName: "acme/web",
    defaultBranch: "main",
    description: "",
    rules: "",
    relationships: [],
    enabled: false,
    source: "manual",
    profileVersion: 0,
    checksVersion: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("the list cell takes the first real line and drops a markdown title marker", () => {
  assert.equal(firstLine("\n\n# The storefront\n\nRuns the shop."), "The storefront");
  assert.equal(firstLine("Plain description\nsecond line"), "Plain description");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine("x".repeat(200), 20).length, 20);
  assert.ok(firstLine("x".repeat(200), 20).endsWith("…"));
});

test("last change reads the profile version, so flipping a switch is not reported as an edit", () => {
  const profile: RepositoryProfileVersion = {
    version: 4,
    description: "",
    rules: "",
    relationships: [],
    scriptGroups: null,
    gateGroups: null,
    checksVersion: 2,
    actorId: "u1",
    actorLabel: "Filip",
    reason: "tightened the gate",
    createdAt: "2026-09-10T10:00:00.000Z",
  };
  const label = lastChangeLabel(profile);
  assert.ok(label.startsWith("v4 · Filip · "), label);
  assert.equal(lastChangeLabel(null), "never configured");
});

test("a suggestion with no tokens is unpriced, never zero", () => {
  assert.equal(usageLabel(null), "unpriced");
  assert.equal(
    usageLabel({ inputTokens: 1200, cachedTokens: 0, outputTokens: 300 }),
    "1500 tokens (1200 in, 300 out)",
  );
  assert.ok(
    usageLabel({ inputTokens: 10, cachedTokens: 5, outputTokens: 1 }).includes("5 cached"),
  );
});

test("the source badge names the provenance the row carries", () => {
  assert.equal(sourceLabel("imported"), "imported");
  assert.equal(sourceLabel("seeded"), "seeded");
  assert.equal(sourceLabel("migrated"), "migrated");
  assert.equal(sourceLabel("manual"), "manual");
});

test("a display name that only repeats the path is not printed twice", () => {
  assert.equal(repositoryLabel({ displayName: "acme/web", path: "acme/web" }), "acme/web");
  assert.equal(
    repositoryLabel({ displayName: "Storefront", path: "acme/web" }),
    "Storefront (acme/web)",
  );
});

test("the list order does not follow the enabled switch, so a row never moves under the click", () => {
  const rows = [
    entry({ id: 2, path: "acme/web", enabled: false }),
    entry({ id: 1, path: "acme/api", enabled: true }),
    entry({ id: 3, provider: "gitlab", path: "acme/ops", enabled: true }),
  ];
  assert.deepEqual(
    sortRepositories(rows).map((row) => `${row.provider}:${row.path}`),
    ["github:acme/api", "github:acme/web", "gitlab:acme/ops"],
  );
  const flipped = sortRepositories(
    rows.map((row) => ({ ...row, enabled: !row.enabled })),
  ).map((row) => row.id);
  assert.deepEqual(flipped, sortRepositories(rows).map((row) => row.id));
});
