// apps/worker/src/services/repository-catalog/authoring.test.ts
//
// The one outcome the screen must never be told. A save whose write was
// refused because the profile moved under it wrote nothing, and reporting that
// as "nothing to save" would leave an operator believing the stored profile
// already matched the change they just lost.
//
// The statement is what decides this (see the `allowed` expression in
// db/repositories/repository-catalog.ts): a planned change that wrote no row
// comes back refused rather than unchanged. The race that produces it needs a
// second connection committing between the snapshot and the UPDATE, which the
// in-process pglite driver cannot stage, so what is pinned here is the
// contract on this side of the boundary: a refusal is answered as a conflict,
// with the version to reload, and never as an unchanged save.
import { describe, expect, it, vi } from "vitest";

const refusal = vi.hoisted(() => ({
  result: null as unknown,
  calls: 0,
}));

// Nothing on the refused path may read the database: the whole point of the
// conditional write is that there is no read in front of it and none after.
vi.mock("../../db/client.js", () => ({
  getDb: () => {
    throw new Error("a refused save must not touch the database");
  },
}));
// Stubbed whole rather than spread over the real module: the auth barrel pulls
// in the runtime env, which a unit test has no business configuring. The label
// is the only thing this path takes from it.
vi.mock("../auth/index.js", () => ({
  getConnectedDashboardUserLabel: async () => "Ada",
}));
vi.mock("../../db/repositories/repository-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../db/repositories/repository-catalog.js")
    >();
  return {
    ...actual,
    upsertConnectedRepositoryProfile: async () => {
      refusal.calls += 1;
      return refusal.result;
    },
  };
});

const { RepositoryProfileConflictError, saveRepositoryProfile } = await import(
  "./authoring.js"
);

const request = {
  provider: "github" as const,
  path: "acme/api",
  rules: "no force push",
  reason: "tightening the rules",
  expectedProfileVersion: 3,
};

describe("saveRepositoryProfile", () => {
  it("answers a refused write as a conflict, never as nothing to save", async () => {
    // Exactly what the statement returns when the snapshot allowed the write
    // and the UPDATE matched no row: refused, carrying the version the caller
    // has to reload past.
    refusal.result = { conflict: true, currentVersion: 3 };
    refusal.calls = 0;

    const failure = await saveRepositoryProfile({
      actor: { role: "admin", id: "user-1" },
      request,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RepositoryProfileConflictError);
    expect((failure as InstanceType<typeof RepositoryProfileConflictError>).currentVersion).toBe(3);
    expect((failure as Error).message).toBe("repository_profile_conflict");
    expect(refusal.calls).toBe(1);
  });
});
