import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_MANIFEST_PATH } from "../../sandbox/repo-workspace.js";

const mocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
  sandboxGet: vi.fn(),
}));

vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.sandboxGet } }));

import { inspectFixWorkspace, resolvedFixConflicts } from "./fix-workspace-state.js";

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
});
