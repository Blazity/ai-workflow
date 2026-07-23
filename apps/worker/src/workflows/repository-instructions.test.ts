import { describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest } from "../sandbox/repo-workspace.js";
import { compileEffectivePrompt } from "./effective-prompt.js";
import {
  loadInvocationRepositoryInstructionSources,
  loadRepositoryInstructionSources,
} from "./repository-instructions.js";

const manifest: WorkspaceManifest = {
  version: 1,
  repositories: [{
    provider: "github",
    repoPath: "acme/service",
    slug: "acme__service",
    localPath: "/vercel/sandbox",
    defaultBranch: "main",
    branchName: "ai-workflow/AIW-124",
    selectedRationale: "Primary repository",
  }],
};

describe("repository instruction sources", () => {
  it("loads planning instructions from the authoritative code workspace", async () => {
    const load = vi.fn(async (sandboxId: string) => [
      {
        repository: "acme/service",
        path: "AGENTS.md" as const,
        content: `${sandboxId}: agent rules`,
      },
      {
        repository: "acme/service",
        path: "CLAUDE.md" as const,
        content: `${sandboxId}: claude rules`,
      },
    ]);

    const sources = await loadInvocationRepositoryInstructionSources(
      {
        nodeType: "planning_agent",
        executionSandboxId: "isolated-research",
        sharedCodeSandboxId: "code-workspace",
        manifest,
      },
      load,
    );

    expect(load).toHaveBeenCalledWith("code-workspace", manifest);
    expect(sources.map((source) => source.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(sources.every((source) => source.content.startsWith("code-workspace")))
      .toBe(true);

    const compiled = await compileEffectivePrompt({
      nodeId: "planning",
      blockPrompt: "Plan the work.",
      runtimeData: "Ticket: AIW-124",
      profileSource: {
        profileId: "builtin-codex",
        version: 1,
        name: "Codex",
        instructions: "Use repository instructions.",
      },
      repositorySources: sources,
    });
    expect(compiled.prompt).toContain("code-workspace: agent rules");
    expect(compiled.prompt).toContain("code-workspace: claude rules");
  });

  it("does not fall back to the repository-free planning sandbox", async () => {
    const load = vi.fn();
    await expect(
      loadInvocationRepositoryInstructionSources(
        {
          nodeType: "planning_agent",
          executionSandboxId: "isolated-research",
          sharedCodeSandboxId: null,
          manifest,
        },
        load,
      ),
    ).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects manifest paths outside their deterministic workspace location", async () => {
    const unsafe = structuredClone(manifest);
    unsafe.repositories[0]!.localPath = "/vercel/sandbox/../secrets";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow("Repository instruction path is invalid");
  });
});
