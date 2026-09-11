/**
 * Fleet eval health, including the two answers that are not an aggregate.
 *
 * Whether this deployment can ask Arthur at all is a deployment setting, and
 * whether anything was graded in the window is a fact about the window, so both
 * are decided here and returned as cases. The caller turns each case into its
 * wire reason, and an Arthur call that throws stays thrown: the route degrades
 * it the way it always did.
 */
import { ArthurClient } from "../../sandbox/arthur-client.js";
import { evaluationTraceSettings } from "../settings/index.js";
import { collectEvals, type EvalsAggregate } from "./collect-evals.js";

/** The window the eval screen reports, fixed rather than client-selected. */
export const EVAL_WINDOW_HOURS = 24;

export type EvalSummary =
  | { kind: "not_configured" }
  | { kind: "nothing_graded" }
  | ({ kind: "graded" } & EvalsAggregate);

/** Fleet eval health over the fixed window, or the reason there is none. */
export async function collectEvalSummary(now: Date): Promise<EvalSummary> {
  const { apiKey, endpoint } = evaluationTraceSettings();
  if (!apiKey || !endpoint) {
    return { kind: "not_configured" };
  }

  const aggregate = await collectEvals({
    client: ArthurClient.fromTraceEndpoint(endpoint, apiKey),
    windowHours: EVAL_WINDOW_HOURS,
    now,
  });
  if (aggregate.spansGraded === 0) {
    return { kind: "nothing_graded" };
  }
  return { kind: "graded", ...aggregate };
}
