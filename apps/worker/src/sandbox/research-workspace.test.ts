import { describe, expect, it, vi } from "vitest";
import type { EngineCtx } from "../workflows/blocks/types.js";
import { MEMORY_PRE_COMMIT_HOOK } from "./git-excludes.js";
import {
  attachResearchRepositories,
  materializeResearchRepositories,
  promoteAgentSandboxToWorkspace,
} from "./research-workspace.js";
import type { WorkspaceManifestV2 } from "./repo-workspace.js";
import type { WorkspaceRepositoryInput } from "./repo-workspace.js";

function command(stdout = "", exitCode = 0, stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

function createSandbox(initialPaths: string[] = []) {
  const existing = new Set(initialPaths);
  const runCommand = vi.fn(async (name: string, args: string[]) => {
    if (args.includes("get-url")) return command("https://github.com/acme/shared.git\n");
    if (args.includes("rev-parse")) return command("shared-sha\n");
    if (name === "realpath") return command(`${args[0]}\n`);
    if (name === "test" && args[0] === "-L") return command("", 1);
    if (name === "test" && args[0] === "-e") {
      return command("", existing.has(args[1]!) ? 0 : 1);
    }
    if (name === "mkdir") existing.add(args[0]!);
    if (name === "mv") {
      existing.delete(args[0]!);
      existing.add(args[1]!);
    }
    if (name === "rm") {
      for (const path of args.slice(3)) existing.delete(path);
    }
    return command();
  });
  return {
    runCommand,
    writeFiles: vi.fn().mockResolvedValue(undefined),
  };
}

// Same command mock as createSandbox, but every runCommand increments a shared
// active counter, yields the event loop, then decrements. Because each attachOne
// runs its commands sequentially, the peak counter equals the number of attachOne
// operations executing at once, so it directly measures attach concurrency.
function createConcurrencyTrackingSandbox(initialPaths: string[] = []) {
  const existing = new Set(initialPaths);
  let active = 0;
  let maxActive = 0;
  const runCommand = vi.fn(async (name: string, args: string[]) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    // Yield so same-batch attach operations overlap here before the counter drops.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      if (args.includes("get-url")) return command("https://github.com/acme/shared.git\n");
      if (args.includes("rev-parse")) return command("shared-sha\n");
      if (name === "realpath") return command(`${args[0]}\n`);
      if (name === "test" && args[0] === "-L") return command("", 1);
      if (name === "test" && args[0] === "-e") {
        return command("", existing.has(args[1]!) ? 0 : 1);
      }
      if (name === "mkdir") existing.add(args[0]!);
      if (name === "mv") {
        existing.delete(args[0]!);
        existing.add(args[1]!);
      }
      if (name === "rm") {
        for (const path of args.slice(3)) existing.delete(path);
      }
      return command();
    } finally {
      active -= 1;
    }
  });
  return {
    runCommand,
    writeFiles: vi.fn().mockResolvedValue(undefined),
    maxConcurrent: () => maxActive,
  };
}

// Attach verifies each clone's origin against the artifact's cloneUrl. The
// temp checkout path is a random uuid, so the git origin cannot be keyed on the
// repository; instead the mock returns the batch's cloneUrls in attach order,
// which is the artifact order. HEAD is fixed so it matches researchBaseSha.
function createMixedAttachSandbox(cloneUrls: string[]) {
  const pendingCloneUrls = [...cloneUrls];
  const existing = new Set(["/vercel/sandbox/repos"]);
  const runCommand = vi.fn(async (name: string, args: string[]) => {
    if (args.includes("get-url")) return command(`${pendingCloneUrls.shift() ?? ""}\n`);
    if (args.includes("rev-parse")) return command("shared-sha\n");
    if (name === "realpath") return command(`${args[0]}\n`);
    if (name === "test" && args[0] === "-L") return command("", 1);
    if (name === "test" && args[0] === "-e") {
      return command("", existing.has(args[1]!) ? 0 : 1);
    }
    if (name === "mkdir") existing.add(args[0]!);
    if (name === "mv") {
      existing.delete(args[0]!);
      existing.add(args[1]!);
    }
    if (name === "rm") {
      for (const path of args.slice(3)) existing.delete(path);
    }
    return command();
  });
  return {
    runCommand,
    writeFiles: vi.fn().mockResolvedValue(undefined),
  };
}

