import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "../../db/client.js";
import { databaseFingerprint } from "../../db/database-fingerprint.js";
import { deploymentIdentity, resetDeploymentIdentityCache } from "./deployment-identity.js";
import { logger } from "../../infra/logger.js";

const mockEnv: { VERCEL_GIT_COMMIT_SHA?: string; VERCEL_ENV?: string } = {};

vi.mock("../../infra/vcs-config.js", () => ({
  get env() {
    return mockEnv;
  },
}));
vi.mock("../../infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const HOST = "ep-cool-name-123456.eu-central-1.aws.neon.tech";

/** A db whose marker read resolves to `rows`, or rejects when given an error. */
function markerDb(result: Array<{ env: string; endpointHost: string }> | Error): {
  db: () => Db;
  reads: () => number;
} {
  let reads = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            reads += 1;
            return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
          },
        }),
      }),
    }),
  };
  return { db: () => db as unknown as Db, reads: () => reads };
}

describe("deploymentIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDeploymentIdentityCache();
    delete mockEnv.VERCEL_GIT_COMMIT_SHA;
    delete mockEnv.VERCEL_ENV;
  });

  it("reports the commit, the environment and the database's own claim", async () => {
    mockEnv.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    mockEnv.VERCEL_ENV = "production";
    const { db } = markerDb([{ env: "production", endpointHost: HOST }]);

    expect(await deploymentIdentity(db)).toEqual({
      commit: "a".repeat(40),
      env: "production",
      databaseEnv: "production",
      databaseFingerprint: databaseFingerprint(HOST),
    });
  });

  it("says null rather than guessing when the platform names no commit", async () => {
    mockEnv.VERCEL_ENV = "preview";
    const { db } = markerDb([{ env: "preview", endpointHost: HOST }]);

    // A verifier reads this as unproven and refuses; inventing a value here
    // would turn "we cannot tell" into a passing gate.
    expect(await deploymentIdentity(db)).toMatchObject({ commit: null, env: "preview" });
  });

  it("surfaces a database claimed by another environment instead of hiding it", async () => {
    mockEnv.VERCEL_ENV = "preview";
    const { db } = markerDb([{ env: "production", endpointHost: HOST }]);

    // Preview pointed at the production branch is the failure the env marker
    // exists for. Health must report it, not normalise it away.
    expect(await deploymentIdentity(db)).toMatchObject({
      env: "preview",
      databaseEnv: "production",
    });
  });

  it("reads the marker once per process, because a build cannot change it", async () => {
    const { db, reads } = markerDb([{ env: "production", endpointHost: HOST }]);

    await deploymentIdentity(db);
    await deploymentIdentity(db);
    await deploymentIdentity(db);

    expect(reads()).toBe(1);
  });

  it("degrades to null on an unreadable database instead of failing health", async () => {
    const { db } = markerDb(new Error("connection refused"));

    const identity = await deploymentIdentity(db);

    expect(identity.databaseEnv).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "connection refused" }),
      "deployment_identity_database_env_unreadable",
    );
  });

  it("retries after a failed read, so one blip does not pin the deployment to unknown", async () => {
    const failing = markerDb(new Error("connection refused"));
    expect((await deploymentIdentity(failing.db)).databaseEnv).toBeNull();

    const healthy = markerDb([{ env: "production", endpointHost: HOST }]);
    expect((await deploymentIdentity(healthy.db)).databaseEnv).toBe("production");
  });

  it("reports null when the marker row is missing, not an empty string", async () => {
    const { db } = markerDb([]);

    expect((await deploymentIdentity(db)).databaseEnv).toBeNull();
  });

  it("fingerprints a pooled and a direct url for one branch identically", () => {
    // db-migrate.ts strips the same suffix before claiming the marker, so a
    // deployment on the pooled url and a caller on the direct one must agree.
    expect(databaseFingerprint(`ep-x-123.eu.aws.neon.tech`)).toBe(
      databaseFingerprint(`EP-X-123-pooler.eu.aws.neon.tech`),
    );
  });

  it("gives different branches different fingerprints", () => {
    expect(databaseFingerprint("ep-a-1.eu.aws.neon.tech")).not.toBe(
      databaseFingerprint("ep-b-2.eu.aws.neon.tech"),
    );
  });

  it("never puts the host itself in the payload", async () => {
    // /health is public and unauthenticated. The fingerprint exists so callers
    // can compare branches without the endpoint being readable off it.
    const { db } = markerDb([{ env: "production", endpointHost: HOST }]);

    expect(JSON.stringify(await deploymentIdentity(db))).not.toContain("neon.tech");
  });

  it("still answers when the database handle cannot even be opened", async () => {
    // /health answered before it knew anything about the database, and a
    // deployment too broken to open a connection is exactly when somebody is
    // asking health what is going on.
    mockEnv.VERCEL_ENV = "production";
    const openDb = () => {
      throw new Error("DATABASE_URL is not a valid connection string");
    };

    expect(await deploymentIdentity(openDb)).toEqual({
      commit: null,
      env: "production",
      databaseEnv: null,
      databaseFingerprint: null,
    });
  });
});
