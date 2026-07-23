import { z } from "zod";
import type { AgentKind } from "../../sandbox/agents/index.js";
import type { CheckOutcome } from "../../pre-pr-checks/runner.js";
import {
  RunBudgetError,
  durationBudgetFailure,
  isDurationAbortError,
} from "../run-budget.js";
import { isRunControlError } from "../run-control-error.js";
import {
  invalidateWorkspaceGate,
  recordSuccessfulWorkspaceGate,
} from "../workspace-gate.js";
import { executionError, type BlockExecuteFn, type BlockExecutionResult } from "./types.js";

export const paramsSchema = z
  .object({
    commands: z.array(z.string().trim().min(1)).optional(),
    skipReason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.skipReason && (value.commands?.length ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skipReason"],
        message: "Skip reason cannot be combined with commands.",
      });
    }
  });

const OUTPUT_TRUNCATE = 2000;

interface RunChecksStepResult {
  outcome: Exclude<CheckOutcome, "skipped" | "missing_configuration">;
  results: Array<{ repo: string; command: string; exitCode: number }>;
  failures: Array<{ repo: string; command: string; exitCode: number; output: string }>;
}

async function blockRunChecksCommandsStep(
  sandboxId: string,
  commands: string[],
  timeoutMs: number,
): Promise<RunChecksStepResult> {
  "use step";
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
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
        signal,
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
  return {
    outcome: failures.length > 0 ? "failed" : "passed",
    results,
    failures,
  };
}
blockRunChecksCommandsStep.maxRetries = 0;

async function blockRunChecksConfiguredStep(
  sandboxId: string,
  agentKind: AgentKind,
  model: string,
  timeoutMs: number,
): Promise<
  Omit<RunChecksStepResult, "outcome"> & {
    outcome: Exclude<CheckOutcome, "skipped">;
    configurationVersion: number | null;
    summary: string;
  }
> {
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
    timeoutMs,
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
  const results = (run.results ?? run.failures).map((result) => ({
    repo: `${result.provider}:${result.repoPath}`,
    command: result.command,
    exitCode: result.exitCode,
  }));
  const outcome =
    run.outcome ??
    (current === null || current.config.repositories.length === 0
      ? "missing_configuration"
      : run.passed
        ? "passed"
        : "failed");
  return {
    outcome,
    configurationVersion: current?.version ?? null,
    results,
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
 * ok: false } when checks ran and failed, reserving kind "execution_error" for
 * infrastructure errors (checks could not run at all).
 */
export const execute: BlockExecuteFn = async (block, _steps, ctx): Promise<BlockExecutionResult> => {
  const skipReason =
    typeof block.params.skipReason === "string" ? block.params.skipReason.trim() : "";
  if (skipReason) {
    return {
      kind: "next",
      output: {
        status: "ok",
        ok: true,
        outcome: "skipped",
        skipReason,
        results: [],
        failures: [],
      },
    };
  }
  if (!ctx.sandboxId) {
    return executionError(
      "no workspace: connect prepare_workspace before run_checks",
      { category: "sandbox" },
    );
  }
  invalidateWorkspaceGate(ctx);
  const commands = Array.isArray(block.params.commands)
    ? block.params.commands.filter((c): c is string => typeof c === "string")
    : [];
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
  const timeoutMs = Math.max(1, Math.floor(budget.remainingDurationMs));

  try {
    const result =
      commands.length > 0
        ? await blockRunChecksCommandsStep(ctx.sandboxId, commands, timeoutMs)
        : await blockRunChecksConfiguredStep(
            ctx.sandboxId,
            ctx.runDefaultKind,
            ctx.defaults[ctx.runDefaultKind],
            timeoutMs,
          );
    if (
      "configurationVersion" in result &&
      result.outcome === "passed" &&
      result.configurationVersion !== null &&
      ctx.workspaceManifest
    ) {
      ctx.prePrGate = await recordSuccessfulWorkspaceGate({
        sandboxId: ctx.sandboxId,
        workspaceManifest: ctx.workspaceManifest,
        configurationVersion: result.configurationVersion,
      });
    }
    return {
      kind: "next",
      output: {
        status: "ok",
        // Preserve the v1 Boolean contract: missing configuration was
        // historically a no-op, while the typed outcome makes it visible to v2.
        ok: result.outcome !== "failed",
        outcome: result.outcome,
        results: result.results,
        failures: result.failures,
      },
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const after = await ctx.observeBudget();
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    if (isDurationAbortError(err)) {
      throw new RunBudgetError(durationBudgetFailure(after, "Run checks"));
    }
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "checks",
    });
  }
};
