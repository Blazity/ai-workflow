import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { getSandboxCredentials } from "../sandbox/credentials.js";
import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "../sandbox/repo-workspace.js";
import type { PrePrCheckConfig } from "./config.js";
import type {
  AgentProtocolResult,
  CollectedPhaseArtifacts,
  PhaseArtifactPaths,
  PhaseUsage,
} from "../sandbox/agents/types.js";
import type { TokenPrice } from "../sandbox/agents/pricing.js";
import {
  checkRunBudget,
  recordBudgetUsage,
  type RunBudgetFailure,
  type RunBudgetLimits,
  type RunBudgetState,
} from "../workflows/run-budget.js";

export const MAX_PRE_PR_FIX_CYCLES = 3;

export interface PrePrCheckFailure {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CheckOutcome =
  | "passed"
  | "failed"
  | "skipped"
  | "missing_configuration";

export interface PrePrCheckCommandResult {
  provider: WorkspaceRepo["provider"];
  repoPath: string;
  command: string;
  exitCode: number;
}

export interface PrePrCheckRunResult {
  outcome: Exclude<CheckOutcome, "skipped">;
  passed: boolean;
  fixCycles: number;
  /** One entry per launched fixer; null means the CLI returned no authoritative usage. */
  fixCycleUsages: Array<PhaseUsage | null>;
  budgetFailure: RunBudgetFailure | null;
  /** Every normally started command, in workspace/repository and authored command order. */
  results: PrePrCheckCommandResult[];
  failures: PrePrCheckFailure[];
  summary: string;
  /** Runtime/protocol failure from a launched repair agent. */
  agentFailure?: Extract<AgentProtocolResult<unknown>, { ok: false }>;
}

export interface PrePrFixBudgetContext {
  state: RunBudgetState;
  limits: RunBudgetLimits;
  price: TokenPrice | null;
}

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.create>>;
type SandboxCommandResult = Awaited<ReturnType<SandboxInstance["runCommand"]>>;

type RunCommand = {
  (cmd: string, args: string[]): Promise<SandboxCommandResult>;
  (command: {
    cmd: string;
    args: string[];
    cwd?: string;
    detached?: boolean;
    signal?: AbortSignal;
  }): Promise<SandboxCommandResult>;
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
  timeoutMs?: number,
  budget?: PrePrFixBudgetContext,
): Promise<PrePrCheckRunResult> {
  if (config.repositories.length === 0) {
    return {
      outcome: "missing_configuration",
      passed: true,
      fixCycles: 0,
      fixCycleUsages: [],
      budgetFailure: null,
      results: [],
      failures: [],
      summary: "No pre-PR checks configured.",
    };
  }

  const { Sandbox } = await import("@vercel/sandbox");
  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const signal = timeoutMs === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));

  let result = await runConfiguredPrePrChecks(sandbox, config, 0, signal);
  let fixCycles = 0;
  const fixCycleUsages: Array<PhaseUsage | null> = [];
  let budgetState = budget?.state;

  while (!result.passed && fixCycles < maxFixCycles) {
    fixCycles++;
    const fixer = await runFixAgent(
      sandbox,
      result,
      agentKind,
      model,
      fixCycles,
      signal,
    );
    fixCycleUsages.push(fixer.usage);
    if (fixer.failure) {
      return {
        ...result,
        fixCycles,
        fixCycleUsages,
        budgetFailure: null,
        agentFailure: fixer.failure,
      };
    }
    if (budget && budgetState) {
      budgetState = recordBudgetUsage(budgetState, fixer.usage, budget.price);
      const check = checkRunBudget(budgetState, budget.limits);
      if (check.status !== "ok") {
        return { ...result, fixCycles, fixCycleUsages, budgetFailure: check };
      }
    }
    result = await runConfiguredPrePrChecks(sandbox, config, fixCycles, signal);
  }

  return { ...result, fixCycles, fixCycleUsages, budgetFailure: null };
}

