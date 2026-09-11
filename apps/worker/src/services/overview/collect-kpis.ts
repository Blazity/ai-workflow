/**
 * The four headline run numbers the overview screen opens with.
 *
 * As with the cost aggregate: the window is resolved and the connection bound
 * here, and the caller decides what an unreachable database looks like.
 */
import type { KpisResponse } from "@shared/contracts";
import { getDb } from "../../db/client.js";
import { parseWindow, runKpis } from "../../db/queries/runs-read.js";

/** The KPI aggregate for the window the raw query value selects. */
export function collectRunKpis(
  windowParam: unknown,
  now: Date,
): Promise<Omit<KpisResponse, "generatedAt">> {
  return runKpis({ db: getDb(), window: parseWindow(windowParam), now });
}
