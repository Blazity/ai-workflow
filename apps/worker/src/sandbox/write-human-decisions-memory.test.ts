import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get: mocks.getSandbox },
}));

import { writeHumanDecisionsMemory } from "./write-human-decisions-memory.js";

function result(exitCode: number, stdout = "", stderr = "") {
  return {
    exitCode,
    stdout: vi.fn().mockResolvedValue(stdout),
    stderr: vi.fn().mockResolvedValue(stderr),
  };
}

describe("writeHumanDecisionsMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("commits each changed memory file before publication preflight", async () => {
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "cat" && args[0] === "/vercel/sandbox/aiw-repos.json") {
        return result(
          0,
          JSON.stringify({
            version: 1,
            repositories: [
              {
                provider: "github",
                repoPath: "acme/web",
                slug: "acme__web",
                localPath: "/vercel/sandbox",
                defaultBranch: "main",
                branchName: "blazebot/aiw-100",
                selectedRationale: "primary",
              },
            ],
          }),
        );
      }
      if (command === "cat") return result(1);
      if (command === "git" && args.includes("status")) {
        return result(0, "?? blazebot/memory/AIW-100.md");
      }
      return result(0);
    });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    mocks.getSandbox.mockResolvedValue({ runCommand, writeFiles });

    await writeHumanDecisionsMemory("sbx-1", "AIW-100", [
      { questions: ["Which flavor?"], answer: "vanilla" },
    ]);

    expect(runCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "add",
      "--",
      "blazebot/memory/AIW-100.md",
    ]);
    expect(runCommand).toHaveBeenCalledWith("git", [
      "-C",
      "/vercel/sandbox",
      "commit",
      "-m",
      "Record human decisions for AIW-100",
      "--",
      "blazebot/memory/AIW-100.md",
    ]);
  });
});