async function runConfiguredPrePrChecks(
  sandbox: SandboxSession,
  config: PrePrCheckConfig,
  fixCycles: number,
  signal?: AbortSignal,
): Promise<PrePrCheckRunResult> {
  const manifest = await readWorkspaceManifest(sandbox);
  const checksByRepo = new Map(
    config.repositories.map((repo) => [repositoryKey(repo), repo.commands]),
  );
  const results: PrePrCheckCommandResult[] = [];
  const failures: PrePrCheckFailure[] = [];
  let ranChecks = 0;

  for (const repo of manifest.repositories) {
    const commands = checksByRepo.get(repositoryKey(repo));
    if (!commands) continue;

    const changed = await hasRepositoryChanged(sandbox, repo, signal);
    if (!changed) continue;

    for (const command of commands) {
      ranChecks++;
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", command],
        cwd: repo.localPath,
        ...(signal ? { signal } : {}),
      });
      results.push({
        provider: repo.provider,
        repoPath: repo.repoPath,
        command,
        exitCode: result.exitCode,
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
    outcome: failures.length > 0 ? "failed" : "passed",
    passed: failures.length === 0,
    fixCycles,
    fixCycleUsages: [],
    budgetFailure: null,
    results,
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
  signal?: AbortSignal,
): Promise<boolean> {
  const headResult = signal
    ? await sandbox.runCommand({
        cmd: "git",
        args: ["-C", repo.localPath, "rev-parse", "HEAD"],
        signal,
      })
    : await sandbox.runCommand("git", ["-C", repo.localPath, "rev-parse", "HEAD"]);
  if (headResult.exitCode !== 0) {
    throw new Error(
      `Could not inspect workspace HEAD for ${repo.provider}:${repo.repoPath}`,
    );
  }

  const headSha = (await headResult.stdout()).trim();
  if (!headSha) {
    throw new Error(
      `Could not inspect workspace HEAD for ${repo.provider}:${repo.repoPath}`,
    );
  }
  return !repo.preAgentSha || repo.preAgentSha !== headSha;
}

async function runFixAgent(
  sandbox: SandboxSession,
  failedRun: PrePrCheckRunResult,
  agentKind: "claude" | "codex",
  model: string,
  fixCycle: number,
  signal?: AbortSignal,
): Promise<{
  usage: PhaseUsage | null;
  failure?: Extract<AgentProtocolResult<unknown>, { ok: false }>;
}> {
  const { createAgentAdapter } = await import("../sandbox/agents/index.js");
  const adapter = createAgentAdapter(agentKind);
  const phase = `pre-pr-fix-${fixCycle}`;
  const paths = adapter.artifactPaths(phase);
  const script = adapter.buildPhaseScript({ phase, model, paths });
  await sandbox.writeFiles([
    {
      path: paths.input,
      content: Buffer.from(buildFixPrompt(failedRun)),
    },
    { path: paths.wrapper, content: Buffer.from(script) },
  ]);
  const chmod = await sandbox.runCommand("chmod", ["+x", paths.wrapper]);
  if (chmod.exitCode !== 0) {
    const { protocolFailure } = await import("../sandbox/agents/protocol.js");
    const artifacts = await collectPhaseFromSandbox(sandbox, paths);
    const failure = protocolFailure({
      spec: adapter.cliSpec,
      phase,
      artifacts,
      failureKind: "setup_failed",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: "The Pre-PR repair wrapper could not be made executable.",
    });
    if (failure.ok) throw new Error("unreachable");
    return { usage: null, failure };
  }
  let launch: SandboxCommandResult;
  try {
    launch = await sandbox.runCommand({
      cmd: "bash",
      args: [paths.wrapper],
      cwd: "/vercel/sandbox",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (
      error instanceof DOMException ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw error;
    }
    const { protocolFailure } = await import("../sandbox/agents/protocol.js");
    const failure = protocolFailure({
      spec: adapter.cliSpec,
      phase,
      artifacts: { stdout: "", stderr: "", structuredOutput: null, exitCode: null },
      failureKind: "provider_error",
      category: "provider",
      message: "The current agent phase could not be completed.",
      detail: "The Pre-PR repair process could not be launched.",
    });
    if (failure.ok) throw new Error("unreachable");
    return { usage: null, failure };
  }
  if (launch.exitCode !== 0) {
    const { commandProtocolFailure } = await import("../sandbox/agents/protocol.js");
    return {
      usage: null,
      failure: await commandProtocolFailure({
        spec: adapter.cliSpec,
        phase,
        result: launch,
        failureKind: "cli_exit",
        message: "The current agent phase could not be completed.",
        detail: "The Pre-PR repair process could not be launched.",
      }),
    };
  }
  const artifacts = await collectPhaseFromSandbox(sandbox, paths);
  const usage = adapter.extractUsage(artifacts.stdout, artifacts.structuredOutput);
  const protocol = adapter.validateFreeformProtocol(artifacts, phase);
  return protocol.ok ? { usage } : { usage, failure: protocol };
}

async function collectPhaseFromSandbox(
  sandbox: SandboxSession,
  paths: PhaseArtifactPaths,
): Promise<CollectedPhaseArtifacts> {
  const read = async (path: string): Promise<string> => {
    const result = await sandbox.runCommand("cat", [path]);
    return result.exitCode === 0 ? (await result.stdout()).trim() : "";
  };
  const stdout = await read(paths.stdout);
  const stderr = await read(paths.stderr);
  const structuredOutput = paths.structuredOutput
    ? (await read(paths.structuredOutput)) || null
    : null;
  const exitCodeText = await read(paths.exitCode);
  return {
    stdout,
    stderr,
    structuredOutput,
    exitCode: /^-?\d+$/.test(exitCodeText) ? Number(exitCodeText) : null,
  };
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