const emptyManifest: WorkspaceManifestV2 = { version: 2, repositories: [] };
const selected = {
  provider: "github" as const,
  repoPath: "acme/shared",
  defaultBranch: "main",
  selectedRationale: "shared component dependency",
};
function artifact(repository: WorkspaceRepositoryInput = selected) {
  return {
    repository,
    archive: Buffer.from("archive"),
    cloneUrl: `https://github.com/${repository.repoPath}.git`,
    researchBaseSha: "shared-sha",
    commitAuthor: "ai-workflow-blazity",
    commitEmail: "ai-workflow@blazity.com",
  };
}

describe("attachResearchRepositories", () => {
  it("clones into server-owned nested paths and atomically extends the trusted manifest", async () => {
    const sandbox = createSandbox();
    const manifest = await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
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
    // Runtime excludes, the repository archive, the commit hook, then the
    // manifest swap.
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(4);
    expect(sandbox.writeFiles).toHaveBeenLastCalledWith([
      expect.objectContaining({
        path: expect.stringContaining("aiw-repos.json.tmp-"),
      }),
    ]);
  });

  it("gives the promoted checkout the same runtime excludes as provisioning", async () => {
    const sandbox = createSandbox();

    await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    });

    const excludeWrite = sandbox.writeFiles.mock.calls
      .flatMap(([files]) => files)
      .find(
        (file: { path: string }) => file.path === "/tmp/aiw-primary-git-excludes",
      );
    expect(excludeWrite?.content.toString("utf8")).toBe(
      "/aiw-repos.json\n/repos/\n/ai-workflow/memory/\n/blazebot/memory/\n",
    );
    expect(sandbox.runCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/github__acme__shared",
      "config",
      "--local",
      "core.excludesFile",
      "/tmp/aiw-primary-git-excludes",
    ]);
  });

  it("installs the executable memory pre-commit hook on the promoted checkout", async () => {
    const sandbox = createSandbox();

    await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    });

    const hookPath =
      "/vercel/sandbox/repos/github__acme__shared/.git/hooks/pre-commit";
    const hookWrite = sandbox.writeFiles.mock.calls
      .flatMap(([files]) => files)
      .find((file: { path: string }) => file.path === hookPath);
    expect(hookWrite?.content.toString("utf8")).toBe(MEMORY_PRE_COMMIT_HOOK);
    expect(sandbox.runCommand).toHaveBeenCalledWith("chmod", ["+x", hookPath]);
  });

  it("attaches the checkout even when the hook cannot be made executable", async () => {
    // The commit hook is defense in depth, so a chmod failure must not fail the
    // attach: without the best-effort outcome the rejected attachOne would tear
    // down the freshly attached workspace.
    const sandbox = createSandbox();
    const inner = sandbox.runCommand.getMockImplementation()!;
    sandbox.runCommand.mockImplementation(async (name: string, args: string[]) =>
      name === "chmod" ? command("", 1) : inner(name, args),
    );

    const manifest = await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    });

    expect(manifest.repositories).toHaveLength(1);
    expect(manifest.repositories[0]).toMatchObject({
      repoPath: "acme/shared",
      localPath: "/vercel/sandbox/repos/github__acme__shared",
    });
  });

  it("never runs more than two attach operations concurrently for four repositories", async () => {
    const sandbox = createConcurrencyTrackingSandbox(["/vercel/sandbox/repos"]);
    // All four artifacts share the mock's fixed origin URL and HEAD so every
    // attach verification passes; only the repoPath (and thus slug/localPath)
    // differs, keeping the four manifest entries distinct.
    const artifacts = Array.from({ length: 4 }, (_, index) => ({
      repository: {
        provider: "github" as const,
        repoPath: `acme/repo-${index}`,
        defaultBranch: "main",
        selectedRationale: "batch attach",
      },
      archive: Buffer.from("archive"),
      cloneUrl: "https://github.com/acme/shared.git",
      researchBaseSha: "shared-sha",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "ai-workflow@blazity.com",
    }));

    const manifest = await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts,
    });

    expect(manifest.repositories).toHaveLength(4);
    expect(sandbox.maxConcurrent()).toBe(2);
  });

  it("is idempotent for repositories already present in the trusted manifest", async () => {
    const sandbox = createSandbox([
      "/vercel/sandbox/repos",
      "/vercel/sandbox/repos/github__acme__shared",
    ]);
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
      artifacts: [artifact({ ...selected, selectedRationale: "duplicate request" })],
    })).resolves.toBe(existing);
    expect(sandbox.writeFiles).not.toHaveBeenCalled();
    expect(sandbox.runCommand).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["remote", "get-url", "origin"]),
    );
  });

  it("clears a leftover final path from a crashed attach and re-clones once", async () => {
    const localPath = "/vercel/sandbox/repos/github__acme__shared";
    const sandbox = createSandbox(["/vercel/sandbox/repos", localPath]);

    const manifest = await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    });

    expect(sandbox.runCommand).toHaveBeenCalledWith("rm", ["-rf", "--", localPath]);
    expect(manifest.repositories[0]).toMatchObject({
      provider: "github",
      repoPath: "acme/shared",
      localPath,
      access: "read",
      researchBaseSha: "shared-sha",
    });
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(4);
    expect(sandbox.writeFiles).toHaveBeenLastCalledWith([
      expect.objectContaining({
        path: expect.stringContaining("aiw-repos.json.tmp-"),
      }),
    ]);
  });

  it("hard-fails a leftover final path that is a symlink", async () => {
    const localPath = "/vercel/sandbox/repos/github__acme__shared";
    const sandbox = createSandbox(["/vercel/sandbox/repos", localPath]);
    sandbox.runCommand.mockImplementation(async (name: string, args: string[]) => {
      if (name === "test" && args[0] === "-L") {
        return command("", args[1] === localPath ? 0 : 1);
      }
      if (name === "test" && args[0] === "-e") return command("", 0);
      if (name === "realpath") return command(`${args[0]}\n`);
      return command();
    });

    await expect(attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    })).rejects.toThrow("must not be a symlink");

    expect(
      sandbox.runCommand.mock.calls.some(([name]) => name === "tar"),
    ).toBe(false);
    expect(
      sandbox.runCommand.mock.calls.some(
        ([name, args]) => name === "rm" && (args as string[]).includes(localPath),
      ),
    ).toBe(false);
  });

  it("rejects attaching beyond the eight-repository limit", async () => {
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
      artifacts: [artifact({ ...selected, repoPath: "acme/ninth" })],
    })).rejects.toThrow("at most 8 repositories");
  });

  it("cleans a successful clone when its same-batch sibling fails", async () => {
    const sandbox = createSandbox();

    await expect(
      attachResearchRepositories({
        sandbox,
        manifest: emptyManifest,
        artifacts: [
          artifact(),
          artifact({
            ...selected,
            provider: "gitlab",
            repoPath: "acme/private",
          }),
        ],
      }),
    ).rejects.toThrow("remote verification");

    expect(sandbox.runCommand).toHaveBeenCalledWith("rm", [
      "-rf",
      "--",
      "/vercel/sandbox/repos/github__acme__shared",
    ]);
    expect(
      sandbox.writeFiles.mock.calls.flatMap(([files]) => files)
        .some((file) => file.path.includes("aiw-repos.json.tmp-")),
    ).toBe(false);
  });

  it("rejects a symlinked repository workspace before extracting an archive", async () => {
    const sandbox = createSandbox();
    sandbox.runCommand.mockImplementationOnce(async () => command("", 0));

    await expect(attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    })).rejects.toThrow("must not be a symlink");

    expect(
      sandbox.runCommand.mock.calls.some(([name]) => name === "tar"),
    ).toBe(false);
  });

  it("configures git identity on the attached checkout like manager provisioning", async () => {
    const sandbox = createSandbox();

    await attachResearchRepositories({
      sandbox,
      manifest: emptyManifest,
      artifacts: [artifact()],
    });

    const localPath = "/vercel/sandbox/repos/github__acme__shared";
    expect(sandbox.runCommand).toHaveBeenCalledWith("git", [
      "-C",
      localPath,
      "config",
      "user.name",
      "ai-workflow-blazity",
    ]);
    expect(sandbox.runCommand).toHaveBeenCalledWith("git", [
      "-C",
      localPath,
      "config",
      "user.email",
      "ai-workflow@blazity.com",
    ]);
  });
});

