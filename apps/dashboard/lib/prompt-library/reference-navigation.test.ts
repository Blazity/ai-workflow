import assert from "node:assert/strict";
import test from "node:test";
import {
  promptReferenceCapabilities,
  promptLibraryHref,
  resolvePreviewSelection,
} from "./reference-navigation";

const rows = [{ id: 7, currentVersion: 3 }];

test("latest selects the prompt current version", () => {
  assert.deepEqual(
    resolvePreviewSelection({ requestId: 1, promptId: 7, version: "latest" }, rows, [1, 2, 3]),
    { activeId: 7, selectedVersion: 3, missingVersion: false },
  );
});

test("pinned selection and missing versions remain explicit", () => {
  assert.deepEqual(
    resolvePreviewSelection({ requestId: 2, promptId: 7, version: 2 }, rows, [1, 2, 3]),
    { activeId: 7, selectedVersion: 2, missingVersion: false },
  );
  assert.deepEqual(
    resolvePreviewSelection({ requestId: 3, promptId: 7, version: 9 }, rows, [1, 2, 3]),
    { activeId: 7, selectedVersion: 9, missingVersion: true },
  );
});

test("missing prompt cannot navigate", () => {
  assert.equal(
    resolvePreviewSelection({ requestId: 4, promptId: 99, version: "latest" }, rows, [1, 2, 3]),
    null,
  );
});

test("read-only references keep navigation but hide mutation", () => {
  assert.deepEqual(promptReferenceCapabilities(true, true), {
    canExpand: true,
    canOpenLibrary: true,
    canMutate: false,
  });
  assert.deepEqual(promptReferenceCapabilities(true, false), {
    canExpand: true,
    canOpenLibrary: true,
    canMutate: true,
  });
  assert.deepEqual(promptReferenceCapabilities(false, false), {
    canExpand: false,
    canOpenLibrary: false,
    canMutate: false,
  });
});

test("builds the prompt library deep link from the slug", () => {
  assert.equal(promptLibraryHref("research-plan"), "/prompts?prompt=research-plan");
});
