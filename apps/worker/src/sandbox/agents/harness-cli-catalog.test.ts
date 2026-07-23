import { describe, expect, it } from "vitest";
import type { SerializableAgentCliSpec } from "./types.js";
import {
  AGENT_CLI_SPEC_CATALOG,
  hydrateAgentCliSpec,
} from "./protocol.js";

function serializeCatalogEntry(
  entry: (typeof AGENT_CLI_SPEC_CATALOG)[number],
): SerializableAgentCliSpec {
  return {
    kind: entry.kind,
    packageName: entry.packageName,
    version: entry.version,
    executable: entry.executable,
    protocol: entry.protocol,
  };
}

describe("append-only agent CLI catalog hydration", () => {
  it.each(AGENT_CLI_SPEC_CATALOG)(
    "hydrates the exact historical $kind $version tuple",
    (entry) => {
      const serialized = serializeCatalogEntry(entry);
      const hydrated = hydrateAgentCliSpec(
        JSON.parse(JSON.stringify(serialized)),
      );

      expect(hydrated).toBe(entry);
      expect(hydrated.parseVersion(entry.version)).toBe(entry.version);
    },
  );

  it.each(AGENT_CLI_SPEC_CATALOG)(
    "rejects every mutated field of $kind $version",
    (entry) => {
      const serialized = serializeCatalogEntry(entry);
      const mutations: SerializableAgentCliSpec[] = [
        {
          ...serialized,
          kind: serialized.kind === "codex" ? "claude" : "codex",
        },
        { ...serialized, packageName: `${serialized.packageName}-mutated` },
        { ...serialized, version: `${serialized.version}-mutated` },
        { ...serialized, executable: `${serialized.executable}-mutated` },
        { ...serialized, protocol: `${serialized.protocol}-mutated` },
      ];

      for (const mutation of mutations) {
        expect(() => hydrateAgentCliSpec(mutation)).toThrow(
          /not in the code-owned runtime catalog/,
        );
      }
    },
  );
});
