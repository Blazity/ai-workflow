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

const ROOT = "/vercel/sandbox";
const SECOND = "/vercel/sandbox/repos/github__acme__web";

function manifest(repositories: Array<Record<string, unknown>>) {
  return JSON.stringify({ version: 1, repositories });
}

function repository(localPath: string, repoPath: string, slug: string) {
  return {
    provider: "github",
    repoPath,
    slug,
    localPath,
    defaultBranch: "main",
    branchName: "blazebot/aiw-100",
    selectedRationale: "primary",
  };
}

/** Command mock for a workspace whose manifest is `repositories`. `tracked` is
 * the stdout of the `git ls-files` probe. */
function createSandbox(options: {
  repositories: Array<Record<string, unknown>>;
  tracked?: string;
  trackedExitCode?: number;
  existingDocument?: string;
}) {
  const runCommand = vi.fn(async (command: string, args: string[]) => {
    if (command === "cat" && args[0] === "/vercel/sandbox/aiw-repos.json") {
      return result(0, manifest(options.repositories));
    }
    if (command === "cat") {
      return options.existingDocument === undefined
        ? result(1)
        : result(0, options.existingDocument);
    }
    if (command === "git" && args.includes("ls-files")) {
      return result(options.trackedExitCode ?? 0, options.tracked ?? "");
    }
    return result(0);
  });
  const writeFiles = vi.fn().mockResolvedValue(undefined);
  mocks.getSandbox.mockResolvedValue({ runCommand, writeFiles });
  return { runCommand, writeFiles };
}

const clarifications = [{ questions: ["Which flavor?"], answer: "vanilla" }];

describe("writeHumanDecisionsMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes one document at the agent cwd and never touches git history", async () => {
    const { runCommand, writeFiles } = createSandbox({
      repositories: [
        repository(ROOT, "acme/api", "acme__api"),
        repository(SECOND, "acme/web", "github__acme__web"),
      ],
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-100", clarifications);

    expect(writeFiles).toHaveBeenCalledTimes(1);
    const written = writeFiles.mock.calls[0]![0] as Array<{
      path: string;
      content: Buffer;
    }>;
    expect(written.map((file) => file.path)).toEqual([
      "/vercel/sandbox/blazebot/memory/AIW-100.md",
    ]);
    expect(written[0]!.content.toString("utf8")).toContain("Answer: vanilla");
    expect(runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/blazebot/memory",
    ]);
    // The tracked-file probe is the only git command left: no add, no commit,
    // no status.
    const gitCalls = runCommand.mock.calls.filter(([command]) => command === "git");
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]![1]).toEqual([
      "-C",
      ROOT,
      "ls-files",
      "--",
      "blazebot/memory/AIW-100.md",
    ]);
    // Nothing under the secondary checkout is read or written.
    expect(
      runCommand.mock.calls.some(([, args]) =>
        (args as string[]).some((arg) => arg.includes(SECOND)),
      ),
    ).toBe(false);
  });

  it("preserves an existing document and upserts the section in place", async () => {
    const { writeFiles } = createSandbox({
      repositories: [repository(ROOT, "acme/api", "acme__api")],
      existingDocument: "# Session Memory: AIW-100\n\n## Progress\n- earlier work\n",
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-100", clarifications);

    const written = writeFiles.mock.calls[0]![0] as Array<{ content: Buffer }>;
    const text = written[0]!.content.toString("utf8");
    expect(text).toContain("- earlier work");
    expect(text).toContain("<!-- human-decisions:start -->");
  });

  it("skips the write when the root repository tracks the document", async () => {
    const { writeFiles } = createSandbox({
      repositories: [repository(ROOT, "acme/api", "acme__api")],
      tracked: "blazebot/memory/AIW-100.md\n",
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-100", clarifications);

    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("fails closed when the tracked-file probe fails", async () => {
    const { writeFiles } = createSandbox({
      repositories: [repository(ROOT, "acme/api", "acme__api")],
      trackedExitCode: 128,
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-100", clarifications);

    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("writes without probing when no repository is checked out at the cwd", async () => {
    const { runCommand, writeFiles } = createSandbox({
      repositories: [repository(SECOND, "acme/web", "github__acme__web")],
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-100", clarifications);

    expect(
      runCommand.mock.calls.some(([command]) => command === "git"),
    ).toBe(false);
    expect(writeFiles).toHaveBeenCalledTimes(1);
    expect(
      (writeFiles.mock.calls[0]![0] as Array<{ path: string }>)[0]!.path,
    ).toBe("/vercel/sandbox/blazebot/memory/AIW-100.md");
  });

  it("creates the nested parent directory of a PR-trigger identifier", async () => {
    const { runCommand, writeFiles } = createSandbox({
      repositories: [repository(ROOT, "acme/api", "acme__api")],
    });

    await writeHumanDecisionsMemory("sbx-1", "pr/github/acme/web/12", clarifications);

    expect(runCommand).toHaveBeenCalledWith("mkdir", [
      "-p",
      "/vercel/sandbox/blazebot/memory/pr/github/acme/web",
    ]);
    expect(
      (writeFiles.mock.calls[0]![0] as Array<{ path: string }>)[0]!.path,
    ).toBe("/vercel/sandbox/blazebot/memory/pr/github/acme/web/12.md");
  });
});
