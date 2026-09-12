import assert from "node:assert/strict";
import test from "node:test";

import type { RepositoryCatalogEntry, RepositoryProfileVersion } from "@shared/contracts";

import {
  durationLabel,
  firstLine,
  lastChangeLabel,
  repositoryLabel,
  scriptGroupCountLabel,
  sortRepositories,
  sourceLabel,
  suggestionUsageLabel,
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
    batchTimeoutMinutes: null,
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

test("a suggestion row that reported no usage is unpriced, never free", () => {
  const row = {
    id: 1,
    createdAt: "2026-09-11T08:30:00.000Z",
    outcome: "timeout" as const,
    model: "claude-sonnet",
    actorLabel: "Ada",
    tokensInput: null,
    tokensOutput: null,
    durationMs: null,
    priced: false,
  };
  assert.equal(suggestionUsageLabel(row), "unpriced");
  assert.equal(
    suggestionUsageLabel({
      ...row,
      outcome: "proposed",
      tokensInput: 100,
      tokensOutput: 20,
      priced: true,
    }),
    "120 tokens (100 in, 20 out)",
  );
  // `priced` is the field that decides, not the numbers: a provider that
  // genuinely reported zero is a different fact from one that reported nothing.
  assert.equal(
    suggestionUsageLabel({ ...row, tokensInput: 0, tokensOutput: 0, priced: true }),
    "0 tokens (0 in, 0 out)",
  );
});

test("a duration nobody recorded says so instead of showing zero", () => {
  assert.equal(durationLabel(null), "duration not recorded");
  assert.equal(durationLabel(0), "0 ms");
  assert.equal(durationLabel(900), "900 ms");
  assert.equal(durationLabel(1500), "1.5 s");
  assert.equal(durationLabel(62_000), "62 s");
});

test("an uncomputed script group count is not a count of zero", () => {
  assert.equal(scriptGroupCountLabel(undefined), null);
  assert.equal(scriptGroupCountLabel(0), "0 script groups");
  assert.equal(scriptGroupCountLabel(1), "1 script group");
  assert.equal(scriptGroupCountLabel(4), "4 script groups");
});
