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

  it("commits into every repository on a V1 manifest", async () => {
    const first = "/vercel/sandbox";
    const second = "/vercel/sandbox/repos/github__acme__web";
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "cat" && args[0] === "/vercel/sandbox/aiw-repos.json") {
        return result(
          0,
          JSON.stringify({
            version: 1,
            repositories: [
              {
                provider: "github",
                repoPath: "acme/api",
                slug: "acme__api",
                localPath: first,
                defaultBranch: "main",
                branchName: "blazebot/aiw-100",
                selectedRationale: "primary",
              },
              {
                provider: "github",
                repoPath: "acme/web",
                slug: "github__acme__web",
                localPath: second,
                defaultBranch: "main",
                branchName: "blazebot/aiw-100",
                selectedRationale: "secondary",
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

    for (const localPath of [first, second]) {
      expect(runCommand).toHaveBeenCalledWith("git", [
        "-C",
        localPath,
        "commit",
        "-m",
        "Record human decisions for AIW-100",
        "--",
        "blazebot/memory/AIW-100.md",
      ]);
    }
  });

  it("commits only into write-access repositories on a V2 manifest", async () => {
    const writeRepoPath = "/vercel/sandbox";
    const readRepoPath = "/vercel/sandbox/repos/github__acme__shared";
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === "cat" && args[0] === "/vercel/sandbox/aiw-repos.json") {
        return result(
          0,
          JSON.stringify({
            version: 2,
            repositories: [
              {
                provider: "github",
                repoPath: "acme/web",
                slug: "acme__web",
                localPath: writeRepoPath,
                defaultBranch: "main",
                branchName: "blazebot/aiw-100",
                selectedRationale: "primary",
                access: "write",
              },
              {
                provider: "github",
                repoPath: "acme/shared",
                slug: "github__acme__shared",
                localPath: readRepoPath,
                defaultBranch: "main",
                branchName: "main",
                selectedRationale: "reference",
                access: "read",
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

    // Write repo receives the commit exactly as before.
    expect(runCommand).toHaveBeenCalledWith("git", [
      "-C",
      writeRepoPath,
      "add",
      "--",
      "blazebot/memory/AIW-100.md",
    ]);
    expect(runCommand).toHaveBeenCalledWith("git", [
      "-C",
      writeRepoPath,
      "commit",
      "-m",
      "Record human decisions for AIW-100",
      "--",
      "blazebot/memory/AIW-100.md",
    ]);

    // Read repo is untouched: no command references its path and no file is
    // written under it, so HEAD cannot move.
    const touchedReadRepo = runCommand.mock.calls.some(([, args]) =>
      (args as string[]).some(
        (arg) => typeof arg === "string" && arg.includes(readRepoPath),
      ),
    );
    expect(touchedReadRepo).toBe(false);
    const wroteReadRepo = writeFiles.mock.calls.some((call) =>
      (call[0] as Array<{ path: string }>).some((file) =>
        file.path.startsWith(readRepoPath),
      ),
    );
    expect(wroteReadRepo).toBe(false);
  });
});
