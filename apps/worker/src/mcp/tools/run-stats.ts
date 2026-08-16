import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { CostResponse, RunStatus } from "@shared/contracts";

import { env } from "../../../env.js";
import { costAgg, listRuns, type TimeWindow } from "../../db/queries/runs-read.js";
import { isTerminalRunStatus, type McpToolDependencies } from "../contracts.js";
import { executeMcpRead } from "../execute-tool.js";
import { registerCatalogTool } from "../tool-catalog.js";

// Mirrors the dashboard's own default (parseWindow's fallback, db/queries/
// runs-read.ts:45-49): a caller that sends no window sees the same "last 24h"
// slice the cost view opens on.
const DEFAULT_RUNS_STATS_WINDOW: TimeWindow = "24h";
const DEFAULT_RUNS_STATS_LIMIT = 20;

type RunOutcome = {
  runId: string;
  workflowName: string;
  status: RunStatus;
  terminal: boolean;
  ticketKey: string | null;
  /** Minutes since the run's effective start (startedAt, falling back to
   *  firstSeenAt), computed against this call's own clock -- there is no
   *  absolute timestamp cheaper to hand back, and the dashboard's own recent-
   *  runs list reports the same relative figure for the same reason. */
  startedAtMin: number;
  durationSec: number | null;
  costUsd: number | null;
};

type RunsStatsData = {
  runs: RunOutcome[];
  /** True when the window holds more runs than were returned; runKpis has no
   *  narrower page to page through, so a caller wanting the rest narrows the
   *  window instead. */
  runsTruncated: boolean;
  /** The same totals, per-workflow breakdown and daily series the dashboard's
   *  cost view reads (db/queries/runs-read.ts costAgg), computed from
   *  persisted per-run cost rather than a live provider call. */
  cost: Omit<CostResponse, "generatedAt" | "available">;
};

export function registerRunStatsTools(server: McpServer, deps: McpToolDependencies): void {
  registerCatalogTool(
    server,
    "runs.stats",
    async (input) => {
      const envelope = await executeMcpRead({
        deps,
        toolName: "runs.stats",
        targetRefs: [],
        operation: async (): Promise<RunsStatsData> => {
          const window = input.window ?? DEFAULT_RUNS_STATS_WINDOW;
          const limit = input.limit ?? DEFAULT_RUNS_STATS_LIMIT;
          const now = deps.now();
          const [runsResult, cost] = await Promise.all([
            listRuns({
              db: deps.db,
              window,
              q: null,
              now,
              jiraBaseUrl: env.JIRA_BASE_URL,
              limit,
            }),
            costAgg({ db: deps.db, window, now }),
          ]);
          return {
            runs: runsResult.rows.map((run) => ({
              runId: run.id,
              workflowName: run.workflowName,
              status: run.status,
              terminal: isTerminalRunStatus(run.status),
              ticketKey: run.ticket ? run.ticket : null,
              startedAtMin: run.startedAtMin,
              durationSec: run.duration,
              costUsd: run.cost,
            })),
            runsTruncated: runsResult.rows.length < runsResult.total,
            cost,
          };
        },
      });
      // No trust override: workflowName and ticketKey are the same somebody-
      // else's text runs.get and workflows.list already answer as untrusted.
      return {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    },
  );
}
