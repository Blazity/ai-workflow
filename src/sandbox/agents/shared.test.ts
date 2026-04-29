import { describe, it, expect, vi } from "vitest";
import { GLOBAL_SKILLS, installSkillsToAgentsDir } from "./shared.js";

describe("GLOBAL_SKILLS", () => {
  it("contains the expected skill repos", () => {
    const ids = GLOBAL_SKILLS.map((s) => `${s.repo}#${s.skill}`);
    expect(ids).toEqual(["https://github.com/anthropics/skills#frontend-design"]);
  });
});

describe("installSkillsToAgentsDir", () => {
  it("runs `npx skills add <repo> -g --agent claude-code codex --copy` for each entry", async () => {
    const runCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
    const writeFiles = vi.fn().mockResolvedValue(undefined);
    const sandbox = { runCommand, writeFiles } as any;

    await installSkillsToAgentsDir(sandbox);

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
});
