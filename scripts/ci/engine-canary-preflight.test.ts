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
const OTHER_FINGERPRINT = "0f1e2d3c4b5a";

const health: HealthPayload = {
  status: "ok",
  commit: SHA,
  env: "preview",
  databaseEnv: "canary",
  databaseFingerprint: FINGERPRINT,
};

const expectations: EngineCanaryExpectations = {
  commit: SHA,
  databaseEnv: "canary",
  databaseFingerprint: FINGERPRINT,
  runnerDatabaseFingerprint: FINGERPRINT,
};

test("accepts only an exact candidate and isolated database identity", () => {
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

test("refuses a declared production environment when the observed one differs", () => {
  const result = evaluatePreflight(
    health,
    { ...expectations, databaseEnv: "production" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /database.*production/iu);
});

test("refuses an observed environment different from the declared one", () => {
  const result = evaluatePreflight(
    { ...health, databaseEnv: "staging" },
    expectations,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /environment.*does not match/iu);
});

test("refuses a runner fingerprint different from matching health and declaration", () => {
  const result = evaluatePreflight(health, {
    ...expectations,
    runnerDatabaseFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /runner.*declared/iu);
});

test("refuses a declaration different from matching health and runner fingerprints", () => {
  const result = evaluatePreflight(health, {
    ...expectations,
    databaseFingerprint: OTHER_FINGERPRINT,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /runner.*declared/iu);
});

test("refuses a deployment database fingerprint mismatch", () => {
  const result = evaluatePreflight(
    { ...health, databaseFingerprint: "000000000000" },
    expectations,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /database/u);
});

test("refuses the observed production-shaped health with a database reason", () => {
  const result = evaluatePreflight(
    {
      commit: null,
      env: "preview",
      databaseEnv: "production",
      databaseFingerprint: "d1995828824d",
    },
    expectations,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /database.*production/iu);
});
