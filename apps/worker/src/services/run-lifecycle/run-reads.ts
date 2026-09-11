/**
 * What the dashboard reads about runs: the list, the per-workflow aggregate,
 * the live board and the per-block statuses.
 *
 * The queries below take a connection and answer about rows; this decides what
 * a dashboard request for them means, including the one thing every card here
 * shares: an unreachable database degrades to the documented N/A view instead
 * of failing the request, because a broken database must not blank the page
 * with an error the operator cannot act on.
 */
import type {
  LiveRunsResponse,
  RunBlockStatusesResponse,
  RunsResponse,
  WorkflowsResponse,
} from "@shared/contracts";
import { getDb } from "../../db/client.js";
import {
  fetchRunModels,
  listRuns,
  parseSearch,
  parseWindow,
  workflowAgg,
} from "../../db/repositories/runs.js";
import { logger } from "../../infra/logger.js";
import {
  collectAwaitingRuns,
  collectBlockStatuses,
  collectLiveRuns,
  getWorkflowRegistry,
  registryRows,
} from "../overview/index.js";
import { issueTrackerBaseUrl } from "../settings/index.js";
import { createAdapters } from "../../engine/support/adapters.js";

/** The runs list as the wire carries it, minus the timestamp the route stamps. */
export type DashboardRunsPage = Omit<RunsResponse, "generatedAt">;

const EMPTY_RUNS: DashboardRunsPage = {
  available: false,
  rows: [],
  total: 0,
  counts: { success: 0, running: 0, awaiting: 0, failed: 0, blocked: 0 },
};

/**
 * Filtering is parameterized SQL inside the worker: the window is whitelisted
 * to an enum and the search is a bound, wildcard-escaped ILIKE. The dashboard
 * sends typed intent only, never SQL, so the raw query values arrive here
 * unparsed and are narrowed before they reach a statement.
 */
export async function listDashboardRuns(query: {
  window?: unknown;
  q?: unknown;
}): Promise<DashboardRunsPage> {
  try {
    const { rows, total, counts } = await listRuns({
      db: getDb(),
      window: parseWindow(query.window),
      q: parseSearch(query.q),
      now: new Date(),
      jiraBaseUrl: issueTrackerBaseUrl(),
    });
    return { available: true, rows, total, counts };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "runs_list_failed");
    return EMPTY_RUNS;
  }
}

/**
 * The per-workflow aggregate. The fallback is the static registry with null
 * metrics rather than the empty state, so the card still lists the workflows
 * that exist when only their numbers are unreadable.
 */
export async function listWorkflowAggregates(query: {
  window?: unknown;
}): Promise<Omit<WorkflowsResponse, "generatedAt">> {
  try {
    const { rows, total } = await workflowAgg({
      db: getDb(),
      window: parseWindow(query.window),
      now: new Date(),
      jiraBaseUrl: issueTrackerBaseUrl(),
      registry: getWorkflowRegistry(),
    });
    return { rows, total };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "workflows_collect_failed");
    return registryRows();
  }
}

/**
 * The live board: running runs from the registry plus the store-backed awaiting
 * rows.
 *
 * A parked run keeps its run-registry entry, so collectLiveRuns still reports
 * it "running". The store-backed awaiting row (same real run id, with the
 * question payload) is the truth, so drop the running duplicate: an orphaned
 * registry entry must not mask a parked run.
 */
export async function listLiveRuns(): Promise<LiveRunsResponse> {
  const adapters = createAdapters();
  const now = new Date();
  const jiraBaseUrl = issueTrackerBaseUrl();
  const [running, awaiting] = await Promise.all([
    collectLiveRuns({
      registry: adapters.runRegistry,
      issueTracker: adapters.issueTracker,
      jiraBaseUrl,
      resolveModels: (runIds) => fetchRunModels(getDb(), runIds),
    }),
    collectAwaitingRuns({ db: getDb(), jiraBaseUrl, now }),
  ]);

  const awaitingIds = new Set(awaiting.map((r) => r.id));
  const runningOnly = running.filter((r) => !awaitingIds.has(r.id));
  return { generatedAt: now.toISOString(), rows: [...runningOnly, ...awaiting] };
}

/**
 * Per-block statuses, optionally narrowed to one definition. A definitionId
 * that is not a positive integer names no definition, so it narrows nothing.
 */
export function readRunBlockStatuses(query: {
  definitionId?: unknown;
}): Promise<RunBlockStatusesResponse["run"]> {
  const parsed = Number(query.definitionId);
  const definitionId = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  return collectBlockStatuses({
    registry: createAdapters().runRegistry,
    db: getDb(),
    definitionId,
  });
}
