import assert from "node:assert/strict";
import test from "node:test";

import { cockpitNavItems, isMobileMoreNavItem } from "./chrome";

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

test("Integrations is reachable by every role and on a phone", () => {
  // Reading which integrations are connected carries no secret and is how a
  // member tells a deployment that is quiet from one that is broken. The phone
  // half matters because the bottom tab bar carries three screens: anything not
  // in the More sheet cannot be reached from a phone at all.
  for (const canManageUsers of [false, true]) {
    const ids = new Set(cockpitNavItems({ canManageUsers }).map((item) => item.id));
    assert.ok(ids.has("integrations"), `Integrations was missing for canManageUsers=${canManageUsers}`);
  }
  assert.ok(isMobileMoreNavItem("integrations"));
});

test("Settings is the last nav entry and is open to every role", () => {
  // Reading what the deployment is configured to do is open to every role: a
  // member who cannot change a limit still has to know which one is in force.
  for (const canManageUsers of [false, true]) {
    const items = cockpitNavItems({ canManageUsers });
    assert.equal(
      items.at(-1)?.id,
      "settings",
      `Settings was not last for canManageUsers=${canManageUsers}`,
    );
    assert.equal(items.at(-1)?.label, "Settings");
  }
});
