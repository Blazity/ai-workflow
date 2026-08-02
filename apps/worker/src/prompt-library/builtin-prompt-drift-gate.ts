import { fileURLToPath } from "node:url";
import type { Db } from "../db/client.js";
import {
  describeBuiltInPromptDrift,
  findBuiltInPromptDrift,
  type BuiltInPromptDriftReport,
  type FindBuiltInPromptDriftOptions,
} from "./builtin-prompt-drift.js";

/**
 * The caller for the built-in prompt drift report.
 *
 * findBuiltInPromptDrift only describes; this decides. It exists because a
 * report nobody reads is the same as no report: the defect it was written for
 * (0034 and 0036 silently correcting a row no run resolved) survived precisely
 * because nothing ever compared what a run resolves against what the code
 * ships.
 *
 * Two callers use this gate, and they catch different things:
 *
 *   1. The test suite (builtin-prompt-drift-gate.test.ts), which runs it against
 *      a database built from the committed migrations. In CI there is no
 *      production data, so it CANNOT see a row inserted out of band, which is
 *      exactly how production got `implement@2`. What it does catch, and what
 *      nothing caught before, is a code constant edited without a matching
 *      resync migration: the seeded and fresh-install shapes then stop matching
 *      DEFAULT_AGENT_PROMPTS and the suite goes red on the offending commit.
 *
 *   2. `runBuiltInPromptDriftGate` as a command against a real DATABASE_URL,
 *      which is the half that sees production rows. Run it after deploying a
 *      release that changes any built-in prompt:
 *
 *        pnpm exec tsx src/prompt-library/builtin-prompt-drift-gate.ts
 *
 * The gate fails on four conditions, not one. Gating on `drift` alone would
 * pass a prompt no migration can repair (`unfixableDrift`), a walk that could
 * not read part of the graph (`skipped`), and a walk that inspected nothing at
 * all (`pins` empty). The last is the important one: an empty result is the
 * failure mode a check like this dies of, and it looks identical to success.
 */

export type BuiltInPromptDriftGateFailureCode =
  | "drift"
  | "unfixable_drift"
  | "incomplete_walk"
  | "nothing_inspected";

export interface BuiltInPromptDriftGateFailure {
  code: BuiltInPromptDriftGateFailureCode;
  detail: string;
}

export interface BuiltInPromptDriftGateResult {
  ok: boolean;
  failures: BuiltInPromptDriftGateFailure[];
  report: BuiltInPromptDriftReport;
  /** Operator-facing summary: the failures, then the report's own detail. */
  message: string;
}

export function evaluateBuiltInPromptDriftGate(
  report: BuiltInPromptDriftReport,
): BuiltInPromptDriftGateResult {
  const failures: BuiltInPromptDriftGateFailure[] = [];

  if (report.drift.length > 0) {
    failures.push({
      code: "drift",
      detail:
        `${report.drift.length} platform prompt version(s) a run can still resolve ` +
        `no longer match DEFAULT_AGENT_PROMPTS. A resync migration will correct these.`,
    });
  }
  if (report.unfixableDrift.length > 0) {
    failures.push({
      code: "unfixable_drift",
      detail:
        `${report.unfixableDrift.length} platform prompt version(s) drifted under a prompt row ` +
        `no resync migration will touch (archived, or not platform-owned). Code alone cannot fix these.`,
    });
  }
  if (report.skipped.length > 0) {
    failures.push({
      code: "incomplete_walk",
      detail:
        `${report.skipped.length} definition snapshot(s) or block(s) could not be read, so the ` +
        `report is incomplete and a clean drift list proves nothing.`,
    });
  }
  if (report.pins.length === 0) {
    failures.push({
      code: "nothing_inspected",
      detail:
        `No built-in prompt reference was reached at all (definitionsWalked=${report.definitionsWalked}). ` +
        `An empty report is not a clean one: the walk found nothing to check.`,
    });
  }

  const detail = describeBuiltInPromptDrift(report);
  return {
    ok: failures.length === 0,
    failures,
    report,
    message:
      failures.length === 0
        ? `Built-in prompt drift gate passed: ${report.pins.length} reference(s) across ` +
          `${report.definitionsWalked} definition snapshot(s) match the shipped constants.`
        : [
            "Built-in prompt drift gate FAILED.",
            ...failures.map((failure) => `  [${failure.code}] ${failure.detail}`),
            ...(detail === "" ? [] : ["", detail]),
          ].join("\n"),
  };
}

export class BuiltInPromptDriftError extends Error {
  constructor(readonly result: BuiltInPromptDriftGateResult) {
    super(result.message);
    this.name = "BuiltInPromptDriftError";
  }
}

/** Throws BuiltInPromptDriftError unless every gate condition passes. */
export async function assertNoBuiltInPromptDrift(
  db: Db,
  options: FindBuiltInPromptDriftOptions = {},
): Promise<BuiltInPromptDriftGateResult> {
  const result = evaluateBuiltInPromptDriftGate(
    await findBuiltInPromptDrift(db, options),
  );
  if (!result.ok) throw new BuiltInPromptDriftError(result);
  return result;
}

/** Command entry point. Resolves the database lazily so importing this module
 *  never requires DATABASE_URL to be set. */
export async function runBuiltInPromptDriftGate(): Promise<number> {
  const { getDb } = await import("../db/client.js");
  const result = evaluateBuiltInPromptDriftGate(
    await findBuiltInPromptDrift(getDb()),
  );
  console.log(result.message);
  return result.ok ? 0 : 1;
}

// Only when executed directly, never on import.
if (
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runBuiltInPromptDriftGate();
}
