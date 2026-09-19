import { describe, expect, it, vi } from "vitest";
import { integrationManifests } from "@integrations/registry";
import { integrationHealthEntries } from "./integration-probes.js";

vi.mock("../../infra/vcs-config.js", () => ({ env: {} }));

/**
 * One health entry per integration this build ships.
 *
 * It decides from stored rows handed to it, and reaches no database of its own.
 * That matters twice: a health scan is already the thing that runs when a
 * deployment is unwell, so it must not need one more connection to report; and
 * this used to be a second copy of "a non-empty registry means a database",
 * invisible while the generated registry was empty.
 */

describe("integration health entries", () => {
  it("answers for every integration this build ships, from the rows it is given", () => {
    const entries = integrationHealthEntries(new Map());

    expect(entries.map((entry) => entry.manifest.id)).toEqual(
      integrationManifests.map((manifest) => manifest.id),
    );
  });

  it("offers no probe for a connection nobody has made, so nothing is decrypted", () => {
    // Values are read only for a connection the resolver already called usable.
    // A probe offered here would mean the scan tried to reach a provider it has
    // no credentials for, and reported that failure as the provider's.
    for (const entry of integrationHealthEntries(new Map())) {
      expect(entry.state.usable).toBe(false);
      expect(entry.probe).toBeUndefined();
    }
  });
});
