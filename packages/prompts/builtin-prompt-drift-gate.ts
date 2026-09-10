import {
  describeBuiltInPromptDrift,
  type BuiltInPromptDriftReport,
} from "./builtin-prompt-drift";

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
