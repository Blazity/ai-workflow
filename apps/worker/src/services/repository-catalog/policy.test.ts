import { repositoryCatalogKey } from "@shared/contracts";
import { describe, expect, it } from "vitest";
import { isRepositoryEnabled, reportBridge } from "./policy.js";
import type { RepositoryCatalogSnapshot } from "./store.js";

function snapshot(input: {
  activated: boolean;
  enabled?: string[];
}): RepositoryCatalogSnapshot {
  return {
    activated: input.activated,
    enabled: new Set(input.enabled ?? []),
    entries: [],
    state: {
      activated: input.activated,
      bridge: !input.activated,
      activatedAt: null,
      activatedById: null,
      activatedByLabel: null,
    },
  };
}

describe("the catalog gate", () => {
  it("passes every repository while the catalog is not activated", () => {
    const bridge = snapshot({ activated: false, enabled: ["github:acme/api"] });
    expect(isRepositoryEnabled(bridge, "github:acme/api")).toBe(true);
    expect(isRepositoryEnabled(bridge, "github:acme/web")).toBe(true);
    expect(isRepositoryEnabled(bridge, "gitlab:someone/else")).toBe(true);
  });

  it("passes every repository while the catalog is not activated and empty", () => {
    expect(isRepositoryEnabled(snapshot({ activated: false }), "github:acme/api")).toBe(
      true,
    );
  });

  it("admits only the enabled rows once it is activated", () => {
    const activated = snapshot({ activated: true, enabled: ["github:acme/api"] });
    expect(isRepositoryEnabled(activated, "github:acme/api")).toBe(true);
  });

  it("refuses a disabled row once it is activated", () => {
    const activated = snapshot({ activated: true, enabled: ["github:acme/api"] });
    expect(isRepositoryEnabled(activated, "github:acme/web")).toBe(false);
  });

  it("refuses a repository with no row at all once it is activated", () => {
    const activated = snapshot({ activated: true, enabled: ["github:acme/api"] });
    expect(isRepositoryEnabled(activated, "gitlab:acme/api")).toBe(false);
  });

  it("matches whatever the casing of the key, as the allowlist always has", () => {
    const activated = snapshot({ activated: true, enabled: ["github:acme/api"] });
    expect(isRepositoryEnabled(activated, "github:Acme/Api")).toBe(true);
    expect(
      isRepositoryEnabled(
        activated,
        repositoryCatalogKey({ provider: "github", path: "ACME/API" }),
      ),
    ).toBe(true);
  });
});

describe("reportBridge", () => {
  it("says the catalog decides nothing yet, and what to do about it", () => {
    const report = reportBridge(snapshot({ activated: false }));
    expect(report.bridge).toBe(true);
    expect(report.message).toContain("not activated");
  });

  it("has nothing to say once the catalog is activated", () => {
    expect(reportBridge(snapshot({ activated: true }))).toEqual({
      bridge: false,
      message: null,
    });
  });
});
