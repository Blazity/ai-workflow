/**
 * Debug script: provisions a bare sandbox, installs skills globally, and dumps the results.
 * Uses Vercel OIDC for sandbox auth — no repo needed.
 *
 * Usage:
 *   npx tsx scripts/test-sandbox-skills.ts
 */

import { Sandbox } from "@vercel/sandbox";

const INJECTED_SKILLS = [
  { repo: "https://github.com/obra/superpowers", skill: "using-superpowers" },
  { repo: "https://github.com/obra/superpowers", skill: "requesting-code-review" },
  { repo: "https://github.com/anthropics/skills", skill: "frontend-design" },
];

async function main() {
  console.log("\n=== Provisioning sandbox ===\n");

  const sandbox = await Sandbox.create({
    runtime: "node24",
    timeout: 300_000,
  });

  console.log("Sandbox created.\n");

  await sandbox.runCommand("bash", ["-c", "git init && git commit --allow-empty -m 'init'"]);

  console.log("=== Installing Claude Code ===");
  const installCC = await sandbox.runCommand("npm", [
    "install",
    "-g",
    "@anthropic-ai/claude-code",
  ]);
  console.log("stdout:", (await installCC.stdout()).slice(-200));
  console.log("stderr:", (await installCC.stderr()).slice(-200));

  for (const { repo, skill } of INJECTED_SKILLS) {
    console.log(`\n=== Installing skill globally: ${skill} ===`);
    const result = await sandbox.runCommand("npx", [
      "-y", "skills", "add", repo, "--skill", skill, "--yes", "-g",
    ]);
    console.log("stdout:", (await result.stdout()).slice(-300) || "(empty)");
    console.log("stderr:", (await result.stderr()).slice(-300) || "(empty)");
  }

  console.log("\n=== .claude/skills/ (project) ===");
  const projectSkills = await sandbox.runCommand("bash", [
    "-c",
    "ls -laR .claude/skills/ 2>/dev/null || echo '(directory does not exist)'",
  ]);
  console.log(await projectSkills.stdout());

  console.log("=== skills-lock.json (project) ===");
  const lock = await sandbox.runCommand("bash", [
    "-c",
    "cat skills-lock.json 2>/dev/null || echo '(file does not exist)'",
  ]);
  console.log(await lock.stdout());

  console.log("=== ~/.claude/skills/ (global) ===");
  const globalSkills = await sandbox.runCommand("bash", [
    "-c",
    "ls -laR ~/.claude/skills/ 2>/dev/null || echo '(directory does not exist)'",
  ]);
  console.log(await globalSkills.stdout());

  console.log("=== Find all SKILL.md files (everywhere) ===");
  const skillFiles = await sandbox.runCommand("bash", [
    "-c",
    "find / -name 'SKILL.md' -not -path '*/node_modules/*' 2>/dev/null || echo '(none found)'",
  ]);
  console.log(await skillFiles.stdout());

  console.log("\n=== Stopping sandbox ===");
  await sandbox.stop();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
