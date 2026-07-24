import { describe, expect, it, vi } from "vitest";
import type { EngineCtx } from "../workflows/blocks/types.js";
import {
  attachResearchRepositories,
  promoteAgentSandboxToWorkspace,
} from "./research-workspace.js";
import type { WorkspaceManifestV2 } from "./repo-workspace.js";

function command(stdout = "", exitCode = 0, stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

function createSandbox() {
  const runCommand = vi.fn(async (_command: string, args: string[]) => {
    if (args.includes("get-url")) return command("https://github.com/acme/shared.git\n");
    if (args.includes("rev-parse")) return command("shared-sha\n");
    if (args[0] === "-e") return command("", 1);
    return command();
  });
  return {
    runCommand,
    writeFiles: vi.fn().mockResolvedValue(undefined),
  };
}

const emptyManifest: WorkspaceManifestV2 = { version: 2, repositories: [] };

describe("attachResearchRepositories", () => {
  it("clones into server-owned nested paths and atomically extends the trusted manifest", async () => {
    const sandbox = createSandbox();
    const manifest = await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/shared",
          defaultBranch: "main",
          selectedRationale: "shared component dependency",
        },
      ],
      providers: [
        {
          kind: "github",
          host: "https://github.com",
          getToken: vi.fn().mockResolvedValue("token"),
        },
      ],
    });

    expect(manifest.repositories[0]).toMatchObject({
      provider: "github",
      repoPath: "acme/shared",
      localPath: "/vercel/sandbox/repos/github__acme__shared",
      branchName: "main",
      access: "read",
      researchBaseSha: "shared-sha",
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith(
      "mv",
      expect.arrayContaining([
        "/vercel/sandbox/repos/github__acme__shared",
      ]),
    );
    expect(sandbox.writeFiles).toHaveBeenCalledOnce();
  });

  it("is idempotent for repositories already present in the trusted manifest", async () => {
    const sandbox = createSandbox();
    const existing: WorkspaceManifestV2 = {
      version: 2,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/shared",
          slug: "github__acme__shared",
          localPath: "/vercel/sandbox/repos/github__acme__shared",
          defaultBranch: "main",
          branchName: "main",
          selectedRationale: "existing",
          access: "read",
          researchBaseSha: "shared-sha",
        },
      ],
    };

    await expect(attachResearchRepositories({
      sandbox,
      manifest: existing,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/shared",
          defaultBranch: "main",
          selectedRationale: "duplicate request",
        },
      ],
      providers: [],
    })).resolves.toBe(existing);
    expect(sandbox.runCommand).not.toHaveBeenCalled();
  });

  it("rejects unexpected final paths and the eight-repository limit", async () => {
    const sandbox = createSandbox();
    sandbox.runCommand.mockImplementationOnce(async () => command("", 0));

    await expect(attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/shared",
          defaultBranch: "main",
          selectedRationale: "dependency",
        },
      ],
      providers: [
        {
          kind: "github",
          host: "https://github.com",
          getToken: vi.fn().mockResolvedValue("token"),
        },
      ],
    })).rejects.toThrow("Unexpected repository path");

    const fullManifest: WorkspaceManifestV2 = {
      version: 2,
      repositories: Array.from({ length: 8 }, (_, index) => ({
        provider: "github" as const,
        repoPath: `acme/repo-${index}`,
        slug: `github__acme__repo-${index}`,
        localPath: `/vercel/sandbox/repos/github__acme__repo-${index}`,
        defaultBranch: "main",
        branchName: "main",
        selectedRationale: "existing",
        access: "read" as const,
        researchBaseSha: `sha-${index}`,
      })),
    };
    await expect(attachResearchRepositories({
      sandbox: createSandbox(),
      manifest: fullManifest,
      repositories: [
        {
          provider: "github",
          repoPath: "acme/ninth",
          defaultBranch: "main",
          selectedRationale: "too many",
        },
      ],
      providers: [],
    })).rejects.toThrow("at most 8 repositories");
  });

  it("cleans a successful clone when its same-batch sibling fails", async () => {
    const sandbox = createSandbox();

    await expect(
      attachResearchRepositories({
        sandbox,
        manifest: emptyManifest,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/shared",
            defaultBranch: "main",
            selectedRationale: "dependency",
          },
          {
            provider: "gitlab",
            repoPath: "acme/private",
            defaultBranch: "main",
            selectedRationale: "dependency",
          },
        ],
        providers: [
          {
            kind: "github",
            host: "https://github.com",
            getToken: vi.fn().mockResolvedValue("token"),
          },
          {
            kind: "gitlab",
            host: "https://gitlab.com",
            getToken: vi.fn().mockRejectedValue(new Error("token unavailable")),
          },
        ],
      }),
    ).rejects.toThrow("token unavailable");

    expect(sandbox.runCommand).toHaveBeenCalledWith("rm", [
      "-rf",
      "--",
      "/vercel/sandbox/repos/github__acme__shared",
    ]);
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
  });
});

describe("promoteAgentSandboxToWorkspace", () => {
  it("transfers ownership out of the scratch cache without losing cleanup tracking", () => {
    const ctx = {
      agentSandboxIds: { profileA: "sbx-1", profileB: "sbx-2" },
      sandboxIds: new Set(["sbx-1", "sbx-2"]),
      sandboxId: null,
      workspaceManifest: null,
      selectedRepositories: [],
      repositoryContexts: [],
    } as unknown as EngineCtx;
    const manifest: WorkspaceManifestV2 = { version: 2, repositories: [] };

    promoteAgentSandboxToWorkspace(ctx, "sbx-1", {
      manifest,
      repositories: [],
      repositoryContexts: [],
    });

    expect(ctx.agentSandboxIds).toEqual({ profileB: "sbx-2" });
    expect(ctx.sandboxId).toBe("sbx-1");
    expect(ctx.sandboxIds.has("sbx-1")).toBe(true);
    expect(ctx.workspaceManifest).toBe(manifest);
  });
});
