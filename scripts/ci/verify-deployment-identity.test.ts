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
