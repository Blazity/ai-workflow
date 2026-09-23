import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, nextVersion, parseVersion, previousVersion } from "./version.ts";

test("the first release of a month is .1, whatever earlier months used", () => {
  assert.equal(nextVersion("2026-10-01", []), "v2026.10.1");
  assert.equal(nextVersion("2026-10-01", ["v2026.09.1", "v2026.09.7"]), "v2026.10.1");
  assert.equal(nextVersion("2027-01-02", ["v2026.12.4"]), "v2027.01.1");
});

test("several releases in one month count up, compared as numbers not strings", () => {
  assert.equal(nextVersion("2026-09-23", ["v2026.09.1"]), "v2026.09.2");
  assert.equal(nextVersion("2026-09-23", ["v2026.09.2", "v2026.09.1", "v2026.09.3"]), "v2026.09.4");
  assert.equal(nextVersion("2026-09-23", ["v2026.09.9", "v2026.09.10"]), "v2026.09.11");
});

test("a version already taken, by a tag or by a heading nobody tagged yet, is never handed out again", () => {
  // A collation wrote v2026.09.2 into CHANGELOG.md, the release job has not tagged it yet.
  assert.equal(nextVersion("2026-09-24", ["v2026.09.1", "v2026.09.2"]), "v2026.09.3");
  // The same name arriving from both sources counts once.
  assert.equal(nextVersion("2026-09-24", ["v2026.09.1", "v2026.09.1"]), "v2026.09.2");
});

test("names that are not versions are ignored", () => {
  assert.equal(nextVersion("2026-09-23", ["pre-main-merge-backup", "v1.4.209", "v2026.9.3", "v2026.09.0"]), "v2026.09.1");
});

test("a date that is not YYYY-MM-DD is refused rather than turned into a strange version", () => {
  assert.throws(() => nextVersion("23.09.2026", []), /not a YYYY-MM-DD date/u);
});

test("the previous version is the newest older one, across months", () => {
  const taken = ["v2026.09.2", "v2026.10.1", "v2026.09.10", "pre-main-merge-backup"];
  assert.equal(previousVersion("v2026.10.2", taken), "v2026.10.1");
  assert.equal(previousVersion("v2026.10.1", taken), "v2026.09.10");
  assert.equal(previousVersion("v2026.09.2", taken), undefined);
  assert.ok(compareVersions("v2026.09.10", "v2026.09.9") > 0);
  assert.deepEqual(parseVersion("v2026.09.12"), { month: 9, n: 12, year: 2026 });
});
