import { z } from "zod";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { BlockExecuteFn, BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    commands: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const OUTPUT_TRUNCATE = 2000;

interface RunChecksStepResult {
  results: Array<{ repo: string; command: string; exitCode: number }>;
  failures: Array<{ repo: string; command: string; exitCode: number; output: string }>;
}

async function blockRunChecksCommandsStep(
  sandboxId: string,
  commands: string[],
): Promise<RunChecksStepResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const { parseWorkspaceManifest, WORKSPACE_MANIFEST_PATH } = await import(
    "../../sandbox/repo-workspace.js"
  );

  const sandbox = await Sandbox.get({ sandboxId, ...getSandboxCredentials() });
  const manifestResult = await sandbox.runCommand("cat", [WORKSPACE_MANIFEST_PATH]);
  if (manifestResult.exitCode !== 0) {
    throw new Error(`Workspace manifest not found in sandbox at ${WORKSPACE_MANIFEST_PATH}`);
  }
  const manifest = parseWorkspaceManifest(await manifestResult.stdout());

  const results: RunChecksStepResult["results"] = [];
  const failures: RunChecksStepResult["failures"] = [];
  for (const repo of manifest.repositories) {
    const repoKey = `${repo.provider}:${repo.repoPath}`;
    for (const command of commands) {
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-lc", command],
        cwd: repo.localPath,
      });
      results.push({ repo: repoKey, command, exitCode: result.exitCode });
      if (result.exitCode !== 0) {
        const stdout = (await result.stdout()).trim();
        const stderr = ((await result.stderr?.()) ?? "").trim();
        failures.push({
          repo: repoKey,
          command,
          exitCode: result.exitCode,
          output: [stderr, stdout].filter(Boolean).join("\n").slice(0, OUTPUT_TRUNCATE),
        });
      }
    }
  }
  return { results, failures };
}
blockRunChecksCommandsStep.maxRetries = 0;

async function blockRunChecksConfiguredStep(
  sandboxId: string,
  agentKind: AgentKind,
  model: string,
): Promise<RunChecksStepResult & { summary: string }> {
  "use step";
  const { getDb } = await import("../../db/client.js");
  const { getCurrentPrePrCheckConfig } = await import("../../pre-pr-checks/store.js");
  const { emptyPrePrCheckConfig } = await import("../../pre-pr-checks/config.js");
  const { runPrePrChecksWithFixes } = await import("../../pre-pr-checks/runner.js");

  const current = await getCurrentPrePrCheckConfig(getDb());
  const run = await runPrePrChecksWithFixes(
    sandboxId,
    current?.config ?? emptyPrePrCheckConfig,
    agentKind,
    model,
    0,
  );
  const failures = run.failures.map((failure) => ({
    repo: `${failure.provider}:${failure.repoPath}`,
    command: failure.command,
    exitCode: failure.exitCode,
    output: [failure.stderr, failure.stdout]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, OUTPUT_TRUNCATE),
  }));
  return {
    results: failures.map(({ repo, command, exitCode }) => ({ repo, command, exitCode })),
    failures,
    summary: run.summary,
  };
}
blockRunChecksConfiguredStep.maxRetries = 0;

/**
 * run_checks: report-only check runner. With a commands param it runs each
 * command in every workspace repository; without it it runs the dashboard's
 * pre-PR-checks config once (no fix cycles). Failing checks are a normal
 * branchable outcome: the block returns kind "next" with { status: "ok",
 * ok: false } when checks ran and failed, reserving kind "failed" for
 * infrastructure errors (checks could not run at all).
 */
export const execute: BlockExecuteFn = async (block, _steps, ctx): Promise<BlockExecutionResult> => {
  if (!ctx.sandboxId) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: "no workspace: connect prepare_workspace before run_checks",
    };
  }
  const commands = Array.isArray(block.params.commands)
    ? block.params.commands.filter((c): c is string => typeof c === "string")
    : [];

  try {
    const result =
      commands.length > 0
        ? await blockRunChecksCommandsStep(ctx.sandboxId, commands)
        : await blockRunChecksConfiguredStep(
            ctx.sandboxId,
            ctx.runDefaultKind,
            ctx.defaults[ctx.runDefaultKind],
          );
    return {
      kind: "next",
      output: {
        status: "ok",
        ok: result.failures.length === 0,
        results: result.results,
        failures: result.failures,
      },
    };
  } catch (err) {
    return {
      kind: "failed",
      output: { status: "failed" },
      reason: err instanceof Error ? err.message : String(err),
    };
  }
};
