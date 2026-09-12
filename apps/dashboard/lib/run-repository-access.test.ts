import assert from "node:assert/strict";
import test from "node:test";

import { repositoryAccessLine } from "./run-repository-access";

test("a run from before the list was recorded says nothing rather than nothing reachable", () => {
  assert.equal(repositoryAccessLine(undefined), null);
  assert.equal(repositoryAccessLine(null), null);
});

test("the bridge is named as the bridge, not as an empty list", () => {
  const line = repositoryAccessLine({ activated: false, enabledKeys: [] });
  assert.match(line ?? "", /bridge/);
  assert.match(line ?? "", /every repository the installation exposes/);
  assert.doesNotMatch(line ?? "", /0 enabled/);
});

test("an activated catalog with no enabled row is not the bridge", () => {
  // Same stored shape as the bridge but for one flag, and the opposite meaning:
  // the catalog decides and it lets nothing through.
  const line = repositoryAccessLine({ activated: true, enabledKeys: [] });
  assert.match(line ?? "", /0 enabled/);
  assert.doesNotMatch(line ?? "", /bridge/);
});

test("the keys are listed as frozen, and a long list says how many are not shown", () => {
  assert.equal(
    repositoryAccessLine({
      activated: true,
      enabledKeys: ["github:acme/api", "github:acme/web"],
    }),
    "Repository access frozen at start: 2 enabled (github:acme/api, github:acme/web).",
  );

  const many = Array.from({ length: 9 }, (_, i) => `github:acme/r${i}`);
  const line = repositoryAccessLine({ activated: true, enabledKeys: many });
  assert.equal(
    line,
    "Repository access frozen at start: 9 enabled (github:acme/r0, github:acme/r1, " +
      "github:acme/r2, github:acme/r3, github:acme/r4, and 4 more).",
  );
  assert.doesNotMatch(line ?? "", /r5/);
});
