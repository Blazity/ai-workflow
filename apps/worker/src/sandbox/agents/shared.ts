import type { AgentCliSpec, RunnableSandbox } from "./types.js";

// Auth env is split per provider so configuring one adapter never clobbers the
// other's file. Every consumer keeps sourcing AGENT_ENV_PATH; the shim written
// there sources whichever per-provider files exist.
export const AGENT_ENV_PATH = "/tmp/agent-env.sh";
export const AGENT_ENV_CLAUDE_PATH = "/tmp/agent-env.claude.sh";
export const AGENT_ENV_CODEX_PATH = "/tmp/agent-env.codex.sh";

export const AGENT_ENV_SHIM =
  `[ -f ${AGENT_ENV_CLAUDE_PATH} ] && source ${AGENT_ENV_CLAUDE_PATH}\n` +
  `[ -f ${AGENT_ENV_CODEX_PATH} ] && source ${AGENT_ENV_CODEX_PATH}\n`;

// One-pass sentinel: configuring both adapters on the same sandbox must not run
// `skills add` twice.
const SKILLS_SENTINEL = "/tmp/.skills-installed";

// `skills add --agent claude-code codex` populates BOTH agent dirs in one
// pass: ~/.claude/skills/<skill> and ~/.agents/skills/<skill>. No symlinks
// needed — each agent reads from its own native path.
export const GLOBAL_SKILLS = [
  { repo: "https://github.com/anthropics/skills", skill: "frontend-design" },
] as const;

export async function installSkillsToAgentsDir(
  sandbox: RunnableSandbox,
  spec: AgentCliSpec,
): Promise<void> {
  const { requireProviderSetup } = await import("./protocol.js");
  const already = await sandbox.runCommand("bash", ["-c", `test -f ${SKILLS_SENTINEL}`]);
  if (already.exitCode === 0) return;

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
      await requireProviderSetup(result, spec, `Agent skill setup (${skill} from ${repo})`);
    }
  }

  const markInstalled = await sandbox.runCommand("bash", [
    "-c",
    `touch ${SKILLS_SENTINEL}`,
  ]);
  await requireProviderSetup(markInstalled, spec, "Agent skill setup sentinel");
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
