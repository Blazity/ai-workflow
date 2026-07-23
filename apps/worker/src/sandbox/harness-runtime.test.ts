import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  HarnessProfileResolvedVersion,
  HarnessResolvedSkillArtifact,
} from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  BUILTIN_HARNESS_PROFILE_IDS,
} from "@shared/contracts";
import { hashHarnessProfileManifest } from "../harness-profiles/manifest.js";
import { hashHarnessSkillArtifact } from "../harness-profiles/skill-artifact.js";
import {
  materializePinnedHarnessFiles,
  resolveHarnessCapabilities,
  resolveHarnessRuntime,
  resolveRuntimeCredentials,
} from "./harness-runtime.js";
import { combineHarnessRuntimeLimits } from "./harness-runtime-limits.js";

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolvedSkillArtifact(
  name = "review-helper",
): HarnessResolvedSkillArtifact {
  const content = Buffer.from(
    `---\nname: ${name}\ndescription: Review helper\n---\n\n# Skill\nPinned.\n`,
  );
  const source = {
    owner: "acme",
    repository: "skills",
    path: name,
    commitSha: "b".repeat(40),
  };
  const files = [
    {
      path: "SKILL.md",
      mode: 0o644,
      sizeBytes: content.byteLength,
      sha256: hash(content),
      contentBase64: content.toString("base64"),
    },
  ];
  const hashInput = {
    name,
    description: "Review helper",
    source,
    files,
  };
  return {
    ...hashInput,
    artifactHash: hashHarnessSkillArtifact(hashInput),
    organizationId: "org-1",
    createdAt: "2026-07-23T00:00:00.000Z",
    createdById: "user-1",
  };
}

function resolvedCodex(
  overrides: Partial<
    HarnessProfileResolvedVersion["manifest"]
  > = {},
  skillArtifacts: HarnessResolvedSkillArtifact[] = [],
): HarnessProfileResolvedVersion {
  const manifest = {
    ...structuredClone(
      BUILTIN_HARNESS_PROFILE_MANIFESTS[
        BUILTIN_HARNESS_PROFILE_IDS.codex
      ],
    ),
    profileId: "profile-1",
    slug: "profile-1",
    system: false,
    ...overrides,
  };
  return {
    manifest,
    manifestHash: hashHarnessProfileManifest(manifest),
    skillArtifacts,
  };
}

