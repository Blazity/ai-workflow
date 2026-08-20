import assert from "node:assert/strict";
import test from "node:test";

import { cockpitNavItems } from "./chrome";

test("Harness Profiles is always discoverable while administration remains role-gated", () => {
  const memberIds = cockpitNavItems({ canManageUsers: false }).map(
    (item) => item.id,
  );
  assert.ok(memberIds.includes("profiles"));
  assert.ok(!memberIds.includes("health"));
  assert.ok(!memberIds.includes("users"));

  const adminIds = cockpitNavItems({ canManageUsers: true }).map(
    (item) => item.id,
  );
  assert.ok(adminIds.includes("profiles"));
  assert.ok(adminIds.includes("health"));
  assert.ok(adminIds.includes("users"));
});
