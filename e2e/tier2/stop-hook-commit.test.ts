import { describe, it, expect, afterAll } from "vitest";
import { e2eEnv } from "../env.js";

/**
 * Verifies the Stop hook forces Claude Code to commit uncommitted changes
 * before exiting in --print mode.
 *
 * Flow:
 *   1. Create a sandbox from the e2e repo
 *   2. Install Claude Code + configure the Stop hook
 *   3. Create an uncommitted file
 *   4. Run Claude Code with a simple prompt (--print mode)
 *   5. Assert git status is clean (hook forced a commit)
 */
describe("Stop hook commit guard", () => {
  let sandbox: any;

  afterAll(async () => {
    if (sandbox) await sandbox.stop().catch(() => {});
  });

  it("forces Claude Code to commit uncommitted changes before stopping", async () => {
    const { Sandbox } = await import("@vercel/sandbox");

    sandbox = await Sandbox.create({
      source: {
        type: "git",
        url: `https://github.com/${e2eEnv.E2E_GITHUB_OWNER}/${e2eEnv.E2E_GITHUB_REPO}.git`,
        username: "x-access-token",
        password: e2eEnv.E2E_GITHUB_TOKEN,
        revision: "main",
        depth: 1,
      },
      runtime: "node24",
      timeout: 300_000,
      env: {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN
          ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
          : {}),
      },
    });

    // 1. Configure git identity
    await sandbox.runCommand("bash", [
      "-c",
      'git config user.name "test-bot" && git config user.email "test@test.com"',
    ]);

    // 2. Install Claude Code
    await sandbox.runCommand("npm", [
      "install",
      "-g",
      "@anthropic-ai/claude-code",
    ]);

    // 3. Set up the Stop hook (same as SandboxManager.provision)
    await sandbox.runCommand("bash", [
      "-c",
      [
        `mkdir -p ~/.claude`,
        `cat > ~/.claude/commit-guard.sh << 'SCRIPT'`,
        `#!/bin/bash`,
        `input=$(cat)`,
        `if echo "$input" | grep -q '"stop_hook_active":true'; then exit 0; fi`,
        `changes=$(git status --porcelain | grep -v '^.. \\.claude/' | grep -v '^?? \\.claude/' | grep -v 'requirements\\.md')`,
        `if [ -n "$changes" ]; then`,
        `  echo '{"decision":"block","reason":"You have uncommitted changes. You MUST either commit all changes with a descriptive message or revert them before stopping."}' >&2`,
        `  exit 2`,
        `fi`,
        `SCRIPT`,
        `chmod +x ~/.claude/commit-guard.sh`,
        `cat > ~/.claude/settings.json << 'JSON'`,
        `{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash ~/.claude/commit-guard.sh"}]}]}}`,
        `JSON`,
      ].join("\n"),
    ]);

    // 4. Skip onboarding (if using OAuth token)
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      await sandbox.runCommand("bash", [
        "-c",
        `echo '{"hasCompletedOnboarding":true}' > ~/.claude.json`,
      ]);
    }

    // 5. Create an uncommitted file (simulates agent work without committing)
    await sandbox.runCommand("bash", [
      "-c",
      'echo "test content" > test-uncommitted.txt',
    ]);

    // Verify the file is uncommitted
    const beforeStatus = await sandbox.runCommand("git", [
      "status",
      "--porcelain",
    ]);
    const beforeOutput = (await beforeStatus.stdout()).trim();
    expect(beforeOutput).toContain("test-uncommitted.txt");

    // 6. Run Claude Code — the prompt must instruct it to commit any uncommitted changes
    const result = await sandbox.runCommand("bash", [
      "-c",
      'echo "Commit all uncommitted changes with a descriptive commit message, then exit." | claude --print --dangerously-skip-permissions',
    ]);
    const stdout = (await result.stdout()).trim();
    const stderr = (await result.stderr()).trim();

    console.log("Claude stdout:", stdout);
    console.log("Claude stderr:", stderr);

    // 7. Check git status — should be clean if the hook worked
    const afterStatus = await sandbox.runCommand("git", [
      "status",
      "--porcelain",
    ]);
    const afterOutput = (await afterStatus.stdout()).trim();

    expect(afterOutput).toBe("");
  });
});
