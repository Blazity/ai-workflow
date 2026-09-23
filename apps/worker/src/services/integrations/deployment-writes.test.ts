import { describe, expect, it } from "vitest";

import { decideIntegrationWriteAccess } from "./deployment-writes.js";

/**
 * The demo deployment is a preview that points at the production Neon branch
 * (SETUP.md, `DATABASE_SHARED_WITH=production`), so "is this a preview" is the
 * wrong question: what matters is whether the deployment owns the database it is
 * about to write to. Expected sentences come from that reading of decision 9,
 * not from the implementation.
 */
describe("which deployments may change an integration", () => {
  it("lets production write to production's own database", () => {
    expect(
      decideIntegrationWriteAccess({ deploymentEnv: "production", databaseEnv: "production" }),
    ).toEqual({ allowed: true });
  });

  it("lets a developer write to a local database", () => {
    expect(
      decideIntegrationWriteAccess({ deploymentEnv: "development", databaseEnv: "development" }),
    ).toEqual({ allowed: true });
  });

  it("refuses the demo preview that reads the production database, naming both sides (INT-015)", () => {
    const access = decideIntegrationWriteAccess({
      deploymentEnv: "preview",
      databaseEnv: "production",
    });
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toContain("preview");
    expect(access.allowed === false && access.reason).toContain("production");
  });

  it("refuses a developer whose DATABASE_URL points at production", () => {
    const access = decideIntegrationWriteAccess({
      deploymentEnv: "development",
      databaseEnv: "production",
    });
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toContain("production");
  });

  it("refuses rather than guesses when the database does not say what it is", () => {
    const access = decideIntegrationWriteAccess({
      deploymentEnv: "production",
      databaseEnv: null,
    });
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toContain("could not be confirmed");
  });

  it("gives the same answer whether the marker is absent or the database is unreachable", () => {
    // The caller turns a failed read into a null marker, because a database that
    // cannot be reached cannot say who owns it either, and an admin needs one
    // sentence rather than a 500.
    const access = decideIntegrationWriteAccess({ deploymentEnv: "preview", databaseEnv: null });
    expect(access.allowed).toBe(false);
    expect(access.allowed === false && access.reason).toContain("could not be reached");
  });
});
