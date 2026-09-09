import assert from "node:assert/strict";
import test from "node:test";
import {
  checkDeploymentIdentity,
  parseArgs,
  type HealthPayload,
} from "./verify-deployment-identity.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

const healthy: HealthPayload = {
  status: "ok",
  commit: SHA,
  env: "production",
  databaseEnv: "production",
};

const expected = { commit: SHA, env: "production" };

test("agrees only when every fact matches", () => {
  assert.deepEqual(checkDeploymentIdentity(healthy, expected), []);
});

test("refuses a deployment serving a different commit, and names both", () => {
  const problems = checkDeploymentIdentity({ ...healthy, commit: OTHER }, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, new RegExp(`serves commit ${OTHER}`));
  assert.match(problems[0]!, new RegExp(`candidate is ${SHA}`));
});

test("refuses when the deployment names no commit at all", () => {
  // The dangerous shape: a health check that answers 200 and proves nothing.
  // Treating a missing field as a match would make the gate decorative.
  const problems = checkDeploymentIdentity({ ...healthy, commit: undefined }, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /did not report a commit/);
});

test("refuses a preview pointed at the production database", () => {
  const problems = checkDeploymentIdentity(
    { status: "ok", commit: SHA, env: "preview", databaseEnv: "production" },
    { commit: SHA, env: "preview" },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /claimed by 'production'/);
});

test("refuses when the database env could not be read", () => {
  const problems = checkDeploymentIdentity({ ...healthy, databaseEnv: null }, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /belong together/);
});

test("refuses an abbreviated candidate sha, which cannot identify a commit", () => {
  const problems = checkDeploymentIdentity(healthy, { commit: "a1b2c3d", env: "production" });
  assert.ok(problems.some((problem) => /not a 40-character sha/.test(problem)));
});

test("reports every mismatch at once, not the first one", () => {
  const problems = checkDeploymentIdentity(
    { status: "degraded", commit: OTHER, env: "preview", databaseEnv: undefined },
    expected,
  );
  assert.equal(problems.length, 4);
});

test("refuses a health body that is not ok", () => {
  const problems = checkDeploymentIdentity({ ...healthy, status: "degraded" }, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /status 'degraded'/);
});

test("parses flag pairs and ignores a flag with no value", () => {
  assert.deepEqual(parseArgs(["--url", "https://x", "--commit", SHA, "--env"]), {
    url: "https://x",
    commit: SHA,
  });
});

test("refuses a deployment reading a different database branch than the caller", () => {
  // The case check-db.ts says it cannot see: both databases are migrated, and
  // they are not the same branch.
  const problems = checkDeploymentIdentity(
    { ...healthy, databaseFingerprint: "aaaaaaaaaaaa" },
    { ...expected, databaseFingerprint: "bbbbbbbbbbbb" },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /different database branch/);
});

test("refuses when the branch was to be checked and health reported none", () => {
  const problems = checkDeploymentIdentity(healthy, {
    ...expected,
    databaseFingerprint: "aaaaaaaaaaaa",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /did not report a database fingerprint/);
});

test("makes no branch claim when the caller holds no connection string", () => {
  // Silence about an unmade check, never a pass implied for it.
  assert.deepEqual(checkDeploymentIdentity(healthy, expected), []);
});

test("accepts a matching branch", () => {
  assert.deepEqual(
    checkDeploymentIdentity(
      { ...healthy, databaseFingerprint: "aaaaaaaaaaaa" },
      { ...expected, databaseFingerprint: "aaaaaaaaaaaa" },
    ),
    [],
  );
});

test("makes no environment claim when the caller does not name one", () => {
  // The e2e job knows the branch it connects to, not what the deployment under
  // test calls its environment. Guessing would fail for a reason nobody can act
  // on, and the branch fingerprint already proves more than the name.
  assert.deepEqual(
    checkDeploymentIdentity(
      { status: "ok", commit: SHA, env: "whatever", databaseEnv: "whatever", databaseFingerprint: "aaaaaaaaaaaa" },
      { commit: SHA, databaseFingerprint: "aaaaaaaaaaaa" },
    ),
    [],
  );
});

test("still refuses a wrong commit when no environment is named", () => {
  const problems = checkDeploymentIdentity(
    { status: "ok", commit: OTHER, databaseFingerprint: "aaaaaaaaaaaa" },
    { commit: SHA, databaseFingerprint: "aaaaaaaaaaaa" },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /serves commit/);
});

test("checks the database branch alone when no candidate is named", () => {
  // The nightly's shape: nothing to confirm a commit against, but the tests
  // and the deployment still have to be reading the same branch.
  assert.deepEqual(
    checkDeploymentIdentity(
      { status: "ok", commit: OTHER, databaseFingerprint: "aaaaaaaaaaaa" },
      { databaseFingerprint: "aaaaaaaaaaaa" },
    ),
    [],
  );
});

test("still refuses a wrong branch when no candidate is named", () => {
  const problems = checkDeploymentIdentity(
    { status: "ok", commit: OTHER, databaseFingerprint: "bbbbbbbbbbbb" },
    { databaseFingerprint: "aaaaaaaaaaaa" },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /different database branch/);
});

test("still refuses a health body that is not ok when nothing else is named", () => {
  const problems = checkDeploymentIdentity(
    { status: "degraded", databaseFingerprint: "aaaaaaaaaaaa" },
    { databaseFingerprint: "aaaaaaaaaaaa" },
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /status 'degraded'/);
});
