/**
 * The four headline run numbers the overview screen opens with.
 *
 * As with the cost aggregate: the window is resolved and the connection bound
 * here, and the caller decides what an unreachable database looks like.
 */
import type { KpisResponse } from "@shared/contracts";
import { collectConnectedRunKpis } from "../../engine/overview-aggregates.js";

/** The KPI aggregate for the window the raw query value selects. */
export function collectRunKpis(
  windowParam: unknown,
  now: Date,
): Promise<Omit<KpisResponse, "generatedAt">> {
  return collectConnectedRunKpis(windowParam, now);
}
