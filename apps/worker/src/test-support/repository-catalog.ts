/**
 * Repository catalog snapshots for tests that do not care about the catalog.
 *
 * Most dispatch tests are about something else entirely and only need a
 * snapshot that behaves like the deployment they describe. The two factories
 * here are typed as the real `RepositoryCatalogSnapshot`, so a change to that
 * shape breaks the build here rather than leaving a hand-rolled object quietly
 * lying to a hundred tests. The tests that are actually ABOUT the catalog load a
 * real snapshot from a pglite database instead, which is the only thing that can
 * prove the store and this agree.
 */
import { type RepositoryCatalogSnapshot } from "../services/repository-catalog/index.js";

/** The bridge: nobody has activated the catalog, so every repository passes. */
export function unactivatedRepositoryCatalog(): RepositoryCatalogSnapshot {
  return {
    activated: false,
    enabled: new Set<string>(),
    state: {
      activated: false,
      bridge: true,
      activatedAt: null,
      activatedById: null,
      activatedByLabel: null,
    },
  };
}

/** Activated, with exactly these `provider:owner/repo` keys enabled. */
export function activatedRepositoryCatalog(
  enabled: readonly string[],
): RepositoryCatalogSnapshot {
  return {
    activated: true,
    enabled: new Set(enabled.map((key) => key.toLowerCase())),
    state: {
      activated: true,
      bridge: false,
      activatedAt: "2026-09-11T00:00:00.000Z",
      activatedById: "user-1",
      activatedByLabel: "Ada",
    },
  };
}
