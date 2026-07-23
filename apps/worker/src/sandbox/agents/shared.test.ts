import { describe, it, expect, vi } from "vitest";
import {
  AGENT_ENV_CLAUDE_PATH,
  AGENT_ENV_CODEX_PATH,
  AGENT_ENV_SHIM,
  GLOBAL_SKILLS,
  installSkillsToAgentsDir,
} from "./shared.js";
import { AGENT_CLI_SPECS } from "./protocol.js";

// Sentinel absent -> `test -f` reports exit 1 so the install proceeds.
const notYetInstalled = (cmd: string, args?: string[]) =>
  cmd === "bash" && typeof args?.[1] === "string" && args[1].startsWith("test -f")
    ? { exitCode: 1 }
    : { exitCode: 0 };

describe("GLOBAL_SKILLS", () => {
  it("contains the expected skill repos", () => {
    const ids = GLOBAL_SKILLS.map((s) => `${s.repo}#${s.skill}`);
    expect(ids).toEqual(["https://github.com/anthropics/skills#frontend-design"]);
  });
});

describe("AGENT_ENV_SHIM", () => {
  it("sources both per-provider env files", () => {
    expect(AGENT_ENV_SHIM).toContain(`source ${AGENT_ENV_CLAUDE_PATH}`);
    expect(AGENT_ENV_SHIM).toContain(`source ${AGENT_ENV_CODEX_PATH}`);
  });
});

describe("installSkillsToAgentsDir", () => {
  it("runs `npx skills add <repo> -g --agent claude-code codex --copy` for each entry", async () => {
    const runCommand = vi.fn().mockImplementation((cmd, args) => notYetInstalled(cmd, args));
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const sandbox = { runCommand, writeFiles } as any;

    await installSkillsToAgentsDir(sandbox, AGENT_CLI_SPECS.claude);

    const calls = runCommand.mock.calls.filter((c) => c[0] === "npx");
    expect(calls).toHaveLength(GLOBAL_SKILLS.length);
    for (const [_, args] of calls) {
      expect(args).toContain("skills");
      expect(args).toContain("add");
      expect(args).toContain("-g");
      expect(args).toContain("--agent");
      // Both agent dirs populated in one pass — no symlinks needed.
      expect(args).toContain("claude-code");
      expect(args).toContain("codex");
      expect(args).toContain("--copy");
      expect(args).not.toContain("--target");
    }
  });

  it("touches the sentinel after a successful install", async () => {
    const runCommand = vi.fn().mockImplementation((cmd, args) => notYetInstalled(cmd, args));
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;

    await installSkillsToAgentsDir(sandbox, AGENT_CLI_SPECS.claude);

    const touch = runCommand.mock.calls.find(
      ([cmd, args]) => cmd === "bash" && typeof args?.[1] === "string" && args[1].startsWith("touch"),
    );
    expect(touch).toBeDefined();
    expect(touch![1][1]).toContain(".skills-installed");
  });

  it("skips reinstall when the sentinel already exists", async () => {
    // Sentinel present -> every command returns exit 0, install must be skipped.
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const sandbox = { runCommand, writeFiles: vi.fn() } as any;

    await installSkillsToAgentsDir(sandbox, AGENT_CLI_SPECS.claude);

    expect(runCommand.mock.calls.filter((c) => c[0] === "npx")).toHaveLength(0);
  });
});
