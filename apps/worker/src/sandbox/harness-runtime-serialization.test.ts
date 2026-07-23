import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  HarnessProfileManifestV1,
  HarnessResolvedSkillArtifact,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_IDS,
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  HARNESS_SKILL_IMPORT_LIMITS,
} from "@shared/contracts";
import { hashHarnessProfileManifest } from "../harness-profiles/manifest.js";
import { resolveHarnessRuntime } from "./harness-runtime.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Resolved Harness Profile runtime serialization", () => {
  it("keeps max-size skill bytes out of the serializable runtime and run manifest", () => {
    const marker = "MAX_SIZE_SKILL_CONTENT_MUST_NOT_BE_SERIALIZED";
    const files = Array.from({ length: 5 }, (_, index) => {
      const content = Buffer.alloc(
        HARNESS_SKILL_IMPORT_LIMITS.maxFileBytes,
        97 + index,
      );
      if (index === 0) content.write(marker);
      return {
        path: index === 0 ? "SKILL.md" : `references/part-${index}.md`,
        mode: 0o644,
        sizeBytes: content.byteLength,
        sha256: sha256(content),
        contentBase64: content.toString("base64"),
      };
    });
    expect(files.reduce((total, file) => total + file.sizeBytes, 0)).toBe(
      HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes,
    );

    const artifact: HarnessResolvedSkillArtifact = {
      artifactHash: "a".repeat(64),
      organizationId: "org-1",
      name: "max-size-skill",
      description: null,
      source: {
        owner: "acme",
        repository: "skills",
        path: "max-size-skill",
        commitSha: "b".repeat(40),
      },
      files,
      createdAt: "2026-07-23T00:00:00.000Z",
      createdById: "user-1",
    };
    const homeContent = "HOME_FILE_CONTENT_MUST_NOT_BE_IN_RUN_MANIFEST";
    const manifest: HarnessProfileManifestV1 = {
      ...structuredClone(
        BUILTIN_HARNESS_PROFILE_MANIFESTS[
          BUILTIN_HARNESS_PROFILE_IDS.codex
        ],
      ),
      profileId: "profile-serialization",
      slug: "profile-serialization",
      system: false,
      homeFiles: [
        {
          path: "AGENTS.md",
          mode: 0o644,
          content: homeContent,
        },
      ],
      skills: [
        {
          artifactHash: artifact.artifactHash,
          name: artifact.name,
        },
      ],
    };
    const runtime = resolveHarnessRuntime({
      nodeId: "implementation",
      nodeType: "implementation_agent",
      resolved: {
        manifest,
        manifestHash: hashHarnessProfileManifest(manifest),
        skillArtifacts: [artifact],
      },
    });

    expect(structuredClone(runtime)).toEqual(runtime);
    const serialized = JSON.stringify(runtime);
    expect(JSON.parse(serialized)).toEqual(runtime);
    expect(serialized).not.toContain("contentBase64");
    expect(serialized).not.toContain(
      Buffer.from(marker).toString("base64"),
    );

    expect(runtime.safeManifest.skills).toEqual([
      expect.objectContaining({
        artifactHash: artifact.artifactHash,
        name: artifact.name,
        fileCount: 5,
        totalBytes: HARNESS_SKILL_IMPORT_LIMITS.maxSkillBytes,
      }),
    ]);
    expect(runtime.safeManifest.manifest.homeFiles).toEqual({
      count: 1,
      totalBytes: Buffer.byteLength(homeContent),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const safeManifestJson = JSON.stringify(runtime.safeManifest);
    expect(safeManifestJson).not.toContain(homeContent);
    expect(safeManifestJson).not.toContain("AGENTS.md");
    expect(safeManifestJson).not.toContain("contentBase64");
    expect(safeManifestJson).not.toContain('"files"');
  });
});
