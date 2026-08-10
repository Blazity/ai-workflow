import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_MANIFEST_PATH } from "../../sandbox/repo-workspace.js";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  sandboxGet: vi.fn(),
}));

vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));

import {
  inspectFixWorkspace,
  resolvedFixConflicts,
  restoreReadOnlyFixRepositories,
} from "./fix-workspace-state.js";

const result = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout: vi.fn().mockResolvedValue(stdout),
  stderr: vi.fn().mockResolvedValue(""),
});

describe("Fix workspace state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sandboxGet.mockResolvedValue({ runCommand: mocks.runCommand });
    mocks.runCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "cat" && args[0] === WORKSPACE_MANIFEST_PATH) {
        return result(
          JSON.stringify({
            version: 1,
            repositories: [
              {
                provider: "github",
                repoPath: "acme/api",
                slug: "acme__api",
                localPath: "/vercel/sandbox",
                defaultBranch: "main",
                branchName: "blazebot/awt-1",
                selectedRationale: "ticket",
                preAgentSha: "base123",
              },
            ],
          }),
        );
      }
      if (cmd === "git" && args.includes("rev-list")) return result("fix1\nfix2\n");
      if (cmd === "git" && args.includes("--diff-filter=U")) return result("src/conflict.ts\n");
      return result("");
    });
  });

  it("reports commits since the workspace baseline and unresolved conflict files", async () => {
    await expect(inspectFixWorkspace("sbx-1")).resolves.toEqual({
      commits: [
        { provider: "github", repoPath: "acme/api", sha: "fix1" },
        { provider: "github", repoPath: "acme/api", sha: "fix2" },
      ],
      unresolvedConflicts: [
        { provider: "github", repoPath: "acme/api", files: ["src/conflict.ts"] },
      ],
    });
  });

  it("returns only conflict files that disappeared during the Fix phase", () => {
    expect(
      resolvedFixConflicts(
        {
          commits: [],
          unresolvedConflicts: [
            { provider: "github", repoPath: "acme/api", files: ["a.ts", "b.ts"] },
          ],
        },
        {
          commits: [],
          unresolvedConflicts: [
            { provider: "github", repoPath: "acme/api", files: ["b.ts"] },
          ],
        },
      ),
    ).toEqual([{ provider: "github", repoPath: "acme/api", files: ["a.ts"] }]);
  });

  it("restores tracked changes in read-only repositories to their trusted baselines", async () => {
    mocks.runCommand.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd !== "git") return result("");
      if (args.includes("reset")) return result("");
      if (args.includes("rev-parse")) return result("read-base\n");
      if (args.includes("status")) return result("");
      return result("");
    });

    await expect(
      restoreReadOnlyFixRepositories("sbx-1", {
        version: 2,
        repositories: [
          {
            provider: "github",
            repoPath: "acme/api",
            slug: "acme__api",
            localPath: "/vercel/sandbox",
            defaultBranch: "main",
            branchName: "ai-workflow/AIW-1",
            selectedRationale: "current PR",
            access: "write",
          },
          {
            provider: "gitlab",
            repoPath: "acme/contracts",
            slug: "gitlab__acme__contracts",
            localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
            defaultBranch: "main",
            branchName: "main",
            selectedRationale: "sibling PR",
            access: "read",
            researchBaseSha: "read-base",
          },
        ],
      }),
    ).resolves.toEqual(["gitlab:acme/contracts"]);

    expect(mocks.runCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox/repos/gitlab__acme__contracts",
      "reset",
      "--hard",
      "read-base",
    ]);
  });

  it("fails closed when a read-only repository has no trusted baseline", async () => {
    await expect(
      restoreReadOnlyFixRepositories("sbx-1", {
        version: 2,
        repositories: [
          {
            provider: "gitlab",
            repoPath: "acme/contracts",
            slug: "gitlab__acme__contracts",
            localPath: "/vercel/sandbox/repos/gitlab__acme__contracts",
            defaultBranch: "main",
            branchName: "main",
            selectedRationale: "sibling PR",
            access: "read",
          },
        ],
      }),
    ).rejects.toThrow(/missing its research baseline/i);
  });
});
