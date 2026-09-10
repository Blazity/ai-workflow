/**
 * Fleet token spend over a dashboard window.
 *
 * The aggregation itself lives in the read queries; this decides what a cost
 * request means: which window a raw query value selects, and which connection
 * the aggregate is read on. The caller keeps the decision about what an
 * unreachable database becomes on the wire.
 */
import type { CostResponse } from "@shared/contracts";
import { getDb } from "../../db/client.js";
import { costAgg, parseWindow } from "../../db/queries/runs-read.js";

/** The spend aggregate for the window the raw query value selects. */
export function collectCostAggregate(
  windowParam: unknown,
  now: Date,
): Promise<Omit<CostResponse, "generatedAt" | "available">> {
  return costAgg({ db: getDb(), window: parseWindow(windowParam), now });
}
