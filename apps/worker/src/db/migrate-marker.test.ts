import { describe, expect, it } from "vitest";
import {
  decideMarkerAction,
  type DatabaseMarker,
} from "./migrate-marker.js";

const marker: DatabaseMarker = {
  env: "preview",
  endpointHost: "preview.example.test",
};

function decide(
  overrides: Partial<Parameters<typeof decideMarkerAction>[0]> = {},
) {
  return decideMarkerAction({
    marker,
    host: marker.endpointHost,
    vercelEnv: marker.env,
    sharedWith: undefined,
    ...overrides,
  });
}

describe("database migration marker decision", () => {
  it("claims an unclaimed database", () => {
    expect(decide({ marker: null })).toEqual({
      action: "claim",
      message: "[db-migrate] OK \u2014 branch claimed by 'preview'.",
    });
  });

  it("reclaims a copied database on a different host", () => {
    expect(decide({ host: "copy.example.test" })).toEqual({
      action: "reclaim",
      message:
        "[db-migrate] branch copied from 'preview' (preview.example.test) " +
        "\u2014 re-claiming for 'preview'.",
    });
  });

  it("accepts a marker owned by this environment", () => {
    expect(decide()).toEqual({
      action: "ok",
      message: "[db-migrate] OK \u2014 branch claimed by 'preview'.",
    });
  });

  it("refuses an owner mismatch on the same host", () => {
    const decision = decide({ vercelEnv: "development" });

    expect(decision.action).toBe("fatal");
    expect(decision.message).toContain("already claimed by VERCEL_ENV='preview'");
    expect(decision.message).toContain("this build is VERCEL_ENV='development'");
  });

  it("refuses a sharing declaration from production", () => {
    const decision = decide({
      vercelEnv: "production",
      sharedWith: "production",
    });

    expect(decision.action).toBe("fatal");
    expect(decision.message).toContain("production never declares database sharing");
  });

  it("refuses to claim an unclaimed database for a sharing environment", () => {
    const decision = decide({ marker: null, sharedWith: "production" });

    expect(decision.action).toBe("fatal");
    expect(decision.message).toContain("must already be claimed");
  });

  it("shares a database owned by the declared environment", () => {
    expect(
      decide({
        marker: { env: "production", endpointHost: "prod.example.test" },
        host: "prod.example.test",
        sharedWith: "production",
      }),
    ).toEqual({
      action: "shared",
      message:
        "[db-migrate] sharing the 'production' database by declaration " +
        "(DATABASE_SHARED_WITH); marker left untouched.",
    });
  });

  it("refuses sharing when the marker host differs", () => {
    const decision = decide({
      marker: { env: "production", endpointHost: "other.example.test" },
      host: "prod.example.test",
      vercelEnv: "preview",
      sharedWith: "production",
    });

    expect(decision.action).toBe("fatal");
    expect(decision.message).toContain("VERCEL_ENV='preview' on host 'prod.example.test'");
    expect(decision.message).toContain(
      "marker is owned by VERCEL_ENV='production' on host 'other.example.test'",
    );
  });

  it("refuses sharing when the marker owner differs", () => {
    const decision = decide({
      marker: { env: "staging", endpointHost: "prod.example.test" },
      host: "prod.example.test",
      vercelEnv: "preview",
      sharedWith: "production",
    });

    expect(decision.action).toBe("fatal");
    expect(decision.message).toContain("DATABASE_SHARED_WITH='production'");
    expect(decision.message).toContain(
      "marker is owned by VERCEL_ENV='staging' on host 'prod.example.test'",
    );
  });
});