describe("materializeResearchRepositories", () => {
  it("uses credentials only in the isolated materializer and returns scrubbed artifacts", async () => {
    const sandbox = {
      runCommand: vi.fn(async (_name: string, args: string[]) => {
        if (args.includes("rev-parse")) return command("shared-sha\n");
        return command();
      }),
      writeFiles: vi.fn(),
      readFileToBuffer: vi.fn().mockResolvedValue(Buffer.from("archive")),
    };
    const artifacts = await materializeResearchRepositories({
      sandbox,
      repositories: [selected],
      providers: [{
        kind: "github",
        host: "https://github.com",
        getToken: vi.fn().mockResolvedValue("secret-token"),
        commitAuthor: "ai-workflow-blazity",
        commitEmail: "ai-workflow@blazity.com",
      }],
    });

    expect(artifacts[0]).toMatchObject({
      cloneUrl: "https://github.com/acme/shared.git",
      researchBaseSha: "shared-sha",
      commitAuthor: "ai-workflow-blazity",
      commitEmail: "ai-workflow@blazity.com",
    });
    expect(
      sandbox.runCommand.mock.calls.flatMap(([, args]) => args).join(" "),
    ).toContain("AUTHORIZATION");
  });
});

describe("mixed-provider research workspace", () => {
  it("materializes and attaches a github and a gitlab repository in one batch", async () => {
    const githubRepository: WorkspaceRepositoryInput = {
      provider: "github",
      repoPath: "acme/api",
      defaultBranch: "main",
      selectedRationale: "primary implementation target",
    };
    const gitlabRepository: WorkspaceRepositoryInput = {
      provider: "gitlab",
      repoPath: "acme/contracts",
      defaultBranch: "main",
      selectedRationale: "shared contract dependency",
    };
    const providers = [
      {
        kind: "github" as const,
        host: "https://github.com",
        getToken: vi.fn().mockResolvedValue("github-token"),
        commitAuthor: "ai-workflow-blazity",
        commitEmail: "ai-workflow@blazity.com",
      },
      {
        kind: "gitlab" as const,
        host: "https://gitlab.com",
        getToken: vi.fn().mockResolvedValue("gitlab-token"),
        commitAuthor: "ai-workflow-blazity",
        commitEmail: "ai-workflow@blazity.com",
      },
    ];
    const materializeSandbox = {
      runCommand: vi.fn(async (_name: string, args: string[]) => {
        if (args.includes("rev-parse")) return command("shared-sha\n");
        return command();
      }),
      writeFiles: vi.fn(),
      readFileToBuffer: vi.fn().mockResolvedValue(Buffer.from("archive")),
    };

    const artifacts = await materializeResearchRepositories({
      sandbox: materializeSandbox,
      repositories: [githubRepository, gitlabRepository],
      providers,
    });

    // Each clone reaches its own provider's host with that provider's auth
    // (github uses x-access-token, gitlab uses oauth2), so credentials never
    // cross providers.
    const cloneCalls = materializeSandbox.runCommand.mock.calls.filter(
      ([name, args]) => name === "git" && (args as string[]).includes("clone"),
    );
    const githubClone = cloneCalls.find(([, args]) =>
      (args as string[]).includes("https://github.com/acme/api.git"),
    );
    const gitlabClone = cloneCalls.find(([, args]) =>
      (args as string[]).includes("https://gitlab.com/acme/contracts.git"),
    );
    expect(githubClone?.[1]).toContain(
      `http.extraHeader=AUTHORIZATION: Basic ${Buffer.from("x-access-token:github-token").toString("base64")}`,
    );
    expect(gitlabClone?.[1]).toContain(
      `http.extraHeader=AUTHORIZATION: Basic ${Buffer.from("oauth2:gitlab-token").toString("base64")}`,
    );

    const attachSandbox = createMixedAttachSandbox(
      artifacts.map((materialized) => materialized.cloneUrl),
    );
    const manifest = await attachResearchRepositories({
      sandbox: attachSandbox,
      manifest: emptyManifest,
      artifacts,
    });

    expect(manifest.repositories).toHaveLength(2);
    const byPath = Object.fromEntries(
      manifest.repositories.map((repository) => [repository.repoPath, repository]),
    );
    expect(byPath["acme/api"]).toMatchObject({
      provider: "github",
      slug: "github__acme__api",
      localPath: "/vercel/sandbox/repos/github__acme__api",
      access: "read",
      researchBaseSha: "shared-sha",
    });
    expect(byPath["acme/contracts"]).toMatchObject({
      provider: "gitlab",
      slug: "gitlab__acme__contracts",
      localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
      access: "read",
      researchBaseSha: "shared-sha",
    });
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
