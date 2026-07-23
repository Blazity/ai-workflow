import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromptLibraryListRowDto, PromptSourceRef } from "@shared/contracts";
import { fnv1a } from "./hash.ts";
import { driftFor, getPromptRef, makePromptRef } from "./provenance.ts";

function row(overrides: Partial<PromptLibraryListRowDto> = {}): PromptLibraryListRowDto {
  return {
    id: 1,
    slug: "review-prompt",
    name: "Review prompt",
    description: null,
    tags: [],
    currentVersion: 3,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    createdByLabel: "tester",
    body: "body",
    slots: [],
    ...overrides,
  };
}

test("getPromptRef returns the ref stored under a param key", () => {
  const ref: PromptSourceRef = { promptId: 1, version: 3 };
  assert.equal(getPromptRef({ promptRefs: { prompt: ref } }, "prompt"), ref);
});

test("getPromptRef returns null for a missing key or absent refs", () => {
  assert.equal(getPromptRef({ promptRefs: { prompt: { promptId: 1, version: 1 } } }, "system"), null);
  assert.equal(getPromptRef({}, "prompt"), null);
});

test("makePromptRef fingerprints the inserted text", () => {
  const ref = makePromptRef(7, 2, "inserted body");
  assert.deepEqual(ref, { promptId: 7, version: 2, insertedHash: fnv1a("inserted body") });
});

test("drift is missing when no row matches the promptId", () => {
  const ref: PromptSourceRef = { promptId: 99, version: 1 };
  assert.deepEqual(driftFor(ref, "text", [row()]), { kind: "missing" });
});

test("drift is archived when the row is archived", () => {
  const r = row({ archivedAt: "2026-02-01T00:00:00Z" });
  const ref: PromptSourceRef = { promptId: 1, version: 3 };
  assert.deepEqual(driftFor(ref, "text", [r]), { kind: "archived", row: r });
});

test("drift is behind when the head version is newer", () => {
  const r = row({ currentVersion: 5 });
  const ref: PromptSourceRef = { promptId: 1, version: 3 };
  assert.deepEqual(driftFor(ref, "text", [r]), { kind: "behind", row: r, latest: 5 });
});

test("drift is edited when the current text no longer matches the hash", () => {
  const r = row({ currentVersion: 3 });
  const ref: PromptSourceRef = { promptId: 1, version: 3, insertedHash: fnv1a("original") };
  assert.deepEqual(driftFor(ref, "edited now", [r]), { kind: "edited", row: r });
});

test("drift is current when the hash still matches", () => {
  const r = row({ currentVersion: 3 });
  const ref: PromptSourceRef = { promptId: 1, version: 3, insertedHash: fnv1a("same text") };
  assert.deepEqual(driftFor(ref, "same text", [r]), { kind: "current", row: r });
});

test("drift is current when there is no hash to compare", () => {
  const r = row({ currentVersion: 3 });
  const ref: PromptSourceRef = { promptId: 1, version: 3 };
  assert.deepEqual(driftFor(ref, "anything", [r]), { kind: "current", row: r });
});

test("archived beats behind", () => {
  const r = row({ archivedAt: "2026-02-01T00:00:00Z", currentVersion: 9 });
  const ref: PromptSourceRef = { promptId: 1, version: 3 };
  assert.deepEqual(driftFor(ref, "text", [r]), { kind: "archived", row: r });
});

test("behind beats edited", () => {
  const r = row({ currentVersion: 9 });
  const ref: PromptSourceRef = { promptId: 1, version: 3, insertedHash: fnv1a("original") };
  assert.deepEqual(driftFor(ref, "edited now", [r]), { kind: "behind", row: r, latest: 9 });
});
