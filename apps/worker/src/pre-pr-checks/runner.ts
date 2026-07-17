import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "../sandbox/credentials.js";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "../sandbox/repo-workspace.js";
import type { PrePrCheckConfig } from "./config.js";

export const MAX_PRE_PR_FIX_CYCLES = 3;

export interface PrePrCheckFailure {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PrePrCheckRunResult {
  passed: boolean;
  fixCycles: number;
  failures: PrePrCheckFailure[];
  summary: string;
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;
type SandboxCommandResult = Awaited<ReturnType<SandboxInstance["runCommand"]>>;

type RunCommand = {
  (cmd: string, args: string[]): Promise<SandboxCommandResult>;
  (command: { cmd: string; args: string[]; cwd?: string; detached?: boolean }): Promise<SandboxCommandResult>;
};

interface SandboxSession {
  runCommand: RunCommand;
  writeFiles: (files: Array<{ path: string; content: Buffer }>) => Promise<unknown>;
}

export async function runPrePrChecksWithFixes(
  sandboxId: string,
  config: PrePrCheckConfig,
  agentKind: "claude" | "codex",
  model: string,
  maxFixCycles: number = MAX_PRE_PR_FIX_CYCLES,
): Promise<PrePrCheckRunResult> {
  if (config.repositories.length === 0) {
    return {
      passed: true,
      fixCycles: 0,
      failures: [],
      summary: "No pre-PR checks configured.",
    };
  }

  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });

  let result = await runConfiguredPrePrChecks(sandbox, config, 0);
  let fixCycles = 0;

  while (!result.passed && fixCycles < maxFixCycles) {
    fixCycles++;
    await runFixAgent(sandbox, result, agentKind, model);
    result = await runConfiguredPrePrChecks(sandbox, config, fixCycles);
  }

  return { ...result, fixCycles };
}

async function runConfiguredPrePrChecks(
  sandbox: SandboxSession,
  config: PrePrCheckConfig,
  fixCycles: number,
): Promise<PrePrCheckRunResult> {
  const manifest = await readWorkspaceManifest(sandbox);
  const checksByRepo = new Map(
    config.repositories.map((repo) => [repositoryKey(repo), repo.commands]),
  );
  const failures: PrePrCheckFailure[] = [];
  let ranChecks = 0;

  for (const repo of manifest.repositories) {
    const commands = checksByRepo.get(repositoryKey(repo));
    if (!commands) continue;

    const changed = await hasRepositoryChanged(sandbox, repo, failures);
    if (!changed) continue;

    for (const command of commands) {
      ranChecks++;
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", command],
        cwd: repo.localPath,
      });
      if (result.exitCode !== 0) {
        failures.push({
          provider: repo.provider,
          repoPath: repo.repoPath,
          command,
          exitCode: result.exitCode,
          stdout: await commandStdout(result),
          stderr: await commandStderr(result),
        });
      }
    }
  }

  return {
    passed: failures.length === 0,
    fixCycles,
    failures,
    summary: failures.length > 0
      ? formatPrePrCheckFailures(failures)
      : ranChecks === 0
        ? "No pre-PR checks matched changed repositories."
        : `Pre-PR checks passed (${ranChecks} command${ranChecks === 1 ? "" : "s"}).`,
  };
}

async function readWorkspaceManifest(sandbox: SandboxSession): Promise<WorkspaceManifest> {
  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    throw new Error(`Workspace manifest not found in sandbox at ${WORKSPACE_MANIFEST_PATH}`);
  }
  return parseWorkspaceManifest(await manifestResult.stdout());
}

async function hasRepositoryChanged(
  sandbox: SandboxSession,
  repo: WorkspaceRepo,
  failures: PrePrCheckFailure[],
): Promise<boolean> {
  const headResult = await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
  if (headResult.exitCode !== 0) {
    failures.push({
      provider: repo.provider,
      repoPath: repo.repoPath,
      command: "git rev-parse HEAD",
      exitCode: headResult.exitCode,
      stdout: await commandStdout(headResult),
      stderr: await commandStderr(headResult),
    });
    return false;
  }

  const headSha = (await headResult.stdout()).trim();
  return !repo.preAgentSha || repo.preAgentSha !== headSha;
}

async function runFixAgent(
  sandbox: SandboxSession,
  failedRun: PrePrCheckRunResult,
  agentKind: "claude" | "codex",
  model: string,
): Promise<void> {
  const { logger } = await import("../lib/logger.js");
  await sandbox.writeFiles([
    {
      path: "/tmp/pre-pr-checks-fix-prompt.txt",
      content: Buffer.from(buildFixPrompt(failedRun)),
    },
  ]);

  const cli =
    agentKind === "codex"
      ? `codex exec --model "${model}" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json -`
      : `claude --print --model '${model}' --dangerously-skip-permissions`;

  await sandbox.runCommand("bash", [
    "-c",
    `cd /vercel/sandbox || exit 1; if [ -f /tmp/agent-env.sh ]; then source /tmp/agent-env.sh; fi; cat /tmp/pre-pr-checks-fix-prompt.txt | ${cli} > /tmp/pre-pr-checks-fix-stdout.txt 2>/tmp/pre-pr-checks-fix-stderr.txt || true`,
  ]);

  const fixOut = await sandbox.runCommand("cat", ["/tmp/pre-pr-checks-fix-stdout.txt"]);
  const fixLog = (await fixOut.stdout()).trim();
  if (fixLog) {
    logger.info({ output: fixLog.slice(0, 500) }, "pre_pr_checks_fix_agent_output");
  }
}

function buildFixPrompt(failedRun: PrePrCheckRunResult): string {
  return `Pre-PR checks failed for the Run Workspace.

Fix the issues, commit your fixes, and do not push or create pull requests.

${failedRun.summary}`;
}

function formatPrePrCheckFailures(failures: PrePrCheckFailure[]): string {
  return failures
    .map((failure) => {
      const output = [failure.stderr, failure.stdout]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 2_000);
      return [
        `${failure.provider}:${failure.repoPath}`,
        `Command: ${failure.command}`,
        `Exit code: ${failure.exitCode}`,
        output ? `Output:\n${output}` : "Output: (empty)",
      ].join("\n");
    })
    .join("\n\n");
}

function repositoryKey(repo: Pick<WorkspaceRepo, "provider" | "repoPath">): string {
  return `${repo.provider}:${repo.repoPath}`;
}

async function commandStdout(result: SandboxCommandResult): Promise<string> {
  return (await result.stdout()).trim();
}

async function commandStderr(result: SandboxCommandResult): Promise<string> {
  return ((await result.stderr?.()) ?? "").trim();
}
