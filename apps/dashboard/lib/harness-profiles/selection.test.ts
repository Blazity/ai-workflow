import assert from "node:assert/strict";
import test from "node:test";

import type { HarnessProfileDto } from "@shared/contracts";
import {
  profileSelectionHref,
  resolveProfileSelection,
} from "./selection";

function profile(
  id: string,
  archivedAt: string | null = null,
): HarnessProfileDto {
  return {
    id,
    archivedAt,
  } as HarnessProfileDto;
}

test("resolveProfileSelection honors a valid profile from the URL", () => {
  assert.equal(
    resolveProfileSelection(
      [profile("active"), profile("archived", "2026-07-24")],
      "archived",
    ),
    "archived",
  );
});

test("resolveProfileSelection falls back to the first active profile", () => {
  assert.equal(
    resolveProfileSelection(
      [profile("archived", "2026-07-24"), profile("active")],
      "missing",
    ),
    "active",
  );
});

test("profileSelectionHref preserves unrelated query parameters", () => {
  assert.equal(
    profileSelectionHref("/profiles", "view=compact&profile=old", "new/id"),
    "/profiles?view=compact&profile=new%2Fid",
  );
});

test("profileSelectionHref removes the parameter when no profile exists", () => {
  assert.equal(
    profileSelectionHref("/profiles", "profile=old&view=compact", null),
    "/profiles?view=compact",
  );
});