describe("Harness Profile runtime resolution", () => {
  it("uses exact manifest-hash paths and records clipped capabilities safely", () => {
    const resolved = resolvedCodex({
      subagents: { enabled: true, maxConcurrent: 4 },
    });
    const runtime = resolveHarnessRuntime({
      nodeId: "planning",
      nodeType: "planning_agent",
      workspaceMode: "none",
      resolved,
    });

    expect(runtime.paths.rootDir).toBe(
      `/tmp/aiw-harness/${resolved.manifestHash}`,
    );
    expect(runtime.cliSpec).toMatchObject({
      kind: "codex",
      version: "0.144.6",
      protocol: "codex-jsonl-0.144.6",
    });
    expect(runtime.capabilities.subagents).toEqual({
      requested: true,
      enabled: false,
      maxConcurrent: 0,
      clipped: true,
    });
    expect(runtime.safeManifest.manifestHash).toBe(resolved.manifestHash);
    expect(runtime.safeManifest).not.toHaveProperty(
      "skills.0.files.0.contentBase64",
    );
  });

  it("rejects a changed manifest, unsupported model options, and extra credentials", () => {
    const changed = resolvedCodex();
    changed.manifest.instructions = "changed after hashing";
    expect(() =>
      resolveHarnessRuntime({
        nodeId: "implementation",
        nodeType: "implementation_agent",
        resolved: changed,
      }),
    ).toThrow(/hash verification/);

    const options = resolvedCodex({
      model: { id: "gpt-5-codex", options: { temperature: 0 } },
    });
    expect(() =>
      resolveHarnessRuntime({
        nodeId: "implementation",
        nodeType: "implementation_agent",
        resolved: options,
      }),
    ).toThrow(/model options/);

    expect(() =>
      resolveRuntimeCredentials(
        {
          ...resolvedCodex().manifest,
          credentialReferences: ["openai", "github"],
        },
        { codexApiKey: "runtime-secret" },
      ),
    ).toThrow(/provider credential/);
  });

  it("applies only the active profile limits and leaves untaken branches out", () => {
    const active = resolveHarnessRuntime({
      nodeId: "active",
      nodeType: "implementation_agent",
      resolved: resolvedCodex({
        limits: {
          maxDurationMs: 20_000,
          maxTokens: 5_000,
          maxCostUsd: null,
        },
      }),
    });
    const inactive = resolveHarnessRuntime({
      nodeId: "inactive",
      nodeType: "review_agent",
      resolved: resolvedCodex({
        profileId: "profile-2",
        slug: "profile-2",
        limits: {
          maxDurationMs: null,
          maxTokens: 4_000,
          maxCostUsd: 2,
        },
      }),
    });

    const workflowLimits = {
      maxDurationMs: 30_000,
      maxTokens: 10_000,
      maxCostUsd: 5,
    };

    expect(combineHarnessRuntimeLimits(workflowLimits)).toEqual(
      workflowLimits,
    );
    expect(
      combineHarnessRuntimeLimits(workflowLimits, active),
    ).toEqual({
      maxDurationMs: 20_000,
      maxTokens: 5_000,
      maxCostUsd: 5,
    });
    expect(inactive.manifest.limits).toEqual({
      maxDurationMs: null,
      maxTokens: 4_000,
      maxCostUsd: 2,
    });
  });

  it("reports filesystem and git as effective in an isolated scratch sandbox", () => {
    const resolved = resolvedCodex();
    const capabilities = resolveHarnessCapabilities({
      nodeType: "generic_agent",
      workspaceMode: "none",
      manifest: resolved.manifest,
    });

    expect(capabilities.tools).toEqual(["filesystem", "git", "shell"]);
    expect(capabilities.clippedTools).toEqual([]);
  });

  it("materializes only pinned files and verifies their hashes", async () => {
    const homeBytes = Buffer.from("Follow the pinned repository policy.\n");
    const artifact = resolvedSkillArtifact();
    const resolved = resolvedCodex(
      {
        homeFiles: [
          {
            path: "AGENTS.md",
            content: homeBytes.toString("utf8"),
            mode: 0o644,
          },
        ],
        skills: [
          {
            artifactHash: artifact.artifactHash,
            name: artifact.name,
          },
        ],
      },
      [artifact],
    );
    const runtime = resolveHarnessRuntime({
      nodeId: "implementation",
      nodeType: "implementation_agent",
      resolved,
    });
    const written = new Map<string, Buffer>();
    const runCommand = vi.fn(
      async (command: string, args: string[]) => {
        const path = args[0] ?? "";
        return {
          exitCode: 0,
          stdout: async () =>
            command === "sha256sum"
              ? `${hash(written.get(path) ?? Buffer.alloc(0))}  ${path}\n`
              : "",
          stderr: async () => "",
        };
      },
    );
    const writeFiles = vi.fn(
      async (files: Array<{ path: string; content: Buffer }>) => {
        for (const file of files) written.set(file.path, file.content);
      },
    );

    await materializePinnedHarnessFiles(
      { runCommand, writeFiles } as never,
      runtime,
      [artifact],
    );

    expect([...written.keys()]).toEqual(
      expect.arrayContaining([
        `${runtime.paths.homeDir}/AGENTS.md`,
        `${runtime.paths.homeDir}/.agents/skills/review-helper/SKILL.md`,
      ]),
    );
    expect(runCommand).not.toHaveBeenCalledWith("npx", expect.anything());
    expect(
      runCommand.mock.calls.filter(([command]) => command === "sha256sum"),
    ).toHaveLength(2);
  });

  it("rejects aggregate tampering and missing SKILL.md before writing files", async () => {
    const artifact = resolvedSkillArtifact();
    const resolved = resolvedCodex(
      {
        skills: [
          {
            artifactHash: artifact.artifactHash,
            name: artifact.name,
          },
        ],
      },
      [artifact],
    );
    const runtime = resolveHarnessRuntime({
      nodeId: "implementation",
      nodeType: "implementation_agent",
      resolved,
    });
    const writeFiles = vi.fn();
    const sandbox = {
      runCommand: vi.fn(),
      writeFiles,
    };
    const tampered = structuredClone(artifact);
    const changed = Buffer.from(
      "---\nname: review-helper\ndescription: Review helper\n---\n\n# Skill\nChanged.\n",
    );
    tampered.files[0] = {
      ...tampered.files[0]!,
      sizeBytes: changed.byteLength,
      sha256: hash(changed),
      contentBase64: changed.toString("base64"),
    };

    await expect(
      materializePinnedHarnessFiles(sandbox as never, runtime, [tampered]),
    ).rejects.toThrow(/aggregate hash verification/);
    expect(writeFiles).not.toHaveBeenCalled();

    const missingDocument = {
      ...structuredClone(artifact),
      files: [],
    };
    await expect(
      materializePinnedHarnessFiles(
        sandbox as never,
        runtime,
        [missingDocument],
      ),
    ).rejects.toThrow(/file count/);
    expect(writeFiles).not.toHaveBeenCalled();
  });
});
