import { describe, expect, it } from "vitest";
import type { HarnessProfileDraftManifestV1 } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
} from "@shared/contracts";
import {
  compileHarnessProfileManifest,
  HarnessProfileManifestError,
  hashHarnessProfileManifest,
  parseHarnessProfileDraftManifest,
} from "./manifest.js";

function draft(): HarnessProfileDraftManifestV1 {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...value
  } = structuredClone(
    BUILTIN_HARNESS_PROFILE_MANIFESTS[BUILTIN_HARNESS_PROFILE_IDS.codex],
  );
  return value;
}

function issuePaths(error: unknown): string[] {
  expect(error).toBeInstanceOf(HarnessProfileManifestError);
  return (error as HarnessProfileManifestError).issues.map(
    (issue) => issue.path,
  );
}

describe("harness profile manifest validation", () => {
  it("accepts a code-owned provider contract and hashes it deterministically", () => {
    const parsed = parseHarnessProfileDraftManifest(draft());
    const first = compileHarnessProfileManifest({
      profileId: "profile",
      version: 1,
      slug: "profile",
      system: false,
      draft: parsed,
    });
    const reordered = {
      ...first,
      model: { options: {}, id: first.model.id },
    };
    expect(hashHarnessProfileManifest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashHarnessProfileManifest(first)).toBe(
      hashHarnessProfileManifest(reordered),
    );
  });

  it("rejects arbitrary packages, versions, protocols, model options, tools, and MCP IDs", () => {
    const value = draft() as unknown as Record<string, any>;
    value.harness.packageName = "arbitrary-host-command";
    value.harness.cliVersion = "latest";
    value.harness.protocolVersion = "custom";
    value.model.options = { temperature: 1 };
    expect(() => parseHarnessProfileDraftManifest(value)).toThrow();
    try {
      parseHarnessProfileDraftManifest(value);
    } catch (error) {
      expect(issuePaths(error)).toEqual(
        expect.arrayContaining([
          "/harness/packageName",
          "/harness/cliVersion",
          "/harness/protocolVersion",
          "/model/options",
        ]),
      );
    }

    const capabilities = draft() as unknown as Record<string, any>;
    capabilities.tools = ["curl"];
    capabilities.mcpIntegrations = ["arbitrary"];
    expect(() => parseHarnessProfileDraftManifest(capabilities)).toThrow();
    try {
      parseHarnessProfileDraftManifest(capabilities);
    } catch (error) {
      expect(issuePaths(error)).toEqual(
        expect.arrayContaining([
          "/tools/0",
          "/mcpIntegrations",
        ]),
      );
    }
  });

  it("requires only the provider credential while allowing scratch-only workspaces", () => {
    const value = draft();
    value.credentialReferences = ["openai", "github"];
    value.workspace.preserveAcrossBlocks = false;
    try {
      parseHarnessProfileDraftManifest(value);
      expect.unreachable();
    } catch (error) {
      expect(issuePaths(error)).toEqual(
        expect.arrayContaining(["/credentialReferences"]),
      );
      expect(issuePaths(error)).not.toContain("/workspace/preserveAcrossBlocks");
    }
  });

  it("requires the complete code-owned tool set", () => {
    const value = draft();
    value.tools = ["filesystem"];
    expect(() => parseHarnessProfileDraftManifest(value)).toThrow(
      HarnessProfileManifestError,
    );
  });

  it.each([
    "/absolute",
    "../outside",
    "safe/../../outside",
    "auth.json",
    ".env",
    ".ssh/private-key",
    "tokens/access.txt",
    "windows\\path",
  ])("rejects unsafe home file path %s", (path) => {
    const value = draft();
    value.homeFiles = [{ path, content: "x", mode: 0o644 }];
    expect(() => parseHarnessProfileDraftManifest(value)).toThrow(
      HarnessProfileManifestError,
    );
  });

  it("rejects duplicate home files, skills, capabilities, and malformed artifact hashes", () => {
    const value = draft() as unknown as Record<string, any>;
    value.homeFiles = [
      { path: "AGENTS.md", content: "one", mode: 0o644 },
      { path: "AGENTS.md", content: "two", mode: 0o644 },
    ];
    value.skills = [
      { name: "one", artifactHash: "not-a-hash" },
      { name: "one", artifactHash: "a".repeat(64) },
    ];
    value.tools = ["git", "git"];
    expect(() => parseHarnessProfileDraftManifest(value)).toThrow(
      HarnessProfileManifestError,
    );
  });
});
