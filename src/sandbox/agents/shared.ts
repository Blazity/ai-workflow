import type { RunnableSandbox } from "./types.js";

// `skills add --agent claude-code codex` populates BOTH agent dirs in one
// pass: ~/.claude/skills/<skill> and ~/.agents/skills/<skill>. No symlinks
// needed — each agent reads from its own native path.
export const GLOBAL_SKILLS = [
  { repo: "https://github.com/anthropics/skills", skill: "frontend-design" },
] as const;

export async function installSkillsToAgentsDir(sandbox: RunnableSandbox): Promise<void> {
  for (const { repo, skill } of GLOBAL_SKILLS) {
    const result = await sandbox.runCommand("npx", [
      "-y", "skills", "add", repo,
      "--skill", skill,
      "--yes",
      "-g",
      "--agent", "claude-code", "codex",
      "--copy",
    ]);
    if (result.exitCode !== 0) {
      const { logger } = await import("../../lib/logger.js");
      const stderr = await result.stderr().catch(() => "");
      logger.error(
        { repo, skill, exitCode: result.exitCode, output: stderr.slice(0, 500) },
        "skill_install_failed",
      );
      throw new Error(`Failed to install skill ${skill} from ${repo} (exit ${result.exitCode})`);
    }
  }
}

/** Bash body for the commit-guard hook. The output protocol differs between agents,
 *  so each adapter wraps this differently. */
export const COMMIT_GUARD_CHECK_SH = [
  "input=$(cat)",
  // Skip when re-entered (set by Claude as stop_hook_active, by us as already_blocked for Codex)
  `if echo "$input" | grep -q -E '"stop_hook_active":true|"already_blocked":true'; then exit 0; fi`,
  // Ignore changes inside ~/.claude/ or ~/.codex/ inside the workspace
  `changes=$(git status --porcelain | grep -v -E '^.. \\.(claude|codex)/' | grep -v -E '^\\?\\? \\.(claude|codex)/' || true)`,
].join("\n");
