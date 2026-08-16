import { fileURLToPath } from "node:url";
import type { Db } from "../db/client.js";
import {
  describeCarrySchemaDrift,
  findCarrySchemaDrift,
  type CarrySchemaDriftReport,
  type FindCarrySchemaDriftOptions,
} from "./carry-schema-drift.js";

/**
 * The caller for the embedded-schema drift report.
 *
 * findCarrySchemaDrift only describes; this decides. Two callers use it:
 *
 *   1. The test suite (carry-schema-drift.test.ts), run against a database built
 *      from the committed migrations. It catches a code constant changed shape
 *      without a matching resync migration: a fixture carrying the prior shape
 *      then reports drift and the suite goes red on the offending commit.
 *
 *   2. `runCarrySchemaDriftGate` as a command against a real DATABASE_URL, the
 *      half that sees production rows. Run it after deploying a release that
 *      changes any code-owned schema embedded by value in a template:
 *
 *        pnpm exec tsx src/workflow-definition/carry-schema-drift-gate.ts
 *
 * The gate fails on three conditions. Gating on `drift` alone would pass a walk
 * that could not read part of the graph (`skipped`) and a walk that reached no
 * snapshot at all (`definitionsWalked === 0`). The last is the important one: an
 * empty result is the failure mode a check like this dies of, and it looks
 * identical to success.
 *
 * `customerDivergent` and `unrecognizedOutputSchemas` are reported but never
 * fail the gate: a customer's own carry schema and a template-local outputSchema
 * are both legitimately not the platform's, and a resync must leave them alone.
 */

export type CarrySchemaDriftGateFailureCode =
  | "drift"
  | "incomplete_walk"
  | "nothing_inspected";

export interface CarrySchemaDriftGateFailure {
  code: CarrySchemaDriftGateFailureCode;
  detail: string;
}

export interface CarrySchemaDriftGateResult {
  ok: boolean;
  failures: CarrySchemaDriftGateFailure[];
  report: CarrySchemaDriftReport;
  message: string;
}

export function evaluateCarrySchemaDriftGate(
  report: CarrySchemaDriftReport,
): CarrySchemaDriftGateResult {
  const failures: CarrySchemaDriftGateFailure[] = [];

  if (report.drift.length > 0) {
    failures.push({
      code: "drift",
      detail:
        `${report.drift.length} embedded schema(s) a dispatch can still select match a ` +
        `prior platform shape, not the current constant. A resync migration will correct these.`,
    });
  }
  if (report.skipped.length > 0) {
    failures.push({
      code: "incomplete_walk",
      detail:
        `${report.skipped.length} definition snapshot(s) or node(s) could not be read, so the ` +
        `report is incomplete and a clean drift list proves nothing.`,
    });
  }
  if (report.definitionsWalked === 0) {
    failures.push({
      code: "nothing_inspected",
      detail:
        `No definition snapshot was read at all (definitionsWalked=0). An empty report is ` +
        `not a clean one: the walk reached nothing to check.`,
    });
  }

  const detail = describeCarrySchemaDrift(report);
  return {
    ok: failures.length === 0,
    failures,
    report,
    message:
      failures.length === 0
        ? `Carry schema drift gate passed: ${report.embeds.length} embedded schema(s) across ` +
          `${report.definitionsWalked} definition snapshot(s), ${report.customerDivergent.length} ` +
          `customer schema(s) left untouched.`
        : [
            "Carry schema drift gate FAILED.",
            ...failures.map((failure) => `  [${failure.code}] ${failure.detail}`),
            ...(detail === "" ? [] : ["", detail]),
          ].join("\n"),
  };
}

export class CarrySchemaDriftError extends Error {
  constructor(readonly result: CarrySchemaDriftGateResult) {
    super(result.message);
    this.name = "CarrySchemaDriftError";
  }
}

/** Throws CarrySchemaDriftError unless every gate condition passes. */
export async function assertNoCarrySchemaDrift(
  db: Db,
  options: FindCarrySchemaDriftOptions = {},
): Promise<CarrySchemaDriftGateResult> {
  const result = evaluateCarrySchemaDriftGate(
    await findCarrySchemaDrift(db, options),
  );
  if (!result.ok) throw new CarrySchemaDriftError(result);
  return result;
}

/** Command entry point. Resolves the database lazily so importing this module
 *  never requires DATABASE_URL to be set. */
export async function runCarrySchemaDriftGate(): Promise<number> {
  const { getDb } = await import("../db/client.js");
  const result = evaluateCarrySchemaDriftGate(
    await findCarrySchemaDrift(getDb()),
  );
  console.log(result.message);
  return result.ok ? 0 : 1;
}

// Only when executed directly, never on import.
if (
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCarrySchemaDriftGate();
}
