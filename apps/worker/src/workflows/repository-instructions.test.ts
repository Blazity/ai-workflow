import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceManifest, WorkspaceRepoV2 } from "../sandbox/repo-workspace.js";
import { compileEffectivePrompt } from "./effective-prompt.js";
import {
  loadInvocationRepositoryInstructionSources,
  loadRepositoryInstructionSources,
} from "./repository-instructions.js";

const mocks = vi.hoisted(() => ({
  readFileToBuffer: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: vi.fn(async () => ({ readFileToBuffer: mocks.readFileToBuffer })),
  },
}));
vi.mock("../sandbox/credentials.js", () => ({
  getSandboxCredentials: () => ({ teamId: "team" }),
}));

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

function discoveredRepo(
  provider: "github" | "gitlab",
  repoPath: string,
  slug: string,
  access: "read" | "write",
): WorkspaceRepoV2 {
  return {
    provider,
    repoPath,
    slug,
    localPath: `/vercel/sandbox/repos/${slug}`,
    defaultBranch: "main",
    branchName: "ai-workflow/AIW-147",
    selectedRationale: `discovered ${repoPath}`,
    access,
    researchBaseSha: `sha-${slug}`,
  };
}

const discoveredManifest: WorkspaceManifest = {
  version: 2,
  repositories: [
    discoveredRepo("github", "acme/service", "github__acme__service", "write"),
    discoveredRepo("gitlab", "acme/web", "gitlab__acme__web", "read"),
  ],
};

describe("repository instruction sources", () => {
  beforeEach(() => {
    mocks.readFileToBuffer.mockReset();
    mocks.readFileToBuffer.mockResolvedValue(null);
  });

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

  it("accepts a discovery-promoted layout where every repository lives under repos/", async () => {
    await expect(
      loadRepositoryInstructionSources("code-workspace", discoveredManifest),
    ).resolves.toEqual([]);
  });

  it("rejects manifest paths outside their deterministic workspace location", async () => {
    const unsafe = structuredClone(manifest);
    unsafe.repositories[0]!.localPath = "/vercel/sandbox/../secrets";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow("Repository instruction path is invalid");
  });

  it("rejects a repository path nested below its repos directory", async () => {
    const unsafe = structuredClone(discoveredManifest);
    unsafe.repositories[1]!.localPath =
      "/vercel/sandbox/repos/gitlab__acme__web/nested";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow("Repository instruction path is invalid");
  });

  it("rejects duplicate repository paths", async () => {
    const unsafe = structuredClone(discoveredManifest);
    unsafe.repositories[0]!.localPath = "/vercel/sandbox";
    unsafe.repositories[1]!.localPath = "/vercel/sandbox";

    await expect(
      loadRepositoryInstructionSources("code-workspace", unsafe),
    ).rejects.toThrow(/duplicated/i);
  });
});
