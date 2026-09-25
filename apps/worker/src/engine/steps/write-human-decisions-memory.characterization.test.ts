/**
 * CHARACTERIZATION: what the "Human decisions" section says and where it is
 * written, before stage 10 routes human decisions through the notebook module
 * and has them read the trusted manifest instead of the sandbox's copy.
 *
 * Every expected document is written out by hand, byte for byte, because the
 * section is text a person reads in the stored notebook and an agent reads in
 * its workspace: a move that changes one line changes what both see.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSandbox: vi.fn() }));

vi.mock("@vercel/sandbox", () => ({ Sandbox: { get: mocks.getSandbox } }));
vi.mock("../../sandbox/credentials.js", () => ({ getSandboxCredentials: () => ({}) }));
vi.mock("../../infra/logger.js", () => {
  const log = { warn: vi.fn(), info: vi.fn() };
  return { logger: { ...log, child: () => log } };
});

import { writeHumanDecisionsMemory } from "./write-human-decisions-memory.js";

const MANIFEST_PATH = "/vercel/sandbox/aiw-repos.json";
const ROOT_COPY = "/vercel/sandbox/ai-workflow/memory/AIW-9.md";
const HEADER = [
  "<!-- human-decisions:start -->",
  "## Human decisions (from the dashboard)",
  "",
  "Recorded automatically from the clarification Q&A. Do not edit or remove.",
  "",
];

function repository(localPath: string, slug: string) {
  return {
    provider: "github",
    repoPath: "acme/api",
    slug,
    localPath,
    defaultBranch: "main",
    branchName: "ai/aiw-9",
    selectedRationale: "primary",
    access: "write",
  };
}
const ROOT_LAYOUT = { version: 2, repositories: [repository("/vercel/sandbox", "acme__api")] };
const PROMOTED_LAYOUT = {
  version: 2,
  repositories: [repository("/vercel/sandbox/repos/github__acme__api", "github__acme__api")],
};

function commandResult(exitCode: number, stdout = "") {
  return { exitCode, stdout: async () => stdout, stderr: async () => "" };
}

/** A sandbox holding `files`, recording every command and every write. */
function sandboxWith(files: Record<string, string>) {
  const commands: Array<[string, string[]]> = [];
  const writes: Array<{ path: string; content: string }> = [];
  mocks.getSandbox.mockResolvedValue({
    runCommand: async (command: string, args: string[]) => {
      commands.push([command, args]);
      if (command === "cat") {
        const content = files[args[0] ?? ""];
        return content === undefined ? commandResult(1) : commandResult(0, content);
      }
      return commandResult(0, "");
    },
    writeFiles: async (entries: Array<{ path: string; content: Buffer }>) => {
      for (const entry of entries) writes.push({ path: entry.path, content: entry.content.toString("utf8") });
    },
  });
  return { commands, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what the section says", () => {
  it("renders every round in order with its questions numbered, the answer verbatim, and who and when only when known", async () => {
    const sandbox = sandboxWith({ [MANIFEST_PATH]: JSON.stringify(ROOT_LAYOUT) });

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", [
      { questions: ["Which repository?", "Which branch?"], answer: "api\non main", answeredBy: "Ada" },
      { questions: ["Ship behind a flag?"], answer: "yes, $& and all", answeredAt: "2026-09-21T08:00:00Z" },
      { questions: ["Anything else?"], answer: "<!-- human-decisions:end --> nope" },
    ]);

    expect(sandbox.writes).toEqual([
      {
        path: ROOT_COPY,
        content: [
          "# Session Memory: AIW-9",
          "",
          ...HEADER,
          "### Round 1 (answered by Ada)",
          "1. Which repository?",
          "2. Which branch?",
          "",
          "Answer: api",
          "on main",
          "",
          "### Round 2 (2026-09-21T08:00:00Z)",
          "1. Ship behind a flag?",
          "",
          "Answer: yes, $& and all",
          "",
          "### Round 3",
          "1. Anything else?",
          "",
          "Answer: [human-decisions:end] nope",
          "<!-- human-decisions:end -->",
          "",
        ].join("\n"),
      },
    ]);
  });

  it("replaces the section where it stands on a later write, keeping the notes above and below it", async () => {
    const before = "# Session Memory: AIW-9\n\nnotes above\n\n";
    const after = "\n\nnotes below\n";
    const old = [...HEADER, "### Round 1", "1. Old question?", "", "Answer: old", "<!-- human-decisions:end -->"].join("\n");
    const sandbox = sandboxWith({
      [MANIFEST_PATH]: JSON.stringify(ROOT_LAYOUT),
      [ROOT_COPY]: `${before}${old}${after}`,
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", [{ questions: ["New question?"], answer: "new" }]);

    const fresh = [...HEADER, "### Round 1", "1. New question?", "", "Answer: new", "<!-- human-decisions:end -->"].join("\n");
    expect(sandbox.writes).toEqual([{ path: ROOT_COPY, content: `${before}${fresh}${after}` }]);
  });

  it("appends the section after the agent's notes when the notebook has none yet", async () => {
    const sandbox = sandboxWith({
      [MANIFEST_PATH]: JSON.stringify(ROOT_LAYOUT),
      [ROOT_COPY]: "# Session Memory: AIW-9\n\nnotes\n\n\n",
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", [{ questions: ["Q?"], answer: "A" }]);

    expect(sandbox.writes[0]?.content).toBe(
      ["# Session Memory: AIW-9", "", "notes", "", ...HEADER, "### Round 1", "1. Q?", "", "Answer: A", "<!-- human-decisions:end -->", ""].join("\n"),
    );
  });
});

describe("where the section is written", () => {
  it("writes at the sandbox root, never inside a checkout, even when the only checkout is under repos/", async () => {
    const sandbox = sandboxWith({ [MANIFEST_PATH]: JSON.stringify(PROMOTED_LAYOUT) });

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", [{ questions: ["Q?"], answer: "A" }]);

    expect(sandbox.writes.map((write) => write.path)).toEqual([ROOT_COPY]);
    expect(sandbox.commands).toContainEqual(["mkdir", ["-p", "/vercel/sandbox/ai-workflow/memory"]]);
    // No checkout at the root, so no git probe either.
    expect(sandbox.commands.some(([command]) => command === "git")).toBe(false);
  });

  it("names the file after a pull request subject key too, creating its nested directory", async () => {
    const sandbox = sandboxWith({ [MANIFEST_PATH]: JSON.stringify(PROMOTED_LAYOUT) });

    await writeHumanDecisionsMemory("sbx-1", "pr:github:acme/api#12", [{ questions: ["Q?"], answer: "A" }]);

    expect(sandbox.writes.map((write) => write.path)).toEqual([
      "/vercel/sandbox/ai-workflow/memory/pr:github:acme/api#12.md",
    ]);
    expect(sandbox.commands).toContainEqual(["mkdir", ["-p", "/vercel/sandbox/ai-workflow/memory/pr:github:acme"]]);
  });

  it("never reads a notebook left at the legacy blazebot/memory path, and starts a fresh one at the current path", async () => {
    const sandbox = sandboxWith({
      [MANIFEST_PATH]: JSON.stringify(PROMOTED_LAYOUT),
      "/vercel/sandbox/blazebot/memory/AIW-9.md": "# Session Memory: AIW-9\n\nold notes\n",
    });

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", [{ questions: ["Q?"], answer: "A" }]);

    expect(sandbox.commands.flatMap(([, args]) => args)).not.toContain("/vercel/sandbox/blazebot/memory/AIW-9.md");
    expect(sandbox.writes[0]?.content.startsWith("# Session Memory: AIW-9\n\n<!-- human-decisions:start -->")).toBe(true);
  });

  it("changes in 10: reads the workspace manifest back out of the sandbox, and writes nothing when that copy is missing", async () => {
    const sandbox = sandboxWith({});

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", [{ questions: ["Q?"], answer: "A" }]);

    expect(sandbox.commands[0]).toEqual(["cat", [MANIFEST_PATH]]);
    expect(sandbox.writes).toEqual([]);
  });

  it("writes nothing, and touches no sandbox, for no decisions or a ticket key that walks out of the directory", async () => {
    sandboxWith({ [MANIFEST_PATH]: JSON.stringify(ROOT_LAYOUT) });

    await writeHumanDecisionsMemory("sbx-1", "AIW-9", []);
    await writeHumanDecisionsMemory("sbx-1", "../escape", [{ questions: ["Q?"], answer: "A" }]);

    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });
});
