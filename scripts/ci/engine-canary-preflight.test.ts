import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePreflight,
  type EngineCanaryExpectations,
} from "./engine-canary-preflight.ts";
import type { HealthPayload } from "./verify-deployment-identity.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const FINGERPRINT = "a1b2c3d4e5f6";

const health: HealthPayload = {
  status: "ok",
  commit: SHA,
  env: "preview",
  databaseEnv: "production",
  databaseFingerprint: FINGERPRINT,
};

const expectations: EngineCanaryExpectations = {
  target: "ai-workflow-demo",
  commit: SHA,
  databaseEnv: "production",
  databaseFingerprint: FINGERPRINT,
};

test("accepts an exact candidate on the declared production database, no connection string needed", () => {
  assert.deepEqual(evaluatePreflight(health, expectations), { ok: true });
});

test("requires the exact candidate commit", () => {
  const result = evaluatePreflight(health, {
    ...expectations,
    commit: OTHER_SHA,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /commit/u);
});

test("refuses the production Vercel target", () => {
  const result = evaluatePreflight(health, {
    ...expectations,
    target: "production",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /target.*production/iu);
});

test("refuses an observed environment different from the declared one", () => {
  const result = evaluatePreflight(
    { ...health, databaseEnv: "staging" },
    expectations,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /environment.*does not match/iu);
});

test("refuses a declared database fingerprint that is not 12 lowercase hex characters", () => {
  const result = evaluatePreflight(health, {
    ...expectations,
    databaseFingerprint: "not-a-fingerprint",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /fingerprint.*12 lowercase hex/iu);
  }
});

test("refuses a deployment database fingerprint mismatch", () => {
  const result = evaluatePreflight(
    { ...health, databaseFingerprint: "000000000000" },
    expectations,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /database/u);
});

test("accepts production only when its database identity matches the declaration", () => {
  const result = evaluatePreflight(
    {
      status: "ok",
      commit: SHA,
      env: "preview",
      databaseEnv: "production",
      databaseFingerprint: FINGERPRINT,
    },
    expectations,
  );
  assert.deepEqual(result, { ok: true });
});
