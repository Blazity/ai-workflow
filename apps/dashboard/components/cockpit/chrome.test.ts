import assert from "node:assert/strict";
import test from "node:test";

import { cockpitNavItems } from "./chrome";

test("Harness Profiles is always discoverable while administration remains role-gated", () => {
  const memberIds = new Set(cockpitNavItems({ canManageUsers: false }).map(
    (item) => item.id,
  ));
  assert.ok(memberIds.has("profiles"));
  assert.ok(!memberIds.has("health"));
  assert.ok(!memberIds.has("users"));

  const adminIds = new Set(cockpitNavItems({ canManageUsers: true }).map(
    (item) => item.id,
  ));
  assert.ok(adminIds.has("profiles"));
  assert.ok(adminIds.has("health"));
  assert.ok(adminIds.has("users"));
});
