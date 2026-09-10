import assert from "node:assert/strict";
import test from "node:test";
import type {
  PromptLibraryListRowDto,
  PromptSlotDefinition,
} from "@shared/contracts";
import {
  includePendingPromptSlotBindings,
  promptLibraryVersionKey,
  promptVersionLoadRequests,
  resolvePromptSlotsFromLibrary,
  renamePromptSlotTokens,
  samePromptSlots,
  type PromptLibrarySlotRow,
} from "./slots";

const stringSlot = (
  name: string,
  description = name,
): PromptSlotDefinition => ({
  name,
  description,
  schema: { type: "string" },
  required: true,
});

function row(
  id: number,
  slug: string,
  body: string,
  slots: PromptSlotDefinition[],
): PromptLibrarySlotRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    tags: [],
    currentVersion: 1,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdByLabel: "Test",
    body,
    slots,
  } satisfies PromptLibraryListRowDto & { slots: PromptSlotDefinition[] };
}

test("slot discovery unions nested prompt declarations and coalesces identical slots", () => {
  const rows = [
    row(
      1,
      "outer",
      "Before {{prompt:inner@1}}",
      [stringSlot("plan"), stringSlot("context")],
    ),
    row(2, "inner", "Inner {{slot:plan}}", [stringSlot("plan")]),
  ];

  const resolved = resolvePromptSlotsFromLibrary(
    "{{prompt:outer@1}}",
    rows,
  );

  assert.deepEqual(
    resolved.definitions.map((slot) => slot.name),
    ["context", "plan"],
  );
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.unresolvedReferences, []);
});

test("slot discovery surfaces conflicting nested declarations", () => {
  const rows = [
    row(1, "outer", "{{prompt:inner@1}}", [stringSlot("plan")]),
    row(2, "inner", "", [{
      ...stringSlot("plan"),
      schema: { type: "number" },
    }]),
  ];

  const resolved = resolvePromptSlotsFromLibrary(
    "{{prompt:outer@1}}",
    rows,
  );
  assert.deepEqual(resolved.conflicts, ["plan"]);
});

test("slot discovery never substitutes a different prompt version", () => {
  const rows = [row(1, "outer", "", [stringSlot("plan")])];
  const resolved = resolvePromptSlotsFromLibrary(
    "{{prompt:outer@2}}",
    rows,
  );

  assert.deepEqual(resolved.definitions, []);
  assert.deepEqual(resolved.unresolvedReferences, ["{{prompt:outer@2}}"]);
});

test("slot discovery recursively uses exact pinned version bodies and declarations", () => {
  const rows = [
    {
      ...row(1, "outer", "Current", [stringSlot("current")]),
      currentVersion: 3,
    },
    {
      ...row(2, "inner", "Current inner", [stringSlot("current_inner")]),
      currentVersion: 4,
    },
  ];
  const versions = {
    [promptLibraryVersionKey(1, 1)]: {
      promptId: 1,
      version: 1,
      body: "Historical {{prompt:inner@2}}",
      slots: [stringSlot("outer_old")],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdById: "test",
      createdByLabel: "Test",
      restoredFromVersion: null,
    },
    [promptLibraryVersionKey(2, 2)]: {
      promptId: 2,
      version: 2,
      body: "{{slot:inner_old}}",
      slots: [stringSlot("inner_old")],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdById: "test",
      createdByLabel: "Test",
      restoredFromVersion: null,
    },
  };

  const resolved = resolvePromptSlotsFromLibrary(
    "{{prompt:outer@1}}",
    rows,
    versions,
  );

  assert.deepEqual(
    resolved.definitions.map((slot) => slot.name),
    ["inner_old", "outer_old"],
  );
  assert.deepEqual(resolved.unresolvedReferences, []);
});

test("exact-version loading requests advance one recursive level at a time", () => {
  const rows = [
    {
      ...row(1, "outer", "Current", []),
      currentVersion: 3,
    },
    {
      ...row(2, "inner", "Current", []),
      currentVersion: 4,
    },
  ];
  const initial = resolvePromptSlotsFromLibrary(
    "{{prompt:outer@1}}",
    rows,
  );
  assert.deepEqual(
    promptVersionLoadRequests(initial.unresolvedReferences, rows, {}),
    [{
      reference: "{{prompt:outer@1}}",
      promptId: 1,
      version: 1,
      key: "1@1",
    }],
  );

  const versions = {
    "1@1": {
      promptId: 1,
      version: 1,
      body: "{{prompt:inner@2}}",
      slots: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      createdById: "test",
      createdByLabel: "Test",
      restoredFromVersion: null,
    },
  };
  const nested = resolvePromptSlotsFromLibrary(
    "{{prompt:outer@1}}",
    rows,
    versions,
  );
  assert.deepEqual(
    promptVersionLoadRequests(nested.unresolvedReferences, rows, versions),
    [{
      reference: "{{prompt:inner@2}}",
      promptId: 2,
      version: 2,
      key: "2@2",
    }],
  );
});

test("saved slot bindings remain visible while pinned metadata is unresolved", () => {
  const visible = includePendingPromptSlotBindings(
    [stringSlot("known")],
    {
      known: { kind: "literal", value: "ready" },
      historical: {
        kind: "reference",
        reference: "steps.planning.output.plan",
      },
    },
    true,
  );
  assert.deepEqual(
    visible.map((definition) => definition.name),
    ["known", "historical"],
  );
  assert.match(visible[1]?.description ?? "", /Loading slot metadata/);
});

test("slot equality includes defaults and schemas", () => {
  const base = [stringSlot("plan")];
  assert.equal(samePromptSlots(base, structuredClone(base)), true);
  assert.equal(
    samePromptSlots(base, [{ ...base[0], defaultValue: "fallback" }]),
    false,
  );
});

test("renaming a slot updates only matching canonical tokens", () => {
  assert.equal(
    renamePromptSlotTokens(
      "{{slot:plan}} {{slot:planner}} `{{slot:plan}}`",
      "plan",
      "approved_plan",
    ),
    "{{slot:approved_plan}} {{slot:planner}} `{{slot:plan}}`",
  );
});
